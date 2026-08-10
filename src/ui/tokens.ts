import { styleText } from "node:util";

const enabled = process.stdout.isTTY && !process.env["NO_COLOR"];
const truecolor = /truecolor|24bit/i.test(process.env["COLORTERM"] ?? "");

/** Whether the screen can be redrawn in place. */
export const motion = Boolean(process.stdout.isTTY) && process.env["TERM"] !== "dumb";

type Paint = (text: string) => string;

const passthrough: Paint = (text) => text;

/** 24-bit colour where the terminal has it, the nearest named ANSI colour otherwise. */
function hex(value: string, fallback: "gray" | "red" | "white"): Paint {
  if (!enabled) return passthrough;
  if (!truecolor) return (text) => styleText(fallback, text);
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16));
  return (text) => `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

function attribute(name: "bold" | "italic"): Paint {
  return enabled ? (text) => styleText(name, text) : passthrough;
}

/** One cool field. The accent is the same hue brought forward, and means focus, never state. */
export const color = {
  /** Answer text, left unpainted so it sits inside the reader's own theme. */
  body: passthrough,
  text: hex("#c9c9c9", "white"),
  /** Things with a name: files, paths, skills, tools, the model. */
  name: hex("#a8b5e6", "white"),
  dim: hex("#9a9a9a", "gray"),
  muted: hex("#787878", "gray"),
  border: hex("#5b5b5b", "gray"),
  /** Anything asking to be looked at: a permission prompt, a selection, what is live. */
  accent: hex("#a78bfa", "white"),
  accentAlt: hex("#c9b8ff", "white"),
  ok: hex("#a9b7a2", "gray"),
  tool: hex("#bcbcbc", "gray"),
  toolResult: hex("#aaaaaa", "gray"),
  danger: hex("#d99393", "red"),
};

export const weight = {
  strong: attribute("bold"),
  emphasis: attribute("italic"),
};

/** The canvas. Set once on entering the alternate screen, and restored after. */
export const background = enabled && truecolor ? "\x1b[48;2;8;8;8m" : "";

/**
 * A solid block of accent with the text knocked out of it.
 *
 * How selection is marked. Recolouring text alone is too quiet to find at a
 * glance in a list, and a block reads instantly at any size.
 *
 * It closes by restoring the canvas rather than emitting `\x1b[49m`, which would
 * reset to the terminal's own background and leave a hole in every row that
 * carries a selection — including the erase-to-end that follows it.
 */
export const invert: Paint = !enabled
  ? passthrough
  : truecolor
    ? (text) => `\x1b[48;2;167;139;250m\x1b[38;2;8;8;8m${text}\x1b[39m${background}`
    : (text) => styleText(["bgMagenta", "black"], text);

export const space = {
  gutter: "  ",
  indent: "    ",
};

/**
 * Three fixed gutter columns, two wide each, measured from the left edge:
 *
 *   col 0  turn anchor    › you, ◆ the agent
 *   col 2  tool anchor    ⏵
 *   col 4  result / rail  ⎿ a result, │ the agent still talking
 *
 * A line's kind is legible from its column and glyph before any colour is read.
 */
export const glyph = {
  user: "›",
  assistant: "◆",
  call: "⏵",
  result: "⎿",
  rail: "│",
  bullet: "•",
  dot: "·",
  arrow: "→",
  /** Marks the head of the suggestion strip. */
  caret: "❯",
  /** A steady dot beside the session's state. */
  status: "●",
  ring: "○",
  tick: "✓",
  /** Box drawing, for the tab bar. */
  vertical: "│",
  topLeft: "┌",
  topJoin: "┬",
  topRight: "┐",
  bottomLeft: "└",
  bottomJoin: "┴",
  bottomRight: "┘",
  rule: "─",
  bar: "│",
  prompt: "›",
  /** Half blocks — the alphabet the mascot is drawn in. */
  pixel: { both: "█", top: "▀", bottom: "▄", none: " " },
};

/** A two-column gutter cell: a glyph, then a space. */
export const cell = (mark: string, paint: Paint): string => `${paint(mark)} `;

/** Two columns of nothing, for a continuation carrying no rail. */
export const PAD = "  ";

/** Mouse reporting, SGR encoding. */
export const pointer = {
  on: "\x1b[?1000h\x1b[?1006h",
  off: "\x1b[?1006l\x1b[?1000l",
};

/** Cursor movement: the escape sequences that change where the next thing lands. */
export const cursor = {
  up: (rows: number): string => (rows > 0 ? `\x1b[${rows}A` : ""),
  clearBelow: "\x1b[0J",
  clearLine: "\r\x1b[2K",
  home: "\r",
  hide: "\x1b[?25l",
  show: "\x1b[?25h",
  /** Park the cursor and come back to it, so drawing elsewhere leaves no trace. */
  save: "\x1b7",
  restore: "\x1b8",
  /** "Where are you?" — answered on stdin as `\x1b[row;columnR`. */
  ask: "\x1b[6n",
};

/** A hairline, capped at a readable measure. */
export function rule(columns = process.stdout.columns): string {
  // A pty with no size reports 0, which `??` would let through. See layout.ts.
  const width = Math.max(8, Math.min((columns || 80) - space.gutter.length * 2, 64));
  return color.border(glyph.rule.repeat(width));
}
