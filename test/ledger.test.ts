import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { displayWidth } from "../src/ui/layout.ts";
import { fit, ledgerLines, maxScroll, windowLines, type Entry } from "../src/ui/ledger.ts";

const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();

describe("ledgerLines", () => {
  test("anchors each kind to its own gutter column", () => {
    const entries: Entry[] = [
      { kind: "user", text: "hello" },
      { kind: "tool", label: "welcome-me", brief: "", metric: "skill" },
      { kind: "error", text: "boom" },
    ];
    assert.deepEqual(ledgerLines(entries, 40).map(plain), [
      "› hello",
      "",
      "  ⏵ welcome-me                     skill",
      "",
      "    ⎿ boom",
    ]);
  });

  test("never draws wider than the pane it was given", () => {
    const entries: Entry[] = [{ kind: "user", text: "word ".repeat(40) }];
    for (const width of [8, 20, 76]) {
      for (const line of ledgerLines(entries, width)) assert.ok(displayWidth(line) <= width);
    }
  });

  test("draws streaming text exactly as the settled answer will be", () => {
    const live = ledgerLines([], 40, "half a sentence");
    const settled = ledgerLines([{ kind: "answer", text: "half a sentence" }], 40);
    assert.deepEqual(live, settled);
  });

  test("keeps every row of a note, since /help arrives as one", () => {
    assert.equal(ledgerLines([{ kind: "note", text: "one\ntwo\nthree" }], 40).length, 3);
  });

  test("draws nothing, and earns no separator, for an entry with no text", () => {
    const entries: Entry[] = [{ kind: "user", text: "hi" }, { kind: "note", text: "  " }];
    assert.deepEqual(ledgerLines(entries, 40).map(plain), ["› hi"]);
  });

  test("cuts a failure off rather than wrapping it across the pane", () => {
    const text = Array.from({ length: 20 }, (_, at) => `line ${at}`).join("\n");
    assert.equal(ledgerLines([{ kind: "error", text }], 40).length, 5);
  });
});

describe("windowLines", () => {
  const lines = Array.from({ length: 20 }, (_, at) => `row ${at}`);

  test("fills the pane exactly, whatever the scroll", () => {
    for (const height of [1, 4, 40]) {
      for (const up of [0, 3, 999]) assert.equal(windowLines(lines, height, up).length, height);
    }
  });

  test("sits on the floor of a pane it cannot fill", () => {
    assert.deepEqual(windowLines(["a"], 3, 0), ["", "", "a"]);
  });

  test("shows the tail when it is not scrolled", () => {
    assert.deepEqual(windowLines(lines, 3, 0), ["row 17", "row 18", "row 19"]);
  });

  test("spends a row on the count of what is still below", () => {
    const rows = windowLines(lines, 4, 10).map(plain);
    assert.deepEqual(rows.slice(0, 3), ["row 7", "row 8", "row 9"]);
    assert.match(rows[3] ?? "", /10 more below/);
  });

  test("clamps a scroll past the head", () => {
    assert.deepEqual(windowLines(lines, 3, 999).map(plain).slice(0, 2), ["row 0", "row 1"]);
  });
});

describe("maxScroll", () => {
  test("is nothing while the transcript fits", () => {
    assert.equal(maxScroll(3, 10), 0);
  });

  test("is everything that does not fit", () => {
    assert.equal(maxScroll(30, 10), 20);
  });
});

describe("fit", () => {
  test("counts escape sequences as no width", () => {
    assert.equal(displayWidth(fit("\x1b[31mabcdef\x1b[39m", 3)), 3);
  });

  test("closes a cut string so its colour cannot bleed", () => {
    assert.ok(fit("\x1b[31mabcdef", 3).endsWith("\x1b[0m"));
  });

  test("leaves unpainted text unpainted", () => {
    assert.equal(fit("abcdef", 3), "abc");
  });
});

describe("folding the model's reasoning", () => {
  const LONG = [
    "The user is asking about the build.",
    "I should read package.json first.",
    "Then report the exact script.",
  ].join(" ");

  const entries: Entry[] = [
    { kind: "user", text: "how do I test?" },
    { kind: "thinking", text: LONG },
    { kind: "answer", text: "npm test" },
  ];

  const folded = (width: number): string =>
    ledgerLines(entries, width).map(plain).find((row) => row.startsWith("·")) ?? "";

  test("folds to one line, and says how much it is hiding", () => {
    const rows = ledgerLines(entries, 40).map(plain).filter((row) => row.startsWith("·"));
    assert.equal(rows.length, 1, "reasoning takes exactly one row when folded");
    assert.match(rows[0]!, /\+\d+ more/);
    // The opening line is the one that says what the model decided to do, so
    // that is the line worth keeping.
    assert.match(rows[0]!, /The user is asking/);
  });

  test("names what unfolds it when the row can spare the room", () => {
    // The count alone reads as a control there is nothing to click, so a wide
    // pane says which command opens it.
    assert.match(folded(80), /\+\d+ more · \/thinking$/);
  });

  test("drops the hint rather than the preview when the pane is narrow", () => {
    // A fold that names `/thinking` and shows four words of reasoning has spent
    // the line explaining itself instead of being useful.
    const narrow = folded(40);
    assert.doesNotMatch(narrow, /\/thinking/);
    assert.match(narrow, /\+\d+ more$/);
    assert.match(narrow, /The user is asking/);
  });

  test("unfolds to every line when opened", () => {
    const folded = ledgerLines(entries, 40);
    const open = ledgerLines(entries, 40, undefined, true);

    assert.ok(open.length > folded.length, `${open.length} should exceed ${folded.length}`);
    const text = open.map(plain).join(" ");
    for (const phrase of ["read package.json", "report the exact script"]) {
      assert.ok(text.includes(phrase), phrase);
    }
  });

  test("re-renders when the fold is toggled, rather than serving the cached shape", () => {
    // The rendered rows are cached per entry; a cache keyed on width alone
    // would hand back the folded rows forever once they had been drawn.
    const first = ledgerLines(entries, 40).map(plain);
    const opened = ledgerLines(entries, 40, undefined, true).map(plain);
    const again = ledgerLines(entries, 40).map(plain);

    assert.notDeepEqual(first, opened);
    assert.deepEqual(first, again, "folding back gives the folded rows again");
  });

  test("a single-line thought needs no count", () => {
    const short: Entry[] = [{ kind: "thinking", text: "Short." }];
    const rows = ledgerLines(short, 40).map(plain);
    assert.deepEqual(rows, ["· Short."]);
  });

  test("stays inside the pane at either setting", () => {
    for (const open of [false, true]) {
      for (const width of [24, 40, 80]) {
        for (const line of ledgerLines(entries, width, undefined, open)) {
          assert.ok(displayWidth(line) <= width, `${displayWidth(line)} > ${width}`);
        }
      }
    }
  });
});
