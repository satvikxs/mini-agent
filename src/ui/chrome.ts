import { measure, truncate } from "./layout.ts";
import { arrival, lap, ROWS as GOAT_ROWS, WIDTH as GOAT_WIDTH } from "./mascot.ts";
import { strings } from "./strings.ts";
import { cell, color, glyph, PAD, space, weight } from "./tokens.ts";

/** The gap between the goat and the wordmark beside it. */
const LOCKUP_GAP = "   ";

/** Two rows down, which sets the text against the body rather than the horns. */
const LOCKUP_TEXT_ROW = 2;

/** Columns reserved for the text beside the goat. */
const LOCKUP_TEXT = 30;

/** The narrowest terminal a side-by-side lockup still fits in. */
const LOCKUP_WIDTH = GOAT_WIDTH + LOCKUP_GAP.length + LOCKUP_TEXT;

/** Sets a block of art against a column of text, one line of text per row of art. */
const beside = (art: string[], lines: string[], from: number): string[] =>
  art.map((row, index) => {
    const text = lines[index - from];
    if (text) return `${space.gutter}${color.accent(row)}${LOCKUP_GAP}${text}`;
    // A row the goat has vacated — mid-jump, say — is left genuinely empty
    // rather than as a gutter's worth of trailing spaces.
    const trimmed = row.trimEnd();
    return trimmed ? `${space.gutter}${color.accent(trimmed)}` : "";
  });

/** What sits beside the goat when nothing has asked it to say anything else. */
export const bannerLines = (skillCount: number): string[] => [
  strings.product,
  strings.ready(skillCount),
  strings.keyHints,
  strings.playHints,
];

/** Art is a fixed width, so it is measured against the terminal, not `measure()`. */
const roomFor = (columns: number | undefined): number => (columns || 80) - space.gutter.length * 2;

/** Lays one frame of art against a column of text. The first line takes the weight. */
function composeBanner(art: string[], lines: string[], columns: number | undefined): string[] {
  const room = roomFor(columns);
  const measureTo = room >= LOCKUP_WIDTH ? LOCKUP_TEXT : room;
  const fitted = lines.map((line, index) => {
    const text = truncate(line, Math.max(4, measureTo));
    return index === 0 ? weight.strong(text) : color.dim(text);
  });

  if (room < GOAT_WIDTH) return ["", ...fitted.map((line) => `${space.gutter}${line}`)];
  return room >= LOCKUP_WIDTH ? lockup(art, fitted) : stacked(art, fitted);
}

/** Opens a session. */
export const bannerFrames = (skillCount: number, columns = process.stdout.columns): string[][] =>
  arrival().map((art) => composeBanner(art, bannerLines(skillCount), columns));

/** The banner's own goat running a lap, changing what it says on the way round. */
export function bannerLapFrames(
  from: string[],
  to: string[],
  columns = process.stdout.columns,
): string[][] {
  if (roomFor(columns) < GOAT_WIDTH) return [];

  const art = lap();
  // Found rather than assumed: the first frame with nothing in it is the moment the goat is
  // genuinely off its own edge.
  const away = art.findIndex((frame, index) => index > 0 && frame.every((row) => row.trim() === ""));
  const swapAt = away === -1 ? Math.floor(art.length / 2) : away;

  return art.map((frame, index) => composeBanner(frame, index < swapAt ? from : to, columns));
}

/** What the goat has to say, as plain output, for when the banner has scrolled out of reach. */
export const aboutBlock = (lines: string[]): string =>
  [
    "",
    ...lines.map((line, index) => `${space.gutter}${index === 0 ? color.accent(line) : color.dim(line)}`),
  ].join("\n");

/** Where the goat sits inside a banner frame, so a click can be aimed at it and not at everything else. */
export const goatArea = {
  row: 1,
  rows: GOAT_ROWS,
  column: space.gutter.length + 1,
  columns: GOAT_WIDTH,
};

/** The goat beside the wordmark. */
const lockup = (art: string[], lines: string[]): string[] => ["", ...beside(art, lines, LOCKUP_TEXT_ROW)];

/** The goat above the wordmark, for terminals too narrow to set them side by side. */
function stacked(art: string[], lines: string[]): string[] {
  return [
    "",
    ...art.map((row) => `${space.gutter}${color.accent(row.trimEnd())}`),
    "",
    ...lines.map((line) => `${space.gutter}${line}`),
  ];
}

export const banner = (skillCount: number, columns = process.stdout.columns): string =>
  (bannerFrames(skillCount, columns).at(-1) ?? []).join("\n");

/**
 * Column 0: the agent starting to speak, then the rail while it keeps speaking.
 * The rail is what makes an answer read as one block rather than as loose lines.
 */
export const openAnswer = (): string => cell(glyph.assistant, color.accent);
export const railAnswer = (): string => cell(glyph.rail, color.border);

/** Columns 2 and 4: a call the agent made, and what came back from it. */
function workLine(indent: string, mark: string, paint: (t: string) => string, label: string, detail: string): string {
  const suffix = detail ? `  ${detail}` : "";
  const room = measure() - indent.length - 2 - suffix.length;
  return `${indent}${cell(mark, paint)}${color.name(truncate(label, Math.max(4, room)))}${color.muted(suffix)}`;
}

export const skillLine = (name: string): string =>
  workLine(PAD, glyph.call, color.accent, name, strings.skillMark);

export const resourceLine = (file: string): string =>
  workLine(PAD + PAD, glyph.result, color.toolResult, file, strings.resourceMark);

/**
 * A workspace tool that ran: what it was, and what it acted on.
 *
 * Drawn from the *result* rather than the call, because the tool reports a
 * clean label for its target — a path, a match count, the command — where the
 * call carries only the raw JSON the model happened to produce.
 */
export const toolLine = (tool: string, label: string, failed: boolean): string =>
  // Said as well as coloured: a red glyph alone is invisible in a pipe, in a
  // log, and to a reader who cannot tell the two greys apart.
  workLine(PAD, glyph.call, failed ? color.danger : color.tool, tool, failed ? `${label}  ${strings.toolFailed}`.trim() : label);

/**
 * Column 0 for reasoning: the same rail as an answer, painted back.
 *
 * Thinking is the model working rather than talking, so it reads as a margin
 * note — dim, and unmistakably not the reply that follows it.
 */
export const openThought = (): string => cell(glyph.dot, color.border);
export const railThought = (): string => cell(glyph.rail, color.border);
export const thought = (text: string): string => color.dim(text);

export const notice = (text: string): string => `${space.gutter}${color.dim(text)}`;
export const failure = (text: string): string => `${space.gutter}${color.danger(text)}`;
