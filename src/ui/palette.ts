import { displayWidth, truncate, windowStart } from "./layout.ts";
import { color, glyph, invert, weight } from "./tokens.ts";

export type Candidate = { id: string; label: string; meta: string; run: string };
export type Row = { candidate: Candidate; score: number; positions: number[] };

type Paint = (text: string) => string;

// Labels and metas come from third-party `SKILL.md` frontmatter. U+009B is CSI in a
// UTF-8 terminal, so a description can open an SGR sequence without ever holding an
// ESC. One space per match: a shorter replacement slides highlights off their glyphs.
const HOSTILE = [/[\x00-\x1f\x7f-\x9f]/g, /[‪-‮⁦-⁩‎‏]/g, /[​-‍﻿]/g];

const clean = (text: string): string => HOSTILE.reduce((out, pattern) => out.replace(pattern, " "), text);

/** Open is derived, never stored: backspacing the slash closes the panel by itself. */
export const isPaletteOpen = (text: string): boolean => text.startsWith("/");

/** `/model gpt-5` is still `model` while the argument is being typed. */
export function commandQuery(text: string): string {
  const rest = text.startsWith("/") ? text.slice(1) : text;
  const space = rest.indexOf(" ");
  return space < 0 ? rest : rest.slice(0, space);
}

export function commandArgs(text: string): string {
  const space = text.indexOf(" ");
  return space < 0 ? "" : text.slice(space + 1).trim();
}

const MATCH = 16;
const BOUNDARY = 8;
const CAMEL = 7;
const LEAD_IN = 3;

function boundary(text: string, at: number): number {
  if (at === 0) return BOUNDARY;
  const before = text[at - 1] ?? "";
  if (/[^a-z0-9]/i.test(before)) return BOUNDARY;
  const here = text[at] ?? "";
  return before === before.toLowerCase() && here !== here.toLowerCase() ? CAMEL : 0;
}

function fuzzy(text: string, query: string): { score: number; positions: number[] } | null {
  // Everything matches flat, which lists the pool in registry order on the slash.
  if (query === "") return { score: 0, positions: [] };

  const hay = text.toLowerCase();
  const needle = query.toLowerCase();

  let end = -1;
  for (let at = 0, want = 0; at < hay.length && end < 0; at++) {
    if (hay[at] === needle[want] && ++want === needle.length) end = at;
  }
  if (end < 0) return null;

  // Back out to the tightest start: `abc` wants the trailing run in `a-b-abc`.
  let start = 0;
  for (let at = end, want = needle.length - 1; at >= 0; at--) {
    if (hay[at] === needle[want] && want-- === 0) {
      start = at;
      break;
    }
  }

  const positions: number[] = [];
  let score = 0;
  let previous = -1;
  for (let at = start; at <= end && positions.length < needle.length; at++) {
    if (hay[at] !== needle[positions.length]) continue;
    score += MATCH + (text.charCodeAt(at) === query.charCodeAt(positions.length) ? 1 : 0);
    const bonus = boundary(text, at);
    if (previous === at - 1) score += Math.max(bonus, BOUNDARY);
    else {
      const gap = previous < 0 ? 0 : at - previous - 1;
      score += bonus * (previous < 0 ? 2 : 1) - (LEAD_IN + (gap - 1));
    }
    positions.push(at);
    previous = at;
  }

  score -= Math.min(positions[0] ?? 0, 12) + Math.min(text.length >> 2, 8);
  // Typing a name out in full always wins, whatever else it happens to prefix.
  if (hay.startsWith(needle)) score += hay.length === needle.length ? 24 + 48 : 24;
  return { score, positions };
}

/** Best first; ties fall back to registry order, so an empty term reproduces the pool. */
export function rankCandidates(term: string, pool: readonly Candidate[], limit = 50): Row[] {
  const ranked: Array<Row & { at: number }> = [];

  pool.forEach((candidate, at) => {
    const label = fuzzy(clean(candidate.label), term);
    // A meta hit is weaker, and its positions index the wrong string: painted on the
    // label they would light up unrelated glyphs, so they are dropped.
    const meta = label ? null : fuzzy(clean(candidate.meta), term);
    if (label) ranked.push({ candidate, score: label.score, positions: label.positions, at });
    else if (meta) ranked.push({ candidate, score: Math.floor(meta.score / 2) - 8, positions: [], at });
  });

  ranked.sort((a, b) => b.score - a.score || a.at - b.at);
  return ranked.slice(0, Math.max(0, limit)).map(({ candidate, score, positions }) => ({ candidate, score, positions }));
}

