import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { displayWidth } from "../src/ui/layout.ts";
import {
  fit,
  ledgerLines,
  ledgerView,
  maxScroll,
  sourceAt,
  windowLines,
  windowRange,
  type Entry,
} from "../src/ui/ledger.ts";

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

describe("pointing at the transcript", () => {
  const LONG = Array.from({ length: 12 }, (_, at) => `reasoning line number ${at}`).join(" ");

  const entries: Entry[] = [
    { kind: "user", text: "how do I test?" },
    { kind: "thinking", text: LONG },
    { kind: "answer", text: "npm test" },
  ];

  /** What the driver does with a click: pane row in, entry out. */
  const hit = (row: number, height: number, scrollUp = 0, open?: Set<Entry>): Entry | null => {
    const view = ledgerView(entries, 40, undefined, open);
    const at = sourceAt(windowRange(view.lines.length, height, scrollUp), row);
    return at < 0 ? null : (view.owners[at] ?? null);
  };

  test("every row agrees with the row windowLines drew", () => {
    // The two are separate readings of the same geometry, so a drift between
    // them would point a click at the line above or below the one clicked.
    const view = ledgerView(entries, 40);
    for (const height of [3, 5, 12, 40]) {
      for (const up of [0, 1, 4]) {
        const drawn = windowLines(view.lines, height, up).map(plain);
        const range = windowRange(view.lines.length, height, up);
        for (let row = 0; row < height; row += 1) {
          const at = sourceAt(range, row);
          if (at < 0) continue;
          assert.equal(drawn[row], plain(view.lines[at] ?? ""), `row ${row} at height ${height}, up ${up}`);
        }
      }
    }
  });

  test("finds the reasoning entry under a folded row", () => {
    const view = ledgerView(entries, 40);
    const folded = view.lines.findIndex((_, at) => view.owners[at] !== null);
    assert.ok(folded >= 0, "the transcript has a reasoning row");
    // Tall enough that the whole transcript fits, so padding is all that shifts it.
    const range = windowRange(view.lines.length, 40, 0);
    assert.equal(hit(range.pad + folded, 40), entries[1]);
  });

  test("an open block answers on any of its rows, not just the first", () => {
    const open = new Set<Entry>([entries[1]!]);
    const view = ledgerView(entries, 40, undefined, open);
    const rows = view.owners.filter((owner) => owner === entries[1]).length;
    assert.ok(rows > 1, `an unfolded block draws ${rows} rows`);

    const range = windowRange(view.lines.length, 40, 0);
    const owned = view.owners.flatMap((owner, at) => (owner === entries[1] ? [at] : []));
    for (const at of owned) assert.equal(hit(range.pad + at, 40, 0, open), entries[1]);
  });

  test("the answer and the blank rows around it are not targets", () => {
    const view = ledgerView(entries, 40);
    const range = windowRange(view.lines.length, 40, 0);
    for (const [at, line] of view.lines.entries()) {
      if (view.owners[at] !== null) continue;
      assert.equal(hit(range.pad + at, 40), null, `"${plain(line)}" should not be clickable`);
    }
  });

  test("the padding above a short transcript is not a target", () => {
    // A click on the empty floor of a tall pane must not reach the first row.
    assert.equal(hit(0, 40), null);
  });

  test("the hint row is not a target", () => {
    const view = ledgerView(entries, 40);
    const range = windowRange(view.lines.length, 4, 3);
    assert.ok(range.hint, "scrolled up in a short pane, so the hint is drawn");
    assert.equal(sourceAt(range, range.pad + range.count), -1);
  });

  test("a live answer belongs to nothing", () => {
    const view = ledgerView([], 40, "half a sentence");
    assert.ok(view.lines.length > 0);
    assert.deepEqual([...new Set(view.owners)], [null]);
  });

  test("owners and lines stay the same length", () => {
    for (const width of [24, 40, 80]) {
      for (const live of [undefined, "streaming"]) {
        const view = ledgerView(entries, width, live);
        assert.equal(view.owners.length, view.lines.length, `width ${width}`);
      }
    }
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

  /** The reasoning entry, opened. */
  const unfolded = new Set<Entry>([entries[1]!]);

  test("names what unfolds it when the row can spare the room", () => {
    // The count alone reads as a control without saying what to do with it, so a
    // wide pane says the block can be clicked.
    assert.match(folded(80), /\+\d+ more · click$/);
  });

  test("drops the hint rather than the preview when the pane is narrow", () => {
    // A fold that says `click` and shows four words of reasoning has spent the
    // line explaining itself instead of being useful.
    const narrow = folded(40);
    assert.doesNotMatch(narrow, /click/);
    assert.match(narrow, /\+\d+ more$/);
    assert.match(narrow, /The user is asking/);
  });

  test("unfolds to every line when opened", () => {
    const folded = ledgerLines(entries, 40);
    const open = ledgerLines(entries, 40, undefined, unfolded);

    assert.ok(open.length > folded.length, `${open.length} should exceed ${folded.length}`);
    const text = open.map(plain).join(" ");
    for (const phrase of ["read package.json", "report the exact script"]) {
      assert.ok(text.includes(phrase), phrase);
    }
  });

  test("opens only the block that was clicked", () => {
    // The fold is per entry now, so a second block of reasoning in the same
    // transcript stays folded while the first is open.
    const two: Entry[] = [
      { kind: "thinking", text: LONG },
      { kind: "answer", text: "npm test" },
      { kind: "thinking", text: LONG },
    ];

    const rows = ledgerLines(two, 80, undefined, new Set([two[0]!])).map(plain);
    assert.equal(rows.filter((row) => /\+\d+ more · click$/.test(row)).length, 1);
  });

  test("re-renders when the fold is toggled, rather than serving the cached shape", () => {
    // The rendered rows are cached per entry; a cache keyed on width alone
    // would hand back the folded rows forever once they had been drawn.
    const first = ledgerLines(entries, 40).map(plain);
    const opened = ledgerLines(entries, 40, undefined, unfolded).map(plain);
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
    for (const open of [new Set<Entry>(), unfolded]) {
      for (const width of [24, 40, 80]) {
        for (const line of ledgerLines(entries, width, undefined, open)) {
          assert.ok(displayWidth(line) <= width, `${displayWidth(line)} > ${width}`);
        }
      }
    }
  });
});
