import { displayWidth, measure, wrap, wrapHanging } from "./layout.ts";
import { color, glyph, rule, weight } from "./tokens.ts";

/** Inline spans. */
function renderInline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, (_, code: string) => color.muted(code))
    .replace(/\*\*([^*]+)\*\*/g, (_, body: string) => weight.strong(body))
    .replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, (_, body: string) => weight.emphasis(body))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, url: string) => `${label} ${color.dim(url)}`);
}

/** One line of Markdown, rendered. */
function renderLine(line: string, inFence: boolean): string[] {
  // Code is never wrapped. Breaking a command in half to fit a measure makes it
  // wrong, and a line long enough to overflow is information in itself.
  if (inFence) return [`${color.dim(glyph.bar)} ${color.muted(line)}`];

  const trimmed = line.trim();
  if (trimmed.length === 0) return [""];

  if (/^(?:-{3,}|_{3,}|\*{3,})$/.test(trimmed)) return [`${rule()}`];

  if (/^>\s?/.test(trimmed)) return [`${color.accent(trimmed)}`];

  const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
  if (heading) {
    const [, hashes = "", text = ""] = heading;
    // A top-level heading keeps its case and takes body weight; deeper ones step
    // back into small muted labels. Hierarchy by restraint, not by size.
    return hashes.length === 1
      ? [`${weight.strong(renderInline(text))}`]
      : [`${color.muted(weight.strong(text.toUpperCase()))}`];
  }

  // Leading whitespace carries the nesting level, so it has to be measured
  // before the line is trimmed. Markdown nests at two spaces per level.
  const indentWidth = (/^[ \t]*/.exec(line)?.[0] ?? "").replace(/\t/g, "  ").length;
  const nesting = "  ".repeat(Math.min(Math.floor(indentWidth / 2), 4));
  const width = measure();

  const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
  if (bullet) {
    return wrapHanging(`${nesting}${color.dim(glyph.dot)} `, renderInline(bullet[1] ?? ""), width);
  }

  const ordered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
  if (ordered) {
    return wrapHanging(`${nesting}${color.dim(`${ordered[1]}.`)} `, renderInline(ordered[2] ?? ""), width);
  }

  return wrap(renderInline(trimmed), width).map((part) => `${part}`);
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** `| a | b |` — a row. The alignment row (`|---|:--|`) is matched separately. */
const TABLE_ROW = /^\|(.+)\|\s*$/;
const TABLE_DIVIDER = /^\|[\s:|-]+\|\s*$/;

const splitRow = (line: string): string[] =>
  (TABLE_ROW.exec(line)?.[1] ?? "").split("|").map((cell) => cell.trim());

/** Lays out a Markdown table as aligned columns. */
function renderTable(rows: string[][]): string[] {
  const columns = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, index) =>
    Math.max(...rows.map((row) => displayWidth(row[index] ?? ""))),
  );

  const layOut = (row: string[], style: (text: string) => string): string => {
    const cells = widths.map((width, index) => {
      const cell = row[index] ?? "";
      return style(cell) + " ".repeat(Math.max(0, width - displayWidth(cell)));
    });
    return `${cells.join("   ").trimEnd()}`;
  };

  const [header = [], ...body] = rows;
  return [
    layOut(header, (text) => weight.strong(text)),
    `${color.dim(glyph.rule.repeat(widths.reduce((sum, w) => sum + w, 0) + (columns - 1) * 3))}`,
    ...body.map((row) => layOut(row, renderInline)),
  ];
}

export type MarkdownStream = {
  /** Feeds in a fragment. Complete lines are rendered; the rest waits. */
  push(chunk: string): void;
  /** Renders a half-written line now, without ending the stream. */
  flush(): void;
  /** Renders whatever is left in the buffer. Call once the answer is done. */
  end(): void;
};

export function createMarkdownStream(write: (text: string) => void): MarkdownStream {
  let pending = "";
  let inFence = false;
  // Suppresses the blank lines a model tends to open with, and collapses runs of
  // them, so vertical rhythm stays even.
  let lastWasBlank = true;
  let tableRows: string[][] | null = null;

  const writeLine = (rendered: string): void => {
    if (rendered.length === 0) {
      if (lastWasBlank) return;
      lastWasBlank = true;
      write("\n");
      return;
    }
    lastWasBlank = false;
    write(`${rendered}\n`);
  };

  /** Lays out and writes the table that has been collecting, if there is one. */
  const flushTable = (): void => {
    if (!tableRows) return;
    const rows = tableRows;
    tableRows = null;
    // A lone row with no body is not a table; treat it as ordinary text.
    if (rows.length < 2) rows.forEach((row) => writeLine(`${renderInline(row.join(" · "))}`));
    else renderTable(rows).forEach(writeLine);
  };

  const emit = (line: string): void => {
    if (/^\s*```/.test(line)) {
      flushTable();
      inFence = !inFence;
      return; // the fence markers themselves are never shown
    }

    if (!inFence) {
      const trimmed = line.trim();
      if (TABLE_DIVIDER.test(trimmed)) return; // the |---|---| row carries no content
      if (TABLE_ROW.test(trimmed)) {
        (tableRows ??= []).push(splitRow(trimmed));
        return;
      }
      flushTable();
    }

    renderLine(line, inFence).forEach(writeLine);
  };

  return {
    push(chunk) {
      pending += chunk;
      let breakAt = pending.indexOf("\n");
      while (breakAt !== -1) {
        emit(pending.slice(0, breakAt));
        pending = pending.slice(breakAt + 1);
        breakAt = pending.indexOf("\n");
      }
    },
    flush() {
      if (pending.length === 0) return;
      emit(pending);
      pending = "";
    },
    end() {
      if (pending.length > 0) {
        emit(pending);
        pending = "";
      }
      flushTable();
    },
  };
}
