import { displayWidth, truncate, wrap } from "./layout.ts";
import { color, glyph, invert } from "./tokens.ts";

/**
 * The shell every view is drawn into: a centred column of fixed width, a tab bar
 * across the top, and a key rail pinned to the bottom.
 *
 * The column does not stretch. A terminal opened full-screen on a wide display
 * would otherwise set body text to 200 columns, and the margins either side are
 * what make the thing read as an application rather than as output.
 */

/** How wide the app is allowed to be, and where it starts. */
export function column(columns = process.stdout.columns): { width: number; left: string } {
  const usable = Math.max(40, (columns || 80) - 4);
  const width = Math.min(usable, 88);
  return { width, left: " ".repeat(Math.max(0, Math.floor(((columns || 80) - width) / 2))) };
}

export type Tab = { key: string; label: string; badge?: string };

/**
 * The tab bar, drawn as boxes that share their edges.
 *
 * Each cell is `key label`, the key bright and the label stepped back, so what
 * to press is legible before the eye reads what it does. The active tab is the
 * only one whose label is at full strength.
 */
export function tabs(items: Tab[], active: number, width: number): string[] {
  const cells = items.map((tab) => {
    const text = [tab.key, tab.label, tab.badge].filter(Boolean).join(" ");
    return { tab, plain: ` ${text} ` };
  });

  // Every cell is the same width, so the bar divides the row evenly however many
  // there are. The remainder goes to the last cell rather than being dropped.
  const inner = width - (cells.length + 1);
  const each = Math.floor(inner / cells.length);
  const widths = cells.map((_, index) => (index === cells.length - 1 ? inner - each * (cells.length - 1) : each));

  const line = (start: string, join: string, end: string): string =>
    color.border(start + widths.map((w) => glyph.rule.repeat(w)).join(join) + end);

  const middle = cells
    .map(({ tab, plain }, index) => {
      const room = widths[index] ?? 0;
      const pad = Math.max(0, room - displayWidth(plain));
      const lead = " ".repeat(Math.floor(pad / 2));
      const tail = " ".repeat(pad - lead.length);
      const paint = index === active ? color.text : color.muted;
      const label = [tab.label, tab.badge].filter(Boolean).join(" ");
      const body = tab.key ? `${color.text(tab.key)} ${paint(label)}` : color.text(label);
      return `${lead} ${body} ${tail}`.slice(0, room + (body.length - displayWidth(body)));
    })
    .join(color.border(glyph.vertical));

  return [
    line(glyph.topLeft, glyph.topJoin, glyph.topRight),
    color.border(glyph.vertical) + middle + color.border(glyph.vertical),
    line(glyph.bottomLeft, glyph.bottomJoin, glyph.bottomRight),
  ];
}

/** A section heading in the left column: `~ running ~`. */
export const heading = (text: string): string => color.text(`~ ${text} ~`);

/**
 * A row in a list. The selected one is a solid block of accent with the text
 * knocked out of it — a colour swap alone is too quiet to find at a glance.
 */
export function row(text: string, width: number, selected: boolean): string {
  const fitted = truncate(text, width);
  return selected ? invert(fitted.padEnd(width)) : color.muted(fitted);
}

/** Sets two columns side by side, padding the shorter one so the pair stays square. */
export function split(left: string[], right: string[], leftWidth: number, gap = 3): string[] {
  const height = Math.max(left.length, right.length);
  const pad = " ".repeat(gap);

  return Array.from({ length: height }, (_, index) => {
    const l = left[index] ?? "";
    const r = right[index] ?? "";
    const fill = " ".repeat(Math.max(0, leftWidth - displayWidth(l)));
    return `${l}${fill}${pad}${r}`.trimEnd();
  });
}

/** Body copy for the right column, wrapped at its own measure. */
export const prose = (text: string, width: number): string[] =>
  text.split("\n").flatMap((line) => wrap(color.muted(line), width));

/** Centres a line inside the column. */
export function centre(text: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - displayWidth(text)) / 2));
  return " ".repeat(pad) + text;
}

/** The rail along the bottom: what you can press, keys bright and labels stepped back. */
export function keyRail(pairs: ReadonlyArray<readonly [string, string]>, width: number): string {
  const text = pairs.map(([key, label]) => `${color.text(key)} ${color.muted(label)}`).join("   ");
  return centre(text, width);
}

/** A press-this button: accent block, text knocked out, the key beside it. */
export const button = (label: string, key: string): string =>
  `${invert(` ${label} `)} ${color.muted(key)}`;

/** A full-width hairline, for the division above the key rail. */
export const divider = (width: number): string => color.border(glyph.rule.repeat(width));
