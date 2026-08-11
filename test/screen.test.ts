import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeKeys, type Key } from "../src/ui/screen.ts";

const brief = (key: Key): string =>
  `${key.name}${key.text ? `:${key.text}` : ""}${key.ctrl ? "^" : ""}${key.meta ? "M" : ""}${key.shift ? "S" : ""}`;

const read = (text: string): string[] => decodeKeys(text).map(brief);

describe("decodeKeys", () => {
  test("reads a run of printable characters as one event", () => {
    assert.deepEqual(read("hello"), ["char:hello"]);
  });

  test("reads arrows in both the CSI and the SS3 form", () => {
    assert.deepEqual(read("\x1b[A\x1bOB"), ["up", "down"]);
  });

  test("reads the modifier parameter", () => {
    assert.deepEqual(read("\x1b[1;5C"), ["right^"]);
    assert.deepEqual(read("\x1b[Z"), ["tabS"]);
  });

  test("reads a control byte as its letter", () => {
    assert.deepEqual(read("\x03"), ["char:c^"]);
  });

  test("reads alt as meta on the key it was held over", () => {
    assert.deepEqual(read("\x1bb"), ["char:bM"]);
    assert.deepEqual(read("\x1b\x7f"), ["backspaceM"]);
  });

  test("splits a run of backspaces, since one erases one character", () => {
    assert.deepEqual(read("\x7f\x7f"), ["backspace", "backspace"]);
  });

  test("takes a bracketed paste as a single event, newlines and all", () => {
    assert.deepEqual(read("\x1b[200~a\r\nb\x1b[201~"), ["char:a\nb"]);
  });

  test("holds an unterminated paste rather than typing half of it", () => {
    assert.deepEqual(read("\x1b[200~half"), []);
  });

  test("keeps the wheel and the press, and swallows every other mouse report", () => {
    // A release repeats what the press already said, and a drag arrives with 32
    // added to the button; neither is a second thing the reader did.
    assert.deepEqual(
      read("\x1b[<64;1;1M\x1b[<0;1;1M\x1b[<0;1;1m\x1b[<32;4;9M\x1b[<65;1;1M"),
      ["wheelup", "click", "wheeldown"],
    );
  });

  test("carries where the click landed", () => {
    const [click] = decodeKeys("\x1b[<0;12;7M");
    // Column then row, exactly as the terminal orders them, and 1-based.
    assert.equal(click?.column, 12);
    assert.equal(click?.row, 7);
  });

  test("swallows the terminal's own replies", () => {
    assert.deepEqual(read("\x1b[6;20R"), []);
  });

  test("reads a bare escape only when nothing follows it", () => {
    assert.deepEqual(read("\x1b"), ["escape"]);
  });
});
