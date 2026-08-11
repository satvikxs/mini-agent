import { centre, column, divider, heading, keyRail, row, split, tabs, type Tab } from "./frame.ts";
import { displayWidth, truncate } from "./layout.ts";
import { fit } from "./ledger.ts";
import { cell, color, glyph, invert } from "./tokens.ts";

export type Pane = "home" | "agent";

export type Row = { id: string; name: string; state: string; badge: string };

export type Group = { title: string; rows: Row[] };

export type Layout = { width: number; left: string; listWidth: number; detailWidth: number; bodyHeight: number };

export type FrameProps = {
  columns: number;
  rows: number;
  view: Pane;
  groups: readonly Group[];
  selected: number;
  transcript: readonly string[];
  composer: { value: string; cursor: number; busy: boolean };
  palette: readonly string[] | null;
  status: string;
  keys: ReadonlyArray<readonly [string, string]>;
};

/** One session, so the bar is a title rather than a switch. */
const TABS: Tab[] = [{ key: "", label: "mini-agent" }];

/** Blank, three rows of tab bar, blank, composer, blank, three footer rows. */
const CHROME = 10;

/** Everything above the transcript: a blank, the three-row tab bar, another blank. */
const head = (width: number): string[] => ["", ...tabs(TABS, 0, width), ""];

/**
 * The frame row the transcript starts on, counting from 0.
 *
 * Exported because a click arrives as a screen row and has to be turned back
 * into a transcript row. A test draws a real frame and looks for the body at
 * this offset, so the constant cannot drift away from `head`.
 */
export const BODY_TOP = 5;

const PLACEHOLDER = "ask, or / for skills";

/** The driver fills against this, so a body that disagreed by a row cannot scroll the terminal. */
export function measureFrame(columns: number, rows: number, paletteRows: number): Layout {
  const { width, left } = column(columns);
  const listWidth = Math.max(18, Math.min(30, Math.floor(width * 0.34)));

  return {
    width,
    left,
    listWidth,
    // The 3 is split()'s default gap.
    detailWidth: width - listWidth - 3,
    bodyHeight: Math.max(3, rows - CHROME - paletteRows),
  };
}

/** Exactly `height` lines: short is padded, long is cut. */
const sized = (lines: readonly string[], height: number): string[] =>
  Array.from({ length: height }, (_, index) => lines[index] ?? "");

/** A name against a right-aligned badge — the turn count, or how long it has run. */
function rowText(item: Row, width: number): string {
  const badge = truncate(item.badge, Math.max(0, Math.floor(width / 3)));
  const name = truncate(item.name, Math.max(1, width - displayWidth(badge) - 1));
  const gap = width - displayWidth(name) - displayWidth(badge);
  return gap < 1 ? name : name + " ".repeat(gap) + badge;
}

/** The groups as one column: a heading, its rows, a blank line between groups. */
function listColumn(groups: readonly Group[], selected: number, width: number): string[] {
  const out: string[] = [];
  let index = 0;

  for (const group of groups) {
    if (out.length > 0) out.push("");
    out.push(heading(group.title));

    for (const item of group.rows) {
      // row() truncates and pads before it inverts, so it has to be handed plain
      // text — a styled string measures long and the selection block tears.
      out.push(row(rowText(item, width), width, index === selected));
      index += 1;
    }
  }

  return out;
}

/** The caret is drawn, not placed: the terminal's own cursor is hidden all session. Scrolls sideways, never wraps. */
export function composerRow(value: string, cursor: number, width: number, busy: boolean): string {
  const gutter = cell(glyph.user, busy ? color.muted : color.accent);
  const inner = Math.max(1, width - 2);

  // The placeholder carries the caret too, so the line does not jump left when
  // the first character lands.
  if (value === "") {
    const hint = truncate(PLACEHOLDER, inner);
    return gutter + invert(hint.slice(0, 1) || " ") + color.muted(hint.slice(1));
  }

  const at = Math.max(0, Math.min(cursor, value.length));
  const start = Math.max(0, at - inner + 2);
  const before = value.slice(start, at);
  const under = value.slice(at, at + 1) || " ";
  const after = truncate(value.slice(at + 1), Math.max(0, inner - displayWidth(before) - 1));

  return gutter + color.text(before) + invert(under) + color.text(after);
}

/** One screen, top to bottom, every line already sitting in the centred column. */
export function frame(props: FrameProps): string[] {
  const palette = props.palette ?? [];
  const { width, left, listWidth, bodyHeight } = measureFrame(props.columns, props.rows, palette.length);

  // The driver has already windowed and fitted the transcript to its measure.
  const transcript = [...props.transcript];
  const body =
    props.view === "home"
      ? split(listColumn(props.groups, props.selected, listWidth), transcript, listWidth)
      : transcript;

  const lines = [
    ...head(width),
    ...sized(body, bodyHeight),
    ...palette.map((line) => fit(line, width)),
    composerRow(props.composer.value, props.composer.cursor, width, props.composer.busy),
    "",
    centre(color.dim(props.status), width),
    divider(width),
    keyRail(props.keys, width),
  ];

  return sized(lines, props.rows).map((line) => fit(left + line, props.columns));
}
