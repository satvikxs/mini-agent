import { openAnswer, railAnswer } from "./chrome.ts";
import { displayWidth, leftRight, truncate, wrap } from "./layout.ts";
import { createMarkdownStream } from "./markdown.ts";
import { strings } from "./strings.ts";
import { cell, color, glyph, PAD, weight } from "./tokens.ts";

export type Entry =
  | { kind: "user"; text: string }
  | { kind: "answer"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; label: string; brief: string; metric?: string }
  | { kind: "error"; text: string }
  | { kind: "note"; text: string };

/** How much of a failure is worth reading before it turns into noise. */
const ERROR_LINES = 5;

/** Below this, a folded row is all label and no reasoning, so the label goes. */
const MIN_PREVIEW = 24;

const cache = new WeakMap<Entry, { width: number; open: boolean; lines: string[] }>();

/** A blank row goes between kinds, and between one turn and the next. */
const separates = (previous: Entry["kind"], next: Entry["kind"]): boolean =>
  previous !== next || next === "user" || next === "answer";

/**
 * The transcript as rows already painted and already fitted, so scrolling is a slice.
 *
 * `open` expands the reasoning entries. It is a render-time argument rather
 * than a field on them, because it is one setting for the whole transcript:
 * folding thinking away is a decision about how much of the model's working you
 * want to read, not about any one turn.
 */
export function ledgerLines(entries: readonly Entry[], width: number, live?: string, open = false): string[] {
  const lines: string[] = [];
  let previous: Entry["kind"] | null = null;

  for (const entry of entries) {
    const hit = cache.get(entry);
    const fresh = hit?.width === width && hit.open === open;
    const rendered = fresh ? hit.lines : render(entry, width, open);
    // Entries are immutable — the driver swaps in a fresh object rather than patching
    // one — so a hit at the same width is still true, and a rewind evicts by GC.
    if (!fresh) cache.set(entry, { width, open, lines: rendered });

    if (rendered.length === 0) continue; // an entry that draws nothing earns no separator either
    if (previous && separates(previous, entry.kind)) lines.push("");
    lines.push(...rendered);
    previous = entry.kind;
  }

  // Drawn exactly as the committed answer will be, so nothing jumps when it commits.
  if (live) {
    const rendered = answerLines(live, width);
    if (rendered.length === 0) return lines;
    if (lines.length > 0) lines.push("");
    lines.push(...rendered);
  }

  return lines;
}

function render(entry: Entry, width: number, open: boolean): string[] {
  switch (entry.kind) {
    case "user": return userLines(entry.text, width);
    case "answer": return answerLines(entry.text, width);
    case "thinking": return thinkingLines(entry.text, width, open);
    case "tool": return [toolLine(entry, width)];
    case "error": return errorLines(entry.text, width);
    case "note": return noteLines(entry.text, width);
  }
}

function userLines(text: string, width: number): string[] {
  // Wrapped plain and painted after: painting first severs an escape at the cut.
  const rows = wrap(text, Math.max(1, width - 2));
  return rows.map((row, index) =>
    fit((index === 0 ? cell(glyph.user, color.accent) : PAD) + color.text(row), width),
  );
}

function answerLines(text: string, width: number): string[] {
  let buffer = "";
  const stream = createMarkdownStream((chunk) => { buffer += chunk; });
  stream.push(text);
  stream.end();
  if (buffer.length === 0) return [];

  // Markdown wraps at its own global measure, which knows nothing of this pane, so
  // every row is cut again or the fixed-height frame overflows.
  return buffer
    .replace(/\n+$/, "")
    .split("\n")
    .map((row, index) => fit((index === 0 ? openAnswer() : railAnswer()) + row, width));
}

/**
 * The model working, set as a margin note rather than as part of the reply.
 *
 * Folded to its opening line by default. Reasoning routinely runs longer than
 * the answer it produced, and a transcript that is mostly working-out buries
 * the thing the reader actually came back for. The first line is kept because
 * it is the one that says what the model decided to do.
 */
