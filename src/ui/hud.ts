import { displayWidth } from "./layout.ts";
import { color, glyph, space } from "./tokens.ts";

/**
 * The one row of chrome that closes a turn.
 *
 * Two rules keep it from becoming furniture. **It can be absent**, and so can
 * every segment — a row that always renders something teaches the eye to stop
 * reading it. And **it drops, it never wraps**: segments are shed worst
 * `drop` first until the row fits, so the facts that change what you do next
 * are the ones that survive a narrow terminal.
 */
export type Segment = {
  text: string;
  tone: "accent" | "text" | "dim";
  /** Higher goes first when the row is too wide. */
  drop: number;
};

export type Turn = {
  skills: number;
  input: number;
  output: number;
  ttftMs: number;
  elapsedMs: number;
};

const tokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;

const seconds = (ms: number): string => (ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);

const rate = (value: number): string => (value >= 1000 ? tokens(Math.round(value)) : value.toFixed(1));

export function segments(turn: Turn): Segment[] {
  const out: Segment[] = [];

  if (turn.skills > 0) {
    out.push({ text: `${turn.skills} skill${turn.skills === 1 ? "" : "s"}`, tone: "text", drop: 1 });
  }

  // Generation rate, measured from the first token rather than from the request,
  // so the wait for the model to start is not counted as slow generation.
  const generating = turn.elapsedMs - turn.ttftMs;
  if (turn.output > 0 && generating > 0) {
    out.push({ text: `${rate((turn.output / generating) * 1000)} tok/s`, tone: "accent", drop: 0 });
  }

  if (turn.elapsedMs > 0) out.push({ text: seconds(turn.elapsedMs), tone: "dim", drop: 2 });
  if (turn.ttftMs > 0) out.push({ text: `ttft ${seconds(turn.ttftMs)}`, tone: "dim", drop: 3 });
  if (turn.input > 0) out.push({ text: `${tokens(turn.input)} in · ${tokens(turn.output)} out`, tone: "dim", drop: 4 });

  return out;
}

const paint = (segment: Segment): string =>
  segment.tone === "accent" ? color.accent(segment.text) : segment.tone === "text" ? color.text(segment.text) : color.dim(segment.text);

/** Sheds segments until the row fits, then joins what is left. */
export function fit(all: Segment[], width: number): string | null {
  const kept = [...all];
  const join = " " + glyph.dot + " ";

  const measure = (): number =>
    kept.reduce((sum, segment) => sum + segment.text.length, 0) + Math.max(0, kept.length - 1) * join.length;

  while (kept.length > 1 && measure() + space.gutter.length > width) {
    const worst = Math.max(...kept.map((segment) => segment.drop));
    kept.splice(
      kept.findIndex((segment) => segment.drop === worst),
      1,
    );
  }

  if (kept.length === 0) return null;
  return space.gutter + kept.map(paint).join(color.border(join));
}

/** The row for one finished turn, or null when it has nothing to report. */
export function turnStatus(turn: Turn, columns = process.stdout.columns): string | null {
  const all = segments(turn);
  return all.length === 0 ? null : fit(all, (columns || 80) - space.gutter.length);
}

export { displayWidth };
