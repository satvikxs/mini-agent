import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Builds a throwaway skills root. Keys are paths relative to that root. */
export function makeSkillsRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "mini-agent-test-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, contents);
  }
  return root;
}

export function removeRoots(...roots: string[]): void {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

export function skillMd(name: string, description: string, body = "Body of the skill."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}
