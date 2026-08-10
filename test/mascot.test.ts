import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bannerFrames, bannerLapFrames, bannerLines } from "../src/ui/chrome.ts";
import { displayWidth } from "../src/ui/layout.ts";
import { arrival, BLINKING, draw, lap, ROWS, running, STANDING, WIDTH } from "../src/ui/mascot.ts";

/**
 * Every frame of a sequence must have the same number of rows.
 *
 * `play` rewinds by the row count of the frame it just drew, so a sequence that
 * changes height mid-way leaves it rewinding past the top of its own block and
 * smearing the animation down the terminal. Row *widths* are free to vary —
 * each frame erases to the bottom of the screen before it draws.
 */
function assertSameHeight(frames: string[][], label: string): void {
  const [first] = frames;
  assert.ok(first, `${label} has no frames`);
  for (const frame of frames) {
    assert.equal(frame.length, first.length, `${label} frames disagree on height`);
  }
}

/** Raw sprite frames additionally hold a fixed width, so text can sit beside them. */
function assertSameWidth(frames: string[][], label: string): void {
  for (const frame of frames) {
    for (const row of frame) assert.equal(displayWidth(row), WIDTH, `${label} row is not ${WIDTH} wide`);
  }
}

describe("draw", () => {
  test("stacks two pixel rows into one cell", () => {
    // Four columns covering every combination: both lit, top only, bottom only,
    // neither. Those are the only four glyphs half-block art is made of.
    assert.deepEqual(draw(["##..", "#.#."]), ["█▀▄ "]);
  });

  test("pads every row to the sprite width so a wordmark can sit beside it", () => {
    for (const row of draw(STANDING)) assert.equal(displayWidth(row), WIDTH);
  });

  test("clips rather than throws when the sprite is offset off the canvas", () => {
    for (const options of [{ offsetX: 99 }, { offsetX: -99 }, { offsetY: 99 }, { offsetY: -99 }]) {
      const gone = draw(STANDING, { rows: ROWS, ...options });
      assert.equal(gone.length, ROWS);
      assert.deepEqual([...new Set(gone.join(""))], [" "], `${JSON.stringify(options)} left something behind`);
    }
  });

  test("moves the picture the way the offset says", () => {
    const home = draw(STANDING, { rows: ROWS });
    const shifted = draw(STANDING, { rows: ROWS, offsetX: 3 });
    // Shifting right by three means column 3 of the new frame is column 0 of the
    // old one, with three fresh blank columns in front of it.
    assert.deepEqual(
      shifted.map((row) => row.slice(3)),
      home.map((row) => row.slice(0, -3)),
    );
  });
});

