import { PassThrough } from "node:stream";
import { cursor, motion, pointer as sequences } from "./tokens.ts";

/** Left, middle or right going down. Anything higher is the scroll wheel. */
const BUTTONS = 3;

/** Everything the terminal says that is not a keystroke: `…M` a click going down, `m` its release, `…R` the answer to `cursor.ask`. */
const REPORT = /\x1b\[(?:<(\d+);(\d+);(\d+)([Mm])|(\d+);(\d+)R)/g;

export type Spot = { column: number; row: number };

/** Splits terminal input into what the terminal said and what the person typed. */
export function separate(text: string): { keys: string; clicks: Spot[]; cursor: Spot[] } {
  const clicks: Spot[] = [];
  const cursorAt: Spot[] = [];
  let keys = "";
  let cut = 0;

  for (const report of text.matchAll(REPORT)) {
    keys += text.slice(cut, report.index);
    cut = report.index + report[0].length;

    const [, button, clickColumn, clickRow, updown, cursorRow, cursorColumn] = report;

    if (cursorRow !== undefined && cursorColumn !== undefined) {
      cursorAt.push({ row: Number(cursorRow), column: Number(cursorColumn) });
      continue;
    }
    // Releases are dropped along with the press, so neither reaches readline; only the press
    // is worth telling anyone about.
    if (updown === "M" && Number(button) < BUTTONS) {
      clicks.push({ column: Number(clickColumn), row: Number(clickRow) });
    }
  }

  return { keys: keys + text.slice(cut), clicks, cursor: cursorAt };
}

export type Pointer = {
  /** What readline should read from instead of stdin. */
  readonly keys: NodeJS.ReadableStream;
  /** Stops delivering keystrokes to readline, and starts again. */
  hold(): void;
  resume(): void;
  /** Stops reporting clicks, and leaves everything else exactly as it is. */
  disarm(): void;
  /** Asks the terminal where the cursor is, and waits for it to answer. */
  where(): Promise<Spot | null>;
  /** Puts the terminal back the way it was found. Safe to call twice. */
  release(): void;
};

/** How long to wait for the terminal to say where the cursor is. */
const ANSWER_MS = 120;

/** Starts reporting clicks, and hands back the keystrokes that are left. */
export function trackClicks(onClick: (column: number, row: number) => void): Pointer | null {
  if (!motion || !process.stdin.isTTY) return null;

  const keys = new PassThrough();
  let released = false;
  let armed = true;
  let awaiting: ((spot: Spot | null) => void) | null = null;
  let holding = false;
  let held = "";

  const receive = (chunk: Buffer): void => {
    // Latin-1 in and out: it round-trips every byte value unchanged, so the bytes readline
    // finally receives are the bytes the terminal actually sent.
    const split = separate(chunk.toString("binary"));

    if (split.keys) {
      if (holding) held += split.keys;
      else keys.write(Buffer.from(split.keys, "binary"));
    }

    const answer = split.cursor.at(0);
    if (answer && awaiting) awaiting(answer);
    for (const click of split.clicks) onClick(click.column, click.row);
  };

  const finish = (): void => void keys.end();

  const disarm = (): void => {
    if (!armed) return;
    armed = false;
    process.stdout.write(sequences.off);
  };

  const release = (): void => {
    if (released) return;
    released = true;
    disarm();
    process.stdin.off("data", receive);
    process.stdin.off("end", finish);
    // readline is reading the filtered stream, so ending that stream is the only thing it
    // recognises as "no more input".
    keys.end();
    // A terminal left in raw mode has no line editing and no ctrl-c for whatever the user runs
    // next, and one left reporting clicks cannot select text with the mouse.
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  };

  process.stdin.setRawMode(true);
  process.stdin.on("data", receive);
  process.stdin.once("end", finish);
  // A backstop, not the normal path: callers release this themselves.
  process.once("exit", release);
  process.stdout.write(sequences.on);

  return {
    keys,
    hold() {
      holding = true;
    },
    resume() {
      holding = false;
      if (!held) return;
      const waiting = held;
      held = "";
      keys.write(Buffer.from(waiting, "binary"));
    },
    disarm,
    where() {
      if (released) return Promise.resolve(null);

      return new Promise<Spot | null>((resolve) => {
        const settle = (spot: Spot | null): void => {
          clearTimeout(timer);
          awaiting = null;
          resolve(spot);
        };
        const timer = setTimeout(() => settle(null), ANSWER_MS);
        // Never the reason the process stays alive: if everything else has
        // finished, an unanswered question is not worth waiting out.
        timer.unref?.();
        awaiting = settle;
        process.stdout.write(cursor.ask);
      });
    },
    release,
  };
}
