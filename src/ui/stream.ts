export type Smoother = {
  /** Takes a chunk off the wire. Nothing becomes visible until it is drained. */
  push(text: string): void;
  /** How much should be on screen by now. Call it every frame. */
  drain(): string;
  /** Everything still held, for the end of a turn. */
  flush(): string;
  readonly pending: number;
};

/** How long the queue should take to empty, if nothing more arrives. */
const TARGET_MS = 260;

/** Slow enough to read as typing rather than as a jump, in characters a second. */
const MIN_RATE = 60 / 1000;

/**
 * Fast enough to keep up with a model that is ahead of the reader. Past this the
 * queue is allowed to grow, because emitting faster reads as a paste anyway.
 */
const MAX_RATE = 900 / 1000;

/** A backlog this big means the reader is far behind, so catch up rather than pace. */
const FLOOD = 2000;

/**
 * Evens out a bursty stream.
 *
 * The API does not deliver a token at a time: it arrives in blocks, and through
 * a gateway those blocks are bigger and further apart — measured here at roughly
 * 120 characters every 590ms. Appending each block as it lands makes the answer
 * jump down the screen in paragraph-sized steps with nothing happening between,
 * which reads as stalling and then lurching.
 *
 * So arrivals go into a queue and the queue is emptied at a rate, chosen each
 * frame to clear whatever is waiting over the next {@link TARGET_MS}. A long
 * queue drains faster and a short one slower, which keeps text moving
 * continuously without ever falling behind the model.
 */
export function createSmoother(now: () => number = Date.now): Smoother {
  let queue = "";
  let last = 0;

  return {
    get pending() {
      return queue.length;
    },

    push(text) {
      // The clock starts at the first character, not at construction: a turn that
      // waits two seconds for its first token would otherwise be handed a budget
      // large enough to emit the whole first block at once.
      if (queue.length === 0 && last === 0) last = now();
      queue += text;
    },

    drain() {
      if (queue.length === 0) return "";

      const at = now();
      const elapsed = at - last;
      last = at;

      // A frame that never ran — the process was busy, or this is the first —
      // must not hand out a budget for the whole gap.
      const step = Math.min(elapsed, 100);
      if (queue.length > FLOOD) {
        const all = queue;
        queue = "";
        return all;
      }
      // Two drains inside one millisecond release nothing; once the clock has
      // moved at all, at least one character does.
      if (step <= 0) return "";

      const rate = Math.min(MAX_RATE, Math.max(MIN_RATE, queue.length / TARGET_MS));
      const take = Math.max(1, Math.floor(rate * step));

      const out = queue.slice(0, take);
      queue = queue.slice(out.length);
      return out;
    },

    flush() {
      const out = queue;
      queue = "";
      last = 0;
      return out;
    },
  };
}
