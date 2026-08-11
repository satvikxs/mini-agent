import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { displayWidth } from "../src/ui/layout.ts";
import { BODY_TOP, composerRow, frame, measureFrame, type FrameProps } from "../src/ui/views.ts";

const props = (over: Partial<FrameProps> = {}): FrameProps => ({
  columns: 100,
  rows: 30,
  view: "home",
  groups: [{ title: "running", rows: [{ id: "a1", name: "auth migration", state: "running", badge: "1.2s" }] }],
  selected: 0,
  transcript: ["› hello"],
  composer: { value: "", cursor: 0, busy: false },
  palette: null,
  status: "1 agent",
  keys: [["↵", "send"]],
  ...over,
});

describe("measureFrame", () => {
  test("gives the palette its rows out of the body, not out of the terminal", () => {
    const bare = measureFrame(100, 30, 0);
    assert.equal(measureFrame(100, 30, 7).bodyHeight, bare.bodyHeight - 7);
  });

  test("leaves the list and the detail column summing to the width", () => {
    const { width, listWidth, detailWidth } = measureFrame(100, 30, 0);
    assert.equal(listWidth + detailWidth + 3, width);
  });

  test("keeps a body to read in a terminal with no room for one", () => {
    assert.equal(measureFrame(40, 6, 0).bodyHeight, 3);
  });
});

describe("frame", () => {
  test("fills the terminal exactly, in every view and at every size", () => {
    for (const [columns, rows] of [[40, 12], [80, 24], [200, 60]] as const) {
      for (const view of ["home", "agent"] as const) {
        const lines = frame(props({ columns, rows, view }));
        assert.equal(lines.length, rows);
        for (const line of lines) assert.ok(displayWidth(line) <= columns, `${displayWidth(line)} > ${columns}`);
      }
    }
  });

  test("keeps the column centred rather than stretching it", () => {
    const [, top = ""] = frame(props({ columns: 200 }));
    assert.ok(top.startsWith("  ".repeat(20)));
  });

  test("carries nothing but colour, so no line can move the cursor", () => {
    for (const line of frame(props({ palette: ["find 1 command", "❯ /new"] }))) {
      assert.doesNotMatch(line.replace(/\x1b\[[0-9;]*m/g, ""), /\x1b/);
    }
  });

  test("starts the transcript at BODY_TOP, which is where clicks are mapped from", () => {
    // A click arrives as a screen row and is turned back into a transcript row
    // by subtracting this. If the chrome above the body ever gains or loses a
    // row, every click lands on the wrong line — so it is pinned to a real frame.
    const marker = "› the first row of the body";
    for (const [columns, rows] of [[40, 12], [80, 24], [200, 60]] as const) {
      const lines = frame(props({ columns, rows, view: "agent", transcript: [marker] }));
      const plain = (lines[BODY_TOP] ?? "").replace(/\x1b\[[0-9;]*m/g, "");
      assert.ok(plain.includes(marker), `${columns}×${rows}: found "${plain.trim()}"`);
    }
  });
});

describe("composerRow", () => {
  test("carries the caret on the placeholder, so the line does not jump", () => {
    assert.match(composerRow("", 0, 40, false).replace(/\x1b\[[0-9;]*m/g, ""), /^› ask, or \/ for skills/);
  });

  test("scrolls sideways rather than wrapping", () => {
    for (const width of [10, 40, 80]) {
      const line = composerRow("x".repeat(300), 300, width, false);
      assert.ok(displayWidth(line) <= width);
    }
  });

  test("keeps the caret in view wherever it is in the buffer", () => {
    const value = "abcdefghij";
    for (const at of [0, 5, 10]) assert.ok(displayWidth(composerRow(value, at, 6, false)) <= 6);
  });
});
