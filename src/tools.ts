import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { Skill } from "./skills.ts";

export type ToolEvent =
  | { type: "skill_activated"; skill: string }
  | { type: "resource_loaded"; skill: string; file: string };

export type ToolOutcome = { content: string; isError: boolean; event?: ToolEvent };

const MAX_LISTED_RESOURCES = 50;
const MAX_RESOURCE_BYTES = 64 * 1024;
const RESOURCE_SCAN_DEPTH = 3;

/** Lists a skill's bundled files by name only. */
function listResources(dir: string, prefix = "", depth = 0): string[] {
  if (depth > RESOURCE_SCAN_DEPTH) return [];

  let entries;
  try {
    entries = readdirSync(join(dir, prefix), { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => !entry.name.startsWith("."))
    .flatMap((entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return listResources(dir, path, depth + 1);
      return entry.isFile() && path !== "SKILL.md" ? [path] : [];
    })
    .sort();
}

/** Renders an activated skill for the model, with its directory and resources. */
function renderSkill(skill: Skill): string {
  const resources = listResources(skill.dir);
  const shown = resources.slice(0, MAX_LISTED_RESOURCES);

  const sections = [`<skill name="${skill.name}">`, skill.body, ""];

  if (shown.length > 0) {
    sections.push(
      `This skill bundles the files below. They are NOT loaded yet — call \`read_skill_file\``,
      `if the instructions above point at one. Paths are relative to the skill directory.`,
      "<skill_resources>",
      ...shown.map((file) => `  <file>${file}</file>`),
      ...(resources.length > shown.length ? [`  <!-- ${resources.length - shown.length} more omitted -->`] : []),
      "</skill_resources>",
      "",
    );
  }

  sections.push(`Skill directory: ${skill.dir}`, "</skill>");
  return sections.join("\n");
}

/** Resolves a path inside a skill directory, refusing anything that escapes it. */
function resolveInsideSkill(skill: Skill, requestedPath: string): { path: string; relativePath: string } | null {
  let base: string;
  try {
    // Resolve the base through symlinks too, otherwise a skill living under a
    // symlinked path (macOS /tmp, a symlinked checkout) fails its own check.
    base = realpathSync(resolve(skill.dir));
  } catch {
    return null;
  }

  const target = resolve(base, requestedPath);
  const contains = (path: string) => path === base || path.startsWith(base + sep);

  if (!contains(target)) return null; // lexical check: rejects ../ without touching disk
  try {
    if (!contains(realpathSync(target))) return null; // symlink check
  } catch {
    return null; // does not exist; the caller reports it
  }
  return { path: target, relativePath: relative(base, target) };
}

export type SkillTools = {
  definitions: Anthropic.Tool[];
  run(toolName: string, input: unknown): ToolOutcome;
};

export function createSkillTools(skills: Skill[]): SkillTools {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const activated = new Set<string>();
  const hasResources = skills.some((skill) => listResources(skill.dir).length > 0);

  const definitions: Anthropic.Tool[] = [
    {
      name: "load_skill",
      description:
        "Load the full instructions for one of the available skills. Call this when a skill's " +
        "description in <available_skills> matches what the user is asking for, then follow the " +
        "instructions it returns.",
      input_schema: {
        type: "object",
        properties: {
          // Constraining to an enum means the model cannot invent a skill name.
          name: { type: "string", enum: [...byName.keys()], description: "The skill's name." },
        },
        required: ["name"],
      },
    },
  ];

  if (hasResources) {
    definitions.push({
      name: "read_skill_file",
      description:
        "Read one file bundled inside a skill, such as a file under references/ or scripts/. " +
        "Only call this when a loaded skill's instructions refer to that file.",
      input_schema: {
        type: "object",
        properties: {
          skill: { type: "string", enum: [...byName.keys()], description: "The skill that owns the file." },
          path: { type: "string", description: "Path relative to the skill directory, e.g. references/details.md." },
        },
        required: ["skill", "path"],
      },
    });
  }

  function loadSkill(input: Record<string, unknown>): ToolOutcome {
    const name = String(input["name"] ?? "");
    const skill = byName.get(name);
    if (!skill) {
      return { content: `No skill named "${name}". Available: ${[...byName.keys()].join(", ")}.`, isError: true };
    }
    // Already in context from an earlier turn — re-sending the body would just
    // duplicate it.
    if (activated.has(name)) {
      return { content: `The "${name}" skill is already loaded earlier in this conversation.`, isError: false };
    }
    activated.add(name);
    return { content: renderSkill(skill), isError: false, event: { type: "skill_activated", skill: name } };
  }

  function readSkillFile(input: Record<string, unknown>): ToolOutcome {
    const skillName = String(input["skill"] ?? "");
    const requestedPath = String(input["path"] ?? "");
    const skill = byName.get(skillName);
    if (!skill) return { content: `No skill named "${skillName}".`, isError: true };

    const resolved = resolveInsideSkill(skill, requestedPath);
    if (!resolved) {
      return { content: `"${requestedPath}" is not a readable file inside the "${skillName}" skill.`, isError: true };
    }
    const { path: target, relativePath } = resolved;
    if (!statSync(target).isFile()) {
      return { content: `"${requestedPath}" is a directory, not a file.`, isError: true };
    }

    const body = readFileSync(target, "utf8");
    const truncated = body.length > MAX_RESOURCE_BYTES;

    return {
      content: `<skill_file skill="${skillName}" path="${relativePath}">\n${
        truncated ? `${body.slice(0, MAX_RESOURCE_BYTES)}\n… truncated` : body
      }\n</skill_file>`,
      isError: false,
      event: { type: "resource_loaded", skill: skillName, file: relativePath },
    };
  }

  return {
    definitions,
    run(toolName, input) {
      const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
      try {
        if (toolName === "load_skill") return loadSkill(args);
        if (toolName === "read_skill_file") return readSkillFile(args);
        return { content: `Unknown tool "${toolName}".`, isError: true };
      } catch (error) {
        // A tool failure is reported back to the model so it can recover,
        // rather than crashing the CLI.
        return { content: `Tool "${toolName}" failed: ${(error as Error).message}`, isError: true };
      }
    },
  };
}
