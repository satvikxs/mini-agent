import { space } from "./tokens.ts";

/** Escape sequences occupy no columns, so they cannot count toward width. */
const ANSI = /\x1b\[[0-9;]*m/g;

export function displayWidth(text: string): number {
  return text.replace(ANSI, "").length;
}

/** How wide a line of body text may be. A narrow window wins; a wide one is capped. */
export function measure(columns = process.stdout.columns): number {
  // A pty with no size reports 0 — under `script`, in CI, in some multiplexers —
  // and `??` would let that through and collapse the text to a ribbon.
  const width = columns || 80;
  return Math.max(24, Math.min(width - space.gutter.length * 2, 76));
}

/** Wraps already-styled text on word boundaries. */
export function wrap(text: string, width: number): string[] {
  if (width <= 0 || displayWidth(text) <= width) return [text];

  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;

  for (const word of text.split(" ")) {
    const wordWidth = displayWidth(word);

    if (lineWidth === 0) {
      line = word;
      lineWidth = wordWidth;
      continue;
    }
    // A word longer than the measure (a URL, a path) is left to overflow rather
    // than broken somewhere meaningless.
    if (lineWidth + 1 + wordWidth <= width) {
      line += ` ${word}`;
      lineWidth += 1 + wordWidth;
      continue;
    }
    lines.push(line);
    line = word;
    lineWidth = wordWidth;
  }

  lines.push(line);
  return lines;
}

/**
 * The first row of a scrolling window, derived rather than carried.
 *
 * Storing a scroll offset means a resize or a re-filter can leave it pointing
 * off the end of a list that just got shorter. Computing it from the selection
 * every frame cannot: the window follows the cursor and clamps to the list.
 */
export function windowStart(selected: number, per: number, total: number): number {
  if (per >= total) return 0;
  const at = Math.min(Math.max(selected, 0), Math.max(0, total - 1));
  return Math.max(0, Math.min(at - per + 1, total - per));
}

/** Shortens plain text to fit. */
export function truncate(plain: string, width: number): string {
  if (width <= 0) return "";
  if (plain.length <= width) return plain;
  return width <= 1 ? "…" : `${plain.slice(0, width - 1)}…`;
}

/**
 * Turns a stream of fragments into whole lines of a given width.
 *
 * Reasoning arrives a few characters at a time and can run for paragraphs
 * without a single newline, so it has to be broken as it lands or nothing
 * appears until the model stops thinking. Only complete lines are emitted;
 * `end` releases whatever is left over.
 */
export function createWrapper(width: number, write: (line: string) => void) {
  let buffer = "";

  const drain = (final: boolean): void => {
    for (;;) {
      const breakAt = buffer.indexOf("\n");
      if (breakAt >= 0) {
        write(buffer.slice(0, breakAt));
        buffer = buffer.slice(breakAt + 1);
        continue;
      }
      if (buffer.length <= width) break;
      // Break on the last space that fits. A word longer than the column has
      // nowhere to break, so it is held rather than cut mid-token.
      const cut = buffer.lastIndexOf(" ", width);
      if (cut <= 0) break;
      write(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 1);
    }

    if (final && buffer.trim() !== "") {
      for (const row of wrap(buffer, width)) write(row);
      buffer = "";
    }
  };

  return {
    push(text: string): void {
      buffer += text;
      drain(false);
    },
    end(): void {
      drain(true);
    },
  };
}

/** One row carrying a left segment and a right-aligned one. Plain text is measured; styled renders. */
export function leftRight(
  leftPlain: string,
  leftStyled: string,
  rightPlain: string,
  rightStyled: string,
  width: number,
): string {
  const gap = width - displayWidth(leftPlain) - displayWidth(rightPlain);
  return gap < 1 ? leftStyled : leftStyled + " ".repeat(gap) + rightStyled;
}

/** Wraps with a hanging indent, so continuations align under the text. */
export function wrapHanging(lead: string, text: string, width: number): string[] {
  const indent = " ".repeat(displayWidth(lead));
  const [first, ...rest] = wrap(text, width - displayWidth(lead));
  return [`${lead}${first ?? ""}`, ...rest.map((line) => `${indent}${line}`)];
}
