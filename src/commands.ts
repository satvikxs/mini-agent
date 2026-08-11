import type { Skill } from "./skills.ts";

export type Command = { name: string; summary: string; usage?: string };

/**
 * The built-in commands, in the order `/help` lists them. Skills are added on top
 * of these at runtime and lead, so a skill can never be shadowed by a builtin
 * that shares its name.
 */
export const COMMANDS: Command[] = [
  { name: "help", summary: "list these commands" },
  { name: "skills", summary: "what is installed, and where it came from" },
  { name: "tools", summary: "what the agent can do besides talk" },
  { name: "context", summary: "the exact system prompt being sent" },
  { name: "cost", summary: "tokens and time for this session" },
  { name: "model", summary: "show the model, or switch it", usage: "/model [name]" },
  { name: "mode", summary: "ask before running commands, or don't", usage: "/mode [ask|auto]" },
  { name: "clear", summary: "empty the transcript, keep the conversation" },
  { name: "reset", summary: "forget the conversation entirely" },
  { name: "copy", summary: "put the last answer on the clipboard" },
  { name: "init", summary: "read the project and write AGENTS.md" },
  { name: "logout", summary: "forget the key, and choose a provider again" },
  { name: "quit", summary: "leave" },
];

const names = new Set(COMMANDS.map((command) => command.name));

export const isCommand = (name: string): boolean => names.has(name);

/** `/model sonnet` → `{ name: "model", args: "sonnet" }`. */
export function parse(line: string): { name: string; args: string } | null {
  const match = /^\/([a-z][a-z-]*)\s*([\s\S]*)$/.exec(line.trim());
  return match ? { name: match[1] ?? "", args: (match[2] ?? "").trim() } : null;
}

const pad = (text: string, width: number): string => text.padEnd(width);

export function helpText(skills: readonly Skill[]): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length)) + 2;
  const lines = [
    "Commands",
    ...COMMANDS.map((command) => `  /${pad(command.name, width)}${command.summary}`),
  ];

  if (skills.length > 0) {
    const skillWidth = Math.max(...skills.map((skill) => skill.name.length)) + 2;
    lines.push(
      "",
      "Skills — type one to load it yourself instead of leaving it to the model",
      ...skills.map((skill) => `  /${pad(skill.name, skillWidth)}${gist(skill.description)}`),
    );
  }

  lines.push(
    "",
    "Keys",
    "  ↵     send        esc   stop a running turn",
    "  ↑ ↓   history     ^C    cancel, twice to quit",
    "  tab   complete    ^D    quit",
  );

  return lines.join("\n");
}

/** A description down to its first sentence: the rest is written for the model. */
export function gist(description: string): string {
  const first = (/^.*?[.!?](?=\s|$)/.exec(description.trim()) ?? [description])[0].replace(/[.!?]$/, "");
  return first.charAt(0).toLowerCase() + first.slice(1);
}

export function skillsText(skills: readonly Skill[]): string {
  if (skills.length === 0) return "No skills installed. Add one at .skills/<name>/SKILL.md";

  const width = Math.max(...skills.map((skill) => skill.name.length)) + 2;
  return [
    `${skills.length} skill${skills.length === 1 ? "" : "s"}, loaded on demand`,
    ...skills.map((skill) => `  ${pad(skill.name, width)}${gist(skill.description)}`),
    "",
    "Only these names and descriptions are in the system prompt. A skill's",
    "instructions arrive when the model asks for them, and not before.",
  ].join("\n");
}

export function toolsText(definitions: ReadonlyArray<{ name: string; description?: string }>): string {
  const width = Math.max(...definitions.map((tool) => tool.name.length)) + 2;
  return [
    `${definitions.length} tools`,
    ...definitions.map((tool) => `  ${pad(tool.name, width)}${(tool.description ?? "").split(".")[0]}`),
  ].join("\n");
}

export type Cost = { turns: number; input: number; output: number; elapsedMs: number };

const tokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

export function costText(cost: Cost): string {
  if (cost.turns === 0) return "Nothing sent yet.";
  return [
    `${cost.turns} turn${cost.turns === 1 ? "" : "s"}`,
    `  ${tokens(cost.input)} in · ${tokens(cost.output)} out`,
    `  ${(cost.elapsedMs / 1000).toFixed(1)}s of model time`,
  ].join("\n");
}

/** The prompt `/init` sends. Kept here so the wording lives with the other copy. */
export const INIT_PROMPT = `Read this project and write an AGENTS.md at its root.

Look at the package manifest, the source layout, the test setup and any existing
README before writing anything. The file should tell a newcomer: what this project
is, how to run it, how to test it, and the two or three conventions someone would
otherwise get wrong. Keep it under 60 lines. Write the file, then say what you found.`;
