import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { displayWidth } from "../src/ui/layout.ts";
import {
  authorisesRun,
  commandArgs,
  commandQuery,
  isPaletteOpen,
  moveSelection,
  paletteHeight,
  paletteRows,
  rankCandidates,
  skillCandidates,
  type Candidate,
} from "../src/ui/palette.ts";

const pool: Candidate[] = [
  { id: "a", label: "/welcome-me", meta: "greets a new teammate", run: "/welcome-me" },
  { id: "b", label: "/writing-plans", meta: "writes an implementation plan", run: "/writing-plans" },
  { id: "c", label: "/new", meta: "open another agent", run: "/new" },
];

const labels = (term: string): string[] => rankCandidates(term, pool).map((row) => row.candidate.label);

describe("the palette's open state", () => {
  test("is derived from the buffer, so backspacing the slash closes it", () => {
    assert.equal(isPaletteOpen("/we"), true);
    assert.equal(isPaletteOpen("we"), false);
  });

  test("stops the query at the first space, so an argument does not re-rank", () => {
    assert.equal(commandQuery("/welcome-me and keep it short"), "welcome-me");
    assert.equal(commandArgs("/welcome-me and keep it short"), "and keep it short");
    assert.equal(commandArgs("/welcome-me"), "");
  });
});

describe("rankCandidates", () => {
  test("reproduces the pool in registry order on an empty term", () => {
    assert.deepEqual(labels(""), pool.map((candidate) => candidate.label));
  });

  test("puts a name typed out in full first", () => {
    assert.equal(labels("new")[0], "/new");
  });

  test("matches a subsequence", () => {
    assert.deepEqual(labels("wrp"), ["/writing-plans"]);
  });

  test("ranks a description hit below a name hit and reports no positions for it", () => {
    const rows = rankCandidates("teammate", pool);
    assert.deepEqual(rows.map((row) => row.candidate.label), ["/welcome-me"]);
    assert.deepEqual(rows[0]?.positions, []);
  });

  test("drops what matches nothing", () => {
    assert.deepEqual(labels("zzzz"), []);
  });

  test("obeys the limit", () => {
    assert.equal(rankCandidates("", pool, 2).length, 2);
  });
});

describe("authorisesRun", () => {
  test("lets a literal prefix of a command run it", () => {
    assert.equal(authorisesRun("new", rankCandidates("new", pool)[0]), true);
  });

  test("refuses a prompt that only happens to fuzzy-match", () => {
    assert.equal(authorisesRun("tmp/foo is broken", rankCandidates("tmp/foo is broken", pool)[0]), false);
  });

  test("refuses a bare slash", () => {
    assert.equal(authorisesRun("", rankCandidates("", pool)[0]), false);
  });
});

describe("moveSelection", () => {
  test("wraps on the arrows", () => {
    assert.equal(moveSelection(0, -1, 3), 2);
    assert.equal(moveSelection(2, 1, 3), 0);
  });

  test("clamps on a page, so it never teleports across the list", () => {
    assert.equal(moveSelection(0, -6, 3), 0);
    assert.equal(moveSelection(0, 6, 3), 2);
  });

  test("degrades a stale index rather than throwing", () => {
    assert.equal(moveSelection(99, 1, 3), 0);
    assert.equal(moveSelection(0, 1, 0), 0);
  });
});

describe("paletteRows", () => {
  test("returns exactly the height it was billed for", () => {
    for (const term of ["", "w", "zzzz"]) {
      const rows = rankCandidates(term, pool);
      assert.equal(paletteRows(rows, term, 0, 60, 2).length, paletteHeight(rows.length, 2));
    }
  });

  test("never draws wider than the panel", () => {
    for (const width of [20, 40, 60]) {
      for (const line of paletteRows(rankCandidates("", pool), "", 1, width, 6)) {
        assert.ok(displayWidth(line) <= width);
      }
    }
  });

  test("strips control characters out of third-party frontmatter", () => {
    const hostile: Candidate[] = [{ id: "x", label: "/evil31m", meta: "​hidden", run: "/evil" }];
    for (const line of paletteRows(rankCandidates("", hostile), "", 0, 60, 6)) {
      assert.doesNotMatch(line.replace(/\x1b\[[0-9;]*m/g, ""), /[\x00-\x1f\x7f-\x9f]/);
    }
  });

  test("says so when nothing matches", () => {
    assert.match(paletteRows([], "zzzz", 0, 60, 6)[1] ?? "", /no matches for zzzz/);
  });
});

describe("skillCandidates", () => {
  test("takes the first sentence, since a description is written for the model", () => {
    const [candidate] = skillCandidates([
      { name: "welcome-me", description: "Greets a new teammate. Then goes on at length about it." },
    ]);
    assert.equal(candidate?.label, "/welcome-me");
    assert.equal(candidate?.meta, "greets a new teammate");
    assert.equal(candidate?.run, "/welcome-me");
  });
});
