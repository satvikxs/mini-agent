import { homedir } from "node:os";
import type { Skill } from "../skills.ts";
import { leftRight, truncate } from "./layout.ts";
import { strings } from "./strings.ts";
import { cell, color, glyph, PAD, space } from "./tokens.ts";

/**
 * The screen a session opens onto: a title row, the skills you could reach for,
 * the input line, and what you can press. Everything above the input is chrome
 * and earns its place; the space between them is canvas, not waste.
 */

const room = (columns: number | undefined): number => (columns || 80) - space.gutter.length * 2;

/** `~/src/thing`, since an absolute path from home is noise. */
function shortCwd(cwd = process.cwd(), home = homedir()): string {
  return cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

/**
 * The title row: who this is and where, against what it is pointed at.
 *
 * The mark and the model are the two facts that change what happens next, so
 * they take the ends. The path between them is a name, like every other path.
 */
export function winbar(skillCount: number, model: string, columns = process.stdout.columns): string {
  const width = room(columns);
  const place = shortCwd();

  const leftPlain = `${glyph.assistant} ${strings.product}  ${place}`;
  const left = `${color.accent(glyph.assistant)} ${color.text(strings.product)}  ${color.name(place)}`;

  const status = strings.ready(skillCount);
  const rightPlain = `${glyph.status} ${status}  ${model}`;
  const right = `${color.ok(glyph.status)} ${color.muted(status)}  ${color.name(model)}`;

  return space.gutter + leftRight(leftPlain, left, rightPlain, right, width);
}

/**
 * The skills, as things you could type. This is the catalog made visible: the
 * same names and descriptions the model is working from, in the same order.
 *
 * The caret marks the first, which is what a bare Enter would not run — it is a
 * list to read, not a menu to drive, and pretending otherwise would advertise
 * arrow keys nothing is listening for.
 */
export function suggestions(skills: Skill[], columns = process.stdout.columns): string[] {
  if (skills.length === 0) return [];

  const names = skills.map((skill) => `/${skill.name}`);
  const column = Math.max(...names.map((name) => name.length));
  const width = room(columns);

  return skills.map((skill, index) => {
    const name = (names[index] ?? "").padEnd(column);
    const said = truncate(gist(skill.description), Math.max(8, width - column - 6));
    const mark = index === 0 ? cell(glyph.caret, color.muted) : PAD;
    return `${space.gutter}${mark}${index === 0 ? color.accent(name) : color.name(name)}  ${color.muted(said)}`;
  });
}

/**
 * A description down to its first sentence, lower-cased at the front.
 *
 * A skill's `description` is written for the model and runs to a paragraph —
 * it lists trigger phrasings and boundaries, none of which a person scanning a
 * list needs. The first sentence is the part that says what the thing is.
 */
function gist(description: string): string {
  const first = (/^.*?[.!?](?=\s|$)/.exec(description.trim()) ?? [description])[0].replace(/[.!?]$/, "");
  return first.charAt(0).toLowerCase() + first.slice(1);
}

/** What you can press. Keys in the accent, labels stepped back. */
export function hints(): string {
  const pairs = strings.hints.map(([key, label]) =>
    label ? `${color.accent(key)} ${color.muted(label)}` : color.accent(key),
  );
  return space.gutter + pairs.join("   ");
}

/** The input line, anchored in column 0 like every other turn. */
export const composer = (): string => `\n${cell(glyph.user, color.accent)}`;

/** Everything above the first prompt, in one piece. */
export function opening(skills: Skill[], model: string, columns = process.stdout.columns): string {
  return [winbar(skills.length, model, columns), "", ...suggestions(skills, columns), "", hints()].join("\n");
}