describe("the goat", () => {
  test("stands on four legs", () => {
    // The bottom row of the sprite is legs and nothing else: four runs of pixels
    // separated by gaps. Anything else means a leg went missing or two merged.
    const feet = STANDING.at(-1) ?? "";
    assert.equal(feet.match(/#+/g)?.length, 4);
  });

  test("keeps every leg attached to the body", () => {
    const body = STANDING[11] ?? "";
    for (const leg of [...(STANDING[12] ?? "").matchAll(/#+/g)]) {
      const hip = leg.index;
      assert.equal(body[hip], "#", `leg at column ${hip} starts off the body`);
    }
  });

  test("blinks by filling the eye back in, changing nothing else", () => {
    const differing = STANDING.filter((row, index) => row !== BLINKING[index]);
    assert.equal(differing.length, 2, "exactly the two eye rows differ");
    // The eye is the head's only hole, so shutting it leaves no gap behind.
    for (const row of differing) assert.ok(row.includes("#..#"));
  });

  test("runs without ever moving its body", () => {
    // The body is composed once and reused, so a stride cannot shift it. If this
    // fails, the legs and the animal have stopped being separate things.
    const torso = (sprite: readonly string[]): string[] => [...sprite.slice(0, 12)];
    for (let phase = 0; phase < 8; phase++) {
      assert.deepEqual(torso(running(phase)), torso(STANDING));
    }
  });

  test("changes its legs on every step of the stride", () => {
    const strides = new Set([0, 1, 2, 3].map((phase) => running(phase).slice(12).join("|")));
    assert.equal(strides.size, 4, "two steps of the stride are identical");
  });

  test("clamps a nonsense stride instead of throwing", () => {
    for (const phase of [-1, -99, Number.NaN, 1e6]) {
      assert.equal(running(phase).length, STANDING.length);
    }
  });
});

describe("arrival", () => {
  test("keeps every frame the same shape", () => {
    assertSameHeight(arrival(), "arrival");
    assertSameWidth(arrival(), "arrival");
  });

  test("ends with the goat home, standing, eyes open", () => {
    assert.deepEqual(arrival().at(-1), draw(STANDING, { rows: ROWS }));
  });

  test("starts with it mostly off the left edge", () => {
    const first = arrival().at(0) ?? [];
    const home = draw(STANDING, { rows: ROWS });
    assert.notDeepEqual(first, home);
    // It enters nose-first from the left, so what proves it has not arrived is
    // that the right half of the canvas — where it ends up — is still empty.
    for (const row of first) assert.equal(row.slice(WIDTH / 2).trim(), "");
  });

  test("decelerates into its mark rather than sliding at one speed", () => {
    // Measured off the rendered frames: the leftmost lit column per frame is how
    // far along the goat is, and those gaps have to shrink.
    const edges = arrival().map((frame) =>
      Math.min(...frame.map((row) => (row.search(/\S/) === -1 ? WIDTH : row.search(/\S/)))),
    );
    const steps = edges.slice(1, 8).map((edge, index) => (edges[index] ?? 0) - edge);
    assert.ok(
      steps.every((step, index) => index === 0 || step <= (steps[index - 1] ?? 0)),
      `steps should never grow: ${steps.join(", ")}`,
    );
  });
});

describe("lap", () => {
  test("keeps every frame the same shape", () => {
    assertSameHeight(lap(), "lap");
    assertSameWidth(lap(), "lap");
  });

  /**
   * The point of the lap: it runs inside the frame the goat already occupies, so
   * a click animates the banner on screen instead of drawing a second goat
   * somewhere else. Ending anywhere but home would leave the banner altered.
   */
  test("ends exactly where it started", () => {
    const home = draw(STANDING, { rows: ROWS });
    assert.deepEqual(lap().at(0), home);
    assert.deepEqual(lap().at(-1), home);
  });

  test("leaves the frame completely empty in the middle", () => {
    assert.ok(
      lap().some((frame) => frame.join("").trim() === ""),
      "the goat never actually left",
    );
  });

  test("moves one column per frame, which is as smooth as a cell gets", () => {
    // Measured on the way out: the goat's leading edge marches right by one.
    const edges = lap()
      .slice(0, WIDTH)
      .map((frame) => Math.min(...frame.map((row) => (row.search(/\S/) === -1 ? Infinity : row.search(/\S/)))))
      .filter((edge) => Number.isFinite(edge));

    for (const [index, edge] of edges.entries()) {
      if (index > 0) assert.equal(edge - (edges[index - 1] ?? 0), 1);
    }
  });
});

describe("bannerFrames", () => {
  test("sets the goat beside the wordmark when there is room", () => {
    // The last frame, because in the first few the goat is still running in.
    const frame = bannerFrames(3, 120).at(-1);
    assert.ok(frame?.some((row) => row.includes("mini-agent") && row.includes("█")));
  });

  test("stacks the goat above the wordmark when there is not", () => {
    const frame = bannerFrames(3, 50).at(-1);
    assert.ok(frame?.some((row) => row.includes("█")), "the goat is still there");
    assert.ok(
      !frame?.some((row) => row.includes("mini-agent") && row.includes("█")),
      "but no longer on the same row as the wordmark",
    );
  });

  test("drops the goat entirely rather than letting it push the text off screen", () => {
    const frame = bannerFrames(3, 24).at(-1);
    assert.ok(frame?.some((row) => row.includes("mini-agent")));
    assert.ok(!frame?.some((row) => row.includes("█")));
  });

  test("keeps every frame the same size, whatever the terminal width", () => {
    for (const columns of [120, 50, 24]) assertSameHeight(bannerFrames(3, columns), `banner at ${columns}`);
  });

  test("fits the lockup inside a standard 80-column terminal", () => {
    for (const row of bannerFrames(3, 80).at(-1) ?? []) assert.ok(displayWidth(row) <= 80);
  });
});

describe("bannerLapFrames", () => {
  const HINTS = bannerLines(3);
  const ABOUT = ["Greatest Of All Tokens", "3 skills · 2.2 KB of catalog", "bodies load only when asked", "a-model"];

  /**
   * The lap is repainted over rows that are already on screen, so it has to be
   * the same block as the banner in every layout. A frame taller or shorter than
   * what it is drawn over smears the animation down the terminal.
   */
  test("is exactly the same shape as the banner it replaces", () => {
    for (const columns of [120, 80, 50, 24]) {
      const settled = bannerFrames(3, columns).at(-1)?.length;
      for (const frame of bannerLapFrames(HINTS, ABOUT, columns)) {
        assert.equal(frame.length, settled, `lap and banner disagree at ${columns} columns`);
      }
    }
  });

  test("starts on the banner it was given and ends on the other one", () => {
    const frames = bannerLapFrames(HINTS, ABOUT, 120);
    assert.deepEqual(frames.at(0), bannerFrames(3, 120).at(-1), "the first frame must be what is already there");
    assert.ok(frames.at(-1)?.some((row) => row.includes("Greatest Of All Tokens")));
    assert.ok(!frames.at(-1)?.some((row) => row.includes("mini-agent")));
  });

  /** The swap is meant to be invisible: it happens while the goat is off-frame. */
  test("changes the words only while the goat is away", () => {
    const frames = bannerLapFrames(HINTS, ABOUT, 120);
    const swapped = frames.findIndex((frame) => frame.some((row) => row.includes("Greatest Of All Tokens")));
    assert.ok(swapped > 0);
    assert.equal(
      frames[swapped]?.some((row) => row.includes("█")),
      false,
      "the words changed while the goat was still on screen",
    );
  });

  test("goes back the other way, so poking twice returns the banner", () => {
    const there = bannerLapFrames(HINTS, ABOUT, 120);
    const back = bannerLapFrames(ABOUT, HINTS, 120);
    assert.deepEqual(back.at(-1), there.at(0), "a second poke must land exactly where the first started");
  });

  test("draws nothing at all when the terminal never had room for a goat", () => {
    assert.deepEqual(bannerLapFrames(HINTS, ABOUT, 24), []);
  });
});

