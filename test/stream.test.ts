import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createSmoother } from "../src/ui/stream.ts";

/** A clock the test drives, so pacing is deterministic. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let at = 1000;
  return { now: () => at, advance: (ms) => void (at += ms) };
}

describe("smoother", () => {
  test("holds everything until it is drained", () => {
    const { now } = clock();
    const smoother = createSmoother(now);
    smoother.push("hello world");
    assert.equal(smoother.pending, 11);
  });

  test("emits nothing when no time has passed", () => {
    const { now } = clock();
    const smoother = createSmoother(now);
    smoother.push("hello");
    assert.equal(smoother.drain(), "");
  });

  test("spreads one arrival across many frames", () => {
    const { now, advance } = clock();
    const smoother = createSmoother(now);
    smoother.push("x".repeat(120));

    const frames: number[] = [];
    for (let i = 0; i < 12; i++) {
      advance(33);
      frames.push(smoother.drain().length);
    }

    // The point of the exercise: no frame swallows the block whole.
    assert.ok(Math.max(...frames) < 120, `a frame took ${Math.max(...frames)} of 120`);
    assert.ok(frames.filter((n) => n > 0).length >= 4, "should take at least four frames");
  });

  test("drains faster as the backlog grows", () => {
    const { now, advance } = clock();
    const small = createSmoother(now);
    const large = createSmoother(now);

    small.push("x".repeat(40));
    large.push("x".repeat(900));
    advance(33);

    assert.ok(large.drain().length > small.drain().length, "a long queue should move faster");
  });

  test("never falls so far behind that it stops being live", () => {
    const { now, advance } = clock();
    const smoother = createSmoother(now);

    // Far more than a reader can follow: catch up rather than pace it out.
    smoother.push("x".repeat(5000));
    advance(33);
    assert.equal(smoother.drain().length, 5000);
  });

  test("a stalled frame does not release a burst", () => {
    const { now, advance } = clock();
    const smoother = createSmoother(now);
    smoother.push("x".repeat(600));

    // The process was busy for a second. The budget is capped at 100ms of it.
    advance(1000);
    assert.ok(smoother.drain().length <= 100, "a long gap must not hand out a proportional budget");
  });

  test("flush gives back everything still held", () => {
    const { now, advance } = clock();
    const smoother = createSmoother(now);
    smoother.push("abcdef");
    advance(33);

    const shown = smoother.drain();
    assert.equal(shown + smoother.flush(), "abcdef");
    assert.equal(smoother.pending, 0);
  });

  test("emits at least one character once time has passed", () => {
    const { now, advance } = clock();
    const smoother = createSmoother(now);
    smoother.push("ab");
    advance(1);
    assert.ok(smoother.drain().length >= 1);
  });

  test("preserves the text exactly, in order", () => {
    const { now, advance } = clock();
    const smoother = createSmoother(now);
    const source = "The quick brown fox jumps over the lazy dog.\nSecond line here.";

    for (const chunk of source.match(/.{1,17}/gs) ?? []) smoother.push(chunk);

    let out = "";
    for (let i = 0; i < 200 && smoother.pending > 0; i++) {
      advance(33);
      out += smoother.drain();
    }
    out += smoother.flush();

    assert.equal(out, source);
  });
});