/** Arrows wrap; anything larger clamps, so a page key never teleports across the list. */
export function moveSelection(index: number, step: number, total: number): number {
  if (total <= 0) return 0;
  // A stale index from a re-rank degrades to an end of the list rather than throwing.
  const raw = Math.min(Math.max(index, 0), total - 1) + step;
  if (Math.abs(step) === 1) return ((raw % total) + total) % total;
  return Math.min(Math.max(raw, 0), total - 1);
}

/** `/tmp/foo is broken` fuzzy-ranks a command, so only a literal prefix authorises running one. */
export function authorisesRun(term: string, row: Row | undefined): boolean {
  if (!row || term === "") return false;
  return row.candidate.run.toLowerCase().startsWith(`/${term}`.toLowerCase());
}

/** A header plus at least one body row. The driver bills this against the frame budget. */
export const paletteHeight = (count: number, maxRows: number): number =>
  1 + Math.min(Math.max(1, maxRows), Math.max(1, count));

function highlight(plain: string, marks: ReadonlySet<number>, on: Paint, off: Paint): string {
  let out = "";
  let run = "";
  let hot = false;
  for (let at = 0; at < plain.length; at++) {
    const now = marks.has(at);
    if (now !== hot && run) {
      out += hot ? on(run) : off(run);
      run = "";
    }
    hot = now;
    run += plain[at] ?? "";
  }
  return out + (run ? (hot ? on(run) : off(run)) : "");
}

/** The panel. Returns exactly `paletteHeight(rows.length, maxRows)` lines. */
export function paletteRows(rows: readonly Row[], term: string, selected: number, width: number, maxRows: number): string[] {
  const total = rows.length;
  const head = `${color.dim("find")} ${color.muted(`${total} ${total === 1 ? "command" : "commands"}`)}`;
  const hint = "↑↓ move  ↵ run  esc close";
  const room = width - displayWidth(head) - hint.length;
  const lines = [room < 1 ? head : head + " ".repeat(room) + color.muted(hint)];

  if (total === 0) {
    lines.push(color.dim(truncate(term ? `no matches for ${clean(term)}` : "nothing to show", width)));
    return lines;
  }

  const per = Math.min(Math.max(1, maxRows), total);
  const at = Math.min(Math.max(selected, 0), total - 1);
  const start = windowStart(at, per, total);

  rows.slice(start, start + per).forEach((row, offset) => {
    const index = start + offset;
    // Two columns, and overflow is told by these markers alone — no `+N more` count.
    const edge = offset === 0 && start > 0 ? "↑ " : offset === per - 1 && start + per < total ? "↓ " : "";
    const marker = edge || (index === at ? `${glyph.caret} ` : "  ");
    const label = truncate(clean(row.candidate.label), Math.max(0, width - 2));
    const spare = width - 3 - label.length;
    // A meta clipped past reading is noise, so it goes rather than shrinks.
    const meta = spare >= 6 ? truncate(clean(row.candidate.meta), spare) : "";
    const fill = meta ? " ".repeat(width - 2 - label.length - meta.length) : "";
    const marks = new Set(row.positions.filter((position) => position < label.length));

    if (index === at) {
      // `tokens.ts`'s painters are hand-rolled and not nest-safe, and accent over
      // accent is illegible — inside the block only weight may change.
      const inside = new Set([...marks].map((position) => position + 2));
      lines.push(invert(highlight(`${marker}${label}${fill}${meta}`.padEnd(width), inside, weight.strong, (t) => t)));
      return;
    }
    const body = highlight(label, marks, color.accent, color.name);
    lines.push(`${edge ? color.dim(edge) : marker}${body}${fill}${meta ? color.muted(meta) : ""}`);
  });

  return lines;
}

/** A skill description is written for the model and runs to a paragraph; the list wants a phrase. */
function gist(description: string): string {
  const text = description.trim();
  const stop = /[.!?](\s|$)/.exec(text);
  const first = stop ? text.slice(0, stop.index) : text;
  return first.charAt(0).toLowerCase() + first.slice(1);
}

export const skillCandidates = (skills: readonly { name: string; description: string }[]): Candidate[] =>
  skills.map((skill) => ({ id: `skill:${skill.name}`, label: `/${skill.name}`, meta: gist(skill.description), run: `/${skill.name}` }));
