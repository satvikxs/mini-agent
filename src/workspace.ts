import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type Workspace = { root: string };

const SKIP = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", ".venv", "__pycache__"]);

export const openWorkspace = (root = process.cwd()): Workspace => ({ root: realpathSync(resolve(root)) });

/**
 * Resolves a path inside the workspace, refusing anything that escapes it.
 *
 * The model chooses these paths, so `../../.ssh/id_rsa` has to be impossible.
 * realpath is checked too: a symlink pointing outside would otherwise pass a
 * prefix test on its own name.
 */
export function resolveInside(workspace: Workspace, path: string): string | null {
  const target = isAbsolute(path) ? resolve(path) : resolve(workspace.root, path);
  const contains = (candidate: string): boolean =>
    candidate === workspace.root || candidate.startsWith(workspace.root + sep);

  if (!contains(target)) return null;
  try {
    // A path that does not exist yet is fine — write creates it — so only an
    // existing one is checked through its links.
    if (!contains(realpathSync(target))) return null;
  } catch {
    return target;
  }
  return target;
}

export const show = (workspace: Workspace, path: string): string => relative(workspace.root, path) || ".";

/** Null bytes in the first few KB is the usual heuristic, and it is good enough. */
export const looksBinary = (buffer: Buffer): boolean => buffer.subarray(0, 4096).includes(0);

export type Entry = { path: string; directory: boolean };

/** Walks the workspace, skipping the directories nobody means to search. */
export function walk(workspace: Workspace, from = workspace.root, depth = 0, budget = { left: 4000 }): Entry[] {
  if (depth > 8 || budget.left <= 0) return [];

  let entries;
  try {
    entries = readdirSync(from, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: Entry[] = [];
  for (const entry of entries) {
    if (budget.left <= 0) break;
    if (entry.name.startsWith(".") && entry.name !== ".skills") continue;
    if (SKIP.has(entry.name)) continue;

    const path = join(from, entry.name);
    budget.left -= 1;
    out.push({ path, directory: entry.isDirectory() });
    if (entry.isDirectory()) out.push(...walk(workspace, path, depth + 1, budget));
  }
  return out;
}

/** Project notes an agent should have read before it starts guessing. */
const NOTES = ["AGENTS.md", "CLAUDE.md", "KEELCODE.md", "README.md"];

/**
 * What the agent is told about where it is, before it asks anything.
 *
 * Without this it has no idea what project it is in and burns its first turn
 * listing files. A shallow tree and the top of whichever notes file exists is
 * cheap and answers most of it.
 */
export function describe(workspace: Workspace): string {
  const top = walk(workspace, workspace.root, 7, { left: 60 })
    .map((entry) => `${show(workspace, entry.path)}${entry.directory ? "/" : ""}`)
    .sort()
    .slice(0, 40);

  const notes = NOTES.map((name) => {
    const path = resolveInside(workspace, name);
    if (!path) return null;
    try {
      if (!statSync(path).isFile()) return null;
      return `# ${name}\n${readFileSync(path, "utf8").slice(0, 2000)}`;
    } catch {
      return null;
    }
  }).find(Boolean);

  return [
    `<workspace root="${workspace.root}">`,
    top.join("\n"),
    "</workspace>",
    ...(notes ? ["", "<project_notes>", notes, "</project_notes>"] : []),
  ].join("\n");
}