function thinkingLines(text: string, width: number, open: boolean): string[] {
  const rows = wrap(text.trim(), Math.max(1, width - 2));
  if (rows.length === 0) return [];

  const paint = (row: string, index: number): string =>
    fit((index === 0 ? cell(glyph.dot, color.border) : cell(glyph.rail, color.border)) + color.dim(row), width);

  if (open) return rows.map(paint);

  const hidden = rows.length - 1;
  if (hidden === 0) return [paint(rows[0]!, 0)];

  // The row would rather name what unfolds it, but not at the price of the
  // preview: a fold that says `/thinking` and shows four words of reasoning has
  // spent the line explaining itself instead of being useful.
  const room = (label: string): number => width - 2 - label.length - 2;
  const named = strings.moreWith(hidden, strings.thinkingCommand);
  const more = room(named) >= MIN_PREVIEW ? named : strings.more(hidden);

  const head = truncate(rows[0]!, Math.max(1, room(more)));
  return [fit(cell(glyph.dot, color.border) + color.dim(head) + color.muted(`  ${more}`), width)];
}

/** A call that worked draws no body: the metric is the whole story, not a log dump. */
function toolLine(entry: Extract<Entry, { kind: "tool" }>, width: number): string {
  const room = width - 4;
  const metric = entry.metric ?? "";
  const label = entry.label.trim();
  const plain = [label, entry.brief.trim()].filter(Boolean).join("  ");
  // Cut plain, then paint: name and detail carry different weight, so the two are
  // measured against each other before either has colour.
  const cut = truncate(plain, room - displayWidth(metric) - 1);
  const styled =
    cut.length > label.length
      ? weight.strong(color.name(label)) + color.text(cut.slice(label.length))
      : weight.strong(color.name(cut));

  // Right-aligning nothing still pads to the full room, and those trailing spaces are
  // width a pane laid out beside this one would have to account for.
  const row = metric ? leftRight(cut, styled, metric, color.muted(metric), room) : styled;
  return fit(PAD + cell(glyph.call, color.accent) + row, width);
}

/** Truncated rather than wrapped, so five lines of failure stay five rows. */
function errorLines(text: string, width: number): string[] {
  const rows = text.split("\n").map((row) => row.trim()).filter(Boolean).slice(0, ERROR_LINES);
  const gutter = PAD + PAD + cell(glyph.result, color.toolResult);
  return rows.map((row, index) =>
    fit((index === 0 ? gutter : PAD + PAD + PAD) + color.danger(truncate(row, width - 6)), width),
  );
}

function noteLines(text: string, width: number): string[] {
  // `/help` arrives as a note and runs to a screenful, so the rows inside one are kept.
  const body = text.trim();
  return body
    ? body.split("\n").map((row) => fit(PAD + color.dim(truncate(row.trimEnd(), width - 2)), width))
    : [];
}

/**
 * The slice a pane of `height` rows shows, anchored to the bottom. The hint row is
 * reserved before the body is sized; taking it back after is a row of overflow.
 */
export function windowLines(lines: readonly string[], height: number, scrollUp: number): string[] {
  const h = Math.max(1, height);
  const total = lines.length;
  const bodyH = scrollUp > 0 && total > h ? Math.max(1, h - 1) : h;
  const up = Math.min(scrollUp, Math.max(0, total - bodyH));
  const start = Math.max(0, total - bodyH - up);

  // A blank row still has to occupy a row, so it is drawn as a space.
  const rows = lines.slice(start, start + bodyH).map((line) => (line.length === 0 ? " " : line));
  const below = total - (start + rows.length);
  // In a pane one row tall the body has already taken the reservation back.
  if (up > 0 && below > 0 && rows.length < h) rows.push(`  ${color.dim(`↓ ${below} more below`)}`);

  // Padded at the head, so three lines sit on the floor of the pane as three hundred do.
  return [...Array(Math.max(0, h - rows.length)).fill(""), ...rows];
}

export const maxScroll = (total: number, height: number): number =>
  Math.max(0, total - Math.max(1, height));

/** Cuts a painted string to a column count and closes it, so colour cannot bleed down the pane. */
export function fit(styled: string, width: number): string {
  if (width <= 0) return "";

  let out = "";
  let used = 0;
  let painted = false;

  for (let at = 0; at < styled.length; ) {
    if (styled.charAt(at) === "\x1b" && styled.charAt(at + 1) === "[") {
      // A sequence runs to its final byte, which is anything in 0x40–0x7e.
      let end = at + 2;
      while (end < styled.length && !(styled.charCodeAt(end) >= 0x40 && styled.charCodeAt(end) <= 0x7e)) end++;
      out += styled.slice(at, end + 1);
      painted = true;
      at = end + 1;
      continue;
    }
    if (used === width) return painted ? `${out}\x1b[0m` : out;
    out += styled.charAt(at);
    used += 1;
    at += 1;
  }

  return out;
}
