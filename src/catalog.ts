import type { Skill } from "./skills.ts";

/** The catalog is XML-ish, so descriptions containing angle brackets must escape. */
function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildCatalog(skills: Skill[]): string {
  const entries = skills.map((skill) =>
    [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.path)}</location>`,
      "  </skill>",
    ].join("\n"),
  );

  return ["<available_skills>", ...entries, "</available_skills>"].join("\n");
}

const BASE_PROMPT = `You are mini-agent, a coding agent running in a terminal.
Answer concisely and in plain text suitable for a terminal.

You can read, write and edit files, search the workspace, and run shell commands.
Prefer looking to asking: read the file before describing it, run the test before
claiming it passes. Paths are relative to the workspace root.`;

const SKILL_INSTRUCTIONS = `You have access to Agent Skills: folders of expert instructions for specific tasks.
Below is the catalog. It lists only each skill's name and description — not its instructions.

When a request matches a skill's description, call \`load_skill\` with that skill's name to
read its full instructions, then follow them exactly. A loaded skill's instructions override
your default behaviour, including any exact output format or wording it requires.

Load at most the skills you actually need. If nothing in the catalog fits the request,
answer directly without loading anything.`;

/** Assembles the system prompt. `place` describes the workspace, when there is one. */
export function buildSystemPrompt(skills: Skill[], place?: string): string {
  const parts = [BASE_PROMPT];
  if (place) parts.push("", place);
  if (skills.length > 0) parts.push("", SKILL_INSTRUCTIONS, "", buildCatalog(skills));
  return parts.join("\n");
}
