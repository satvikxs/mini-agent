import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { separate } from "../src/ui/pointer.ts";

/** `\x1b[<button;column;rowM` down, `m` up. */
const press = (button: number, column: number, row: number): string => `\x1b[<${button};${column};${row}M`;
const release = (button: number, column: number, row: number): string => `\x1b[<${button};${column};${row}m`;

describe("separate", () => {
  test("leaves ordinary typing completely alone", () => {
    for (const typed of ["hello", "", "goat\r", "\x1b[A", "\x03", "\x04", "café ☕", "\x1b[200~paste\x1b[201~"]) {
      assert.deepEqual(separate(typed), { keys: typed, clicks: [], cursor: [] });
    }
  });

  test("catches the terminal answering where the cursor is", () => {
    // How the goat finds the banner. If this reached readline it would type
    // `12;40R` into the prompt every time it was asked.
    const split = separate("\x1b[12;40R");
    assert.deepEqual(split.cursor, [{ row: 12, column: 40 }]);
    assert.equal(split.keys, "");
  });

  test("tells a cursor report apart from typing that looks like one", () => {
    assert.deepEqual(separate("12;40R"), { keys: "12;40R", clicks: [], cursor: [] });
  });

  test("takes the click out and reports where it landed", () => {
    const split = separate(press(0, 42, 7) + release(0, 42, 7));
    assert.deepEqual(split.clicks, [{ column: 42, row: 7 }]);
    assert.equal(split.keys, "", "no part of the report may reach readline");
  });

  /**
   * The failure this exists to prevent: without filtering, readline strips the
   * escape and types the rest of the report into your prompt, so clicking while
   * writing `world` leaves you with `0;42;7M0;42;7mworld`.
   */
  test("does not corrupt a line being typed around it", () => {
    const split = separate(`hello ${press(0, 42, 7)}${release(0, 42, 7)}world`);
    assert.equal(split.keys, "hello world");
    assert.equal(split.clicks.length, 1);
  });

  test("keeps keystrokes in order when several clicks are interleaved", () => {
    const split = separate(`a${press(0, 1, 1)}b${press(0, 2, 2)}c`);
    assert.equal(split.keys, "abc");
    assert.deepEqual(split.clicks, [
      { column: 1, row: 1 },
      { column: 2, row: 2 },
    ]);
  });

  test("reports a press once, not again on release", () => {
    assert.equal(separate(press(0, 5, 5) + release(0, 5, 5)).clicks.length, 1);
  });

  test("swallows the scroll wheel without calling it a click", () => {
    // Buttons 64 and 65 are wheel up and wheel down. Scrolling is not clicking,
    // but the bytes still must not reach the prompt.
    const split = separate(press(64, 10, 10) + press(65, 10, 10));
    assert.deepEqual(split.clicks, []);
    assert.equal(split.keys, "");
  });

  test("handles coordinates past the 223-column limit of the old encoding", () => {
    // The reason for asking for SGR reporting in the first place.
    assert.deepEqual(separate(press(0, 400, 120)).clicks, [{ column: 400, row: 120 }]);
  });

  test("passes through a report that is only half arrived", () => {
    // Chunk boundaries fall wherever the terminal put them. A partial report is
    // not a click yet; dropping it here would lose the bytes that complete it.
    const split = separate("\x1b[<0;42");
    assert.equal(split.keys, "\x1b[<0;42");
    assert.deepEqual(split.clicks, []);
  });
});
