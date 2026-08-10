import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { displayWidth, measure, wrap, wrapHanging } from "../src/ui/layout.ts";

describe("measure", () => {
  test("caps at a readable width however wide the terminal is", () => {
    assert.equal(measure(200), 76);
  });

  test("follows a narrow terminal down", () => {
    assert.equal(measure(50), 46);
  });

  /** A pty with no size reports 0 — under `script`, in CI, in a multiplexer. */
  test("treats a zero-width terminal as unknown rather than as zero", () => {
    assert.equal(measure(0), 76);
    assert.equal(measure(undefined), 76);
  });

  test("never collapses below something readable", () => {
    assert.equal(measure(10), 24);
  });
});

describe("displayWidth", () => {
  test("ignores escape sequences", () => {
    assert.equal(displayWidth("\x1b[1mbold\x1b[22m"), 4);
  });
});

describe("wrap", () => {
  test("breaks on word boundaries at the given width", () => {
    assert.deepEqual(wrap("one two three four", 9), ["one two", "three", "four"]);
  });

  test("leaves text that already fits alone", () => {
    assert.deepEqual(wrap("short", 40), ["short"]);
  });

  test("measures by visible width, not by byte count", () => {
    // 12 visible characters inside 30 bytes of escape sequences.
    const styled = "\x1b[1mstyled text\x1b[22m";
    assert.deepEqual(wrap(styled, 40), [styled]);
  });

  test("lets a word longer than the measure overflow rather than breaking it", () => {
    assert.deepEqual(wrap("a https://example.com/very/long/path b", 10), [
      "a",
      "https://example.com/very/long/path",
      "b",
    ]);
  });
});

describe("wrapHanging", () => {
  test("aligns continuation lines under the text, not under the marker", () => {
    assert.deepEqual(wrapHanging("· ", "one two three four", 11), ["· one two", "  three", "  four"]);
  });
});
