#!/usr/bin/env node
import { button, centre, column, divider, heading, keyRail, row, split, tabs } from "../src/ui/frame.ts";
import { color, glyph } from "../src/ui/tokens.ts";

/**
 * Draws the home view against fixed data, so the layout can be looked at without
 * an API key, a terminal size, or an agent actually running. Iterating on a
 * screen you cannot see is how the last version got built.
 */

const { width, left } = column(Number(process.argv[2]) || process.stdout.columns || 100);
const out = (line = ""): void => void process.stdout.write(`${left}${line}\n`);

const LEFT = 22;

const agents = [
  { name: "auth migration", state: "running", skill: "writing-plans" },
  { name: "changelog", state: "done", skill: "internal-comms" },
  { name: "rate limits", state: "idle", skill: "welcome-me" },
];

const list: string[] = [];
list.push(heading("running"));
list.push(row(agents[0]!.name, LEFT, true));
list.push("");
list.push(heading("idle"));
for (const agent of agents.slice(1)) list.push(row(agent.name, LEFT, false));

const detail: string[] = [
  color.text("auth migration"),
  color.muted("writing-plans · 3 turns"),
  "",
  `${color.ok(glyph.status)} ${color.muted("running")}   ${color.accent("94 tok/s")}`,
  "",
  `${color.accent(glyph.assistant)} ${color.body("I'm using the writing-plans skill to create the")}`,
  `${color.border(glyph.rail)} ${color.body("implementation plan.")}`,
  `${color.border(glyph.rail)}`,
  `${color.border(glyph.rail)} ${color.text("Task 1: Create the limiter")}`,
  `${color.border(glyph.rail)} ${color.muted("src/rate-limit.ts")}`,
  "",
  button("open", "enter"),
];

out();
for (const line of tabs(
  [
    { key: "", label: "mini-agent" },
    { key: "a", label: "agents", badge: "[3]" },
    { key: "s", label: "skills", badge: "[3]" },
    { key: "n", label: "new" },
  ],
  0,
  width,
)) {
  out(line);
}
out();
out();

for (const line of split(list, detail, LEFT)) out(`  ${line}`);

for (let i = split(list, detail, LEFT).length; i < 16; i++) out();
out(centre(color.muted("3 agents · 12.4k tokens this session"), width));
out(divider(width));
out(
  keyRail(
    [
      ["↑/↓", "agents"],
      ["↵", "open"],
      ["n", "new"],
      ["x", "stop"],
      ["q", "quit"],
    ],
    width,
  ),
);
out();
