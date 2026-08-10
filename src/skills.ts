import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export type Skill = {
  /** Frontmatter `name`. Unique within a session; used to activate the skill. */
  name: string;
  /** Frontmatter `description`. The only thing the model matches against. */
  description: string;
  /** The Markdown body. Tier 2 — withheld until the model activates the skill. */
  body: string;
  /** Absolute path to the skill directory. Bundled resources resolve against it. */
  dir: string;
  /** Absolute path to the SKILL.md file itself. */
  path: string;
};

/** A non-fatal problem. Collected and surfaced under `--verbose`, never thrown. */
export type Warning = { path: string; message: string };

export type Discovery = { skills: Skill[]; warnings: Warning[] };

/** Spec constraints on `name`: lowercase alphanumerics and single hyphens, no leading, trailing or consecutive hyphens. */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

/** A skill's own resource folders never contain further skills. Don't descend. */
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "scripts", "references", "assets"]);
const MAX_SCAN_DEPTH = 3;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Splits a SKILL.md into its YAML frontmatter and Markdown body. */
export function splitFrontmatter(raw: string): { yaml: string; body: string } | null {
  const text = raw.replace(/^\uFEFF/, ""); // strip a UTF-8 byte-order mark
  const fence = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!fence) return null;
  return { yaml: fence[1] ?? "", body: text.slice(fence[0].length).trim() };
}

/** Quotes unquoted YAML values that contain a colon. */
function quoteValuesContainingColons(yaml: string): string {
  return yaml
    .split("\n")
    .map((line) => {
      const pair = /^([A-Za-z0-9_-]+):[ \t]+(.*)$/.exec(line);
      if (!pair) return line;
      const [, key, value = ""] = pair;
      const trimmed = value.trim();
      if (!/:(\s|$)/.test(trimmed)) return line; // no colon, already valid
      if (/^["'|>]/.test(trimmed)) return line; // already quoted or a block scalar
      return `${key}: "${trimmed.replace(/"/g, '\\"')}"`;
    })
    .join("\n");
}

type YamlResult = { data: Record<string, unknown> | null; recovered: boolean };

function parseYamlLeniently(yaml: string): YamlResult {
  const attempt = (text: string): Record<string, unknown> | null => {
    const parsed: unknown = parseYaml(text);
    if (parsed === null || parsed === undefined) return {};
    return typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  };

  try {
    return { data: attempt(yaml), recovered: false };
  } catch {
    try {
      return { data: attempt(quoteValuesContainingColons(yaml)), recovered: true };
    } catch {
      return { data: null, recovered: false };
    }
  }
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Parses one SKILL.md. */
export function parseSkill(skillMdPath: string, raw: string): { skill: Skill | null; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const warn = (message: string) => warnings.push({ path: skillMdPath, message });
  const dir = resolve(skillMdPath, "..");
  const directoryName = basename(dir);

  const split = splitFrontmatter(raw);
  if (!split) {
    warn("no YAML frontmatter — a SKILL.md must start with a `---` fence. Skipped.");
    return { skill: null, warnings };
  }

  const { data, recovered } = parseYamlLeniently(split.yaml);
  if (!data) {
    warn("frontmatter is not valid YAML. Skipped.");
    return { skill: null, warnings };
  }
  if (recovered) {
    warn("frontmatter had an unquoted value containing a colon; recovered by quoting it.");
  }

  // description is required: without it there is nothing to put in the catalog,
  // so the model could never decide to activate this skill.
  const description = asNonEmptyString(data["description"]);
  if (!description) {
    warn("frontmatter has no `description`, so the skill can never be matched. Skipped.");
    return { skill: null, warnings };
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    warn(`description is ${description.length} characters; the spec allows ${MAX_DESCRIPTION_LENGTH}.`);
  }

  // name is required by the spec but recoverable: the directory name is what the
  // spec says it must equal anyway.
  let name = asNonEmptyString(data["name"]);
  if (!name) {
    warn(`frontmatter has no \`name\`; using the directory name "${directoryName}".`);
    name = directoryName;
  } else if (name !== directoryName) {
    warn(`\`name\` is "${name}" but the directory is "${directoryName}"; the spec requires they match.`);
  }
  if (name.length > MAX_NAME_LENGTH) {
    warn(`\`name\` is ${name.length} characters; the spec allows ${MAX_NAME_LENGTH}.`);
  }
  if (!NAME_PATTERN.test(name)) {
    warn(`\`name\` "${name}" is not lowercase alphanumerics separated by single hyphens.`);
  }

  return {
    skill: { name, description, body: split.body, dir, path: skillMdPath },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** The directories we scan, highest precedence first. */
function defaultSkillRoots(cwd = process.cwd(), home = homedir()): string[] {
  return [
    join(cwd, ".skills"),
    join(cwd, ".agents", "skills"),
    join(home, ".agents", "skills"),
  ];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Finds skill directories under `root`. */
function findSkillDirectories(root: string, depth = 0): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // missing or unreadable root is normal, not an error
  }

  if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) return [root];
  if (depth >= MAX_SCAN_DEPTH) return [];

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_DIRECTORIES.has(entry.name))
    .flatMap((entry) => findSkillDirectories(join(root, entry.name), depth + 1));
}

export type DiscoverOptions = {
  /** Explicit roots. When given, replaces the default search path entirely. */
  roots?: string[];
  cwd?: string;
  home?: string;
};

/** Loads every discoverable skill. */
export function discoverSkills(options: DiscoverOptions = {}): Discovery {
  const roots = options.roots ?? defaultSkillRoots(options.cwd, options.home);
  const byName = new Map<string, Skill>();
  const warnings: Warning[] = [];

  for (const root of roots) {
    if (!isDirectory(root)) continue;

    for (const dir of findSkillDirectories(root).sort()) {
      const skillMdPath = join(dir, "SKILL.md");

      let raw: string;
      try {
        raw = readFileSync(skillMdPath, "utf8");
      } catch (error) {
        warnings.push({ path: skillMdPath, message: `could not be read: ${(error as Error).message}` });
        continue;
      }

      const { skill, warnings: parseWarnings } = parseSkill(skillMdPath, raw);
      warnings.push(...parseWarnings);
      if (!skill) continue;

      const existing = byName.get(skill.name);
      if (existing) {
        warnings.push({
          path: skill.path,
          message: `shadowed: a skill named "${skill.name}" was already loaded from ${existing.path}.`,
        });
        continue;
      }
      byName.set(skill.name, skill);
    }
  }

  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { skills, warnings };
}
