import { StringDecoder } from "node:string_decoder";
import { background, cursor, motion, pointer } from "./tokens.ts";

export type KeyName =
  | ("char" | "return" | "escape" | "tab" | "backspace" | "delete")
  | ("up" | "down" | "left" | "right" | "pageup" | "pagedown" | "home" | "end")
  | ("wheelup" | "wheeldown");

export type Key = { name: KeyName; text: string; ctrl: boolean; shift: boolean; meta: boolean };

export type Screen = {
  readonly rows: number;
  readonly columns: number;
  draw(lines: readonly string[]): void;
  close(): void;
};

// The canvas is set before the clear, so `\x1b[2J` paints the whole screen with
// it rather than with whatever the terminal's own background happens to be.
const ENTER = `\x1b[?1049h\x1b[?2004h${pointer.on}${background}\x1b[2J\x1b[H`;
// The exact reverse of ENTER. Paste and mouse reporting belong to whichever
// screen buffer is active, so they have to be popped while the alternate one is
// still up, or they leak into the shell the user comes back to.
const LEAVE = `${pointer.off}\x1b[?2004l\x1b[49m\x1b[39m${cursor.show}\x1b[?1049l`;

/** At most one write per frame, so a burst of state changes costs one repaint. */
const FRAME_MS = 33;
/** How long a bare escape waits for the rest of a sequence that may never come. */
const ESC_MS = 20;

const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

const key = (name: KeyName, text = "", ctrl = false, shift = false, meta = false): Key =>
  ({ name, text, ctrl, shift, meta });

/** Matches a sticky pattern at exactly `at`, never later in the string. */
function seek(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

const MOUSE = /\x1b\[<(\d+);\d+;\d+[Mm]/y;
/** Cursor-position answers and mode replies: terminal chatter, never keystrokes. */
const REPLY = /\x1b\[(?:\d+;\d+R|\?[\d;]*\$?[a-zA-Z])/y;
const CSI = /\x1b\[(\d*)(?:;(\d+))?([A-Za-z~])/y;
const SS3 = /\x1bO([A-Za-z])/y;

const ARROW: Record<string, KeyName> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
/** The `~` forms, by first parameter. 2 is insert, absent on purpose: it is dropped. */
const TILDE: Record<string, KeyName> = { "1": "home", "3": "delete", "4": "end", "5": "pageup", "6": "pagedown", "7": "home", "8": "end" };
const SINGLE: Record<string, KeyName> = { "\r": "return", "\n": "return", "\t": "tab", "\x7f": "backspace", "\b": "backspace" };

function decode(text: string, flush: boolean): { keys: Key[]; pending: string } {
  const keys: Key[] = [];
  let at = 0;

  while (at < text.length) {
    const ch = text.charAt(at);

    if (ch === "\x1b") {
      if (text.startsWith("\x1b[200~", at)) {
        const end = text.indexOf("\x1b[201~", at + 6);
        // Half a paste is worse than no paste: hold the tail until the end
        // marker lands, however many chunks that takes.
        if (end < 0) return { keys, pending: text.slice(at) };
        keys.push(key("char", text.slice(at + 6, end).replace(/\r\n?/g, "\n")));
        at = end + 6;
        continue;
      }

      const wheel = seek(MOUSE, text, at);
      if (wheel) {
        // Everything but the wheel is swallowed. A click report that reached the
        // composer would be typed into it as literal text.
        if (wheel[1] === "64") keys.push(key("wheelup"));
        else if (wheel[1] === "65") keys.push(key("wheeldown"));
        at += wheel[0].length;
        continue;
      }

      const reply = seek(REPLY, text, at);
      if (reply) {
        at += reply[0].length;
        continue;
      }

      const csi = seek(CSI, text, at);
      if (csi) {
        const [whole, first = "", second, final = ""] = csi;
        const bits = second ? Number(second) - 1 : 0;
        const name = final === "~" ? TILDE[first] : final === "Z" ? "tab" : ARROW[final];
        if (name) keys.push(key(name, "", (bits & 4) !== 0, final === "Z" || (bits & 1) !== 0, (bits & 2) !== 0));
        at += whole.length;
        continue;
      }

      const ss3 = seek(SS3, text, at);
      const named = ss3 ? ARROW[ss3[1] ?? ""] : undefined;
      if (ss3 && named) {
        keys.push(key(named));
        at += ss3[0].length;
        continue;
      }

      const next = text.charAt(at + 1);
      const paired = SINGLE[next];
      // \x7f is excluded from the printable test on purpose: alt-backspace is
      // meta on a named key, not a DEL byte to be typed into the composer.
      if (paired || (next >= " " && next !== "\x7f" && next !== "[" && next !== "O")) {
        keys.push(paired ? key(paired, "", false, false, true) : key("char", next, false, false, true));
        at += 2;
        continue;
      }
      // A bare escape and a sequence torn across chunks look identical until the
      // reader's timer says nothing more is coming.
      if (!flush) return { keys, pending: text.slice(at) };
      if (text.length - at === 1) keys.push(key("escape"));
      return { keys, pending: "" };
    }

    // Held Backspace arrives as one run of \x7f, so every one of them is its own
    // event; taking the run as a unit would erase a single character and leave
    // the buffer out of step with the screen.
    const single = SINGLE[ch];
    if (single) {
      keys.push(key(single));
      at += 1;
      continue;
    }

    const code = ch.charCodeAt(0);
    if (code < 32) {
      if (code >= 1) keys.push(key("char", String.fromCharCode(code + 96), true));
      at += 1;
      continue;
    }

    let end = at;
    while (end < text.length && text.charAt(end) >= " " && text.charAt(end) !== "\x7f") end += 1;
    keys.push(key("char", text.slice(at, end)));
    at = end;
  }

  return { keys, pending: "" };
}

/** Pure over one already-decoded string; a sequence torn off the end is discarded. */
export const decodeKeys = (text: string): Key[] => decode(text, true).keys;

export function openScreen(onKey: (key: Key) => void, onResize: () => void): Screen {
  let rows = process.stdout.rows || 24;
  let columns = process.stdout.columns || 80;

  if (!motion || !process.stdin.isTTY) return { rows, columns, draw: () => {}, close: () => {} };

  let painted: readonly string[] = [];
  let next: readonly string[] | null = null;
  let frameTimer: NodeJS.Timeout | null = null;

  const paint = (): void => {
    frameTimer = null;
    const lines = next;
    next = null;
    if (!lines) return;

    let out = "";
    for (const [index, line] of lines.entries()) {
      // Never a trailing newline: one would scroll the buffer up a row and put
      // every later cursor address one row out for the rest of the session.
      // The canvas is reasserted per row so the erase-to-end paints with it, and
      // so one stray full reset cannot strip the background off the rest of the
      // frame.
      if (line !== painted[index]) out += `\x1b[${index + 1};1H${background}${line}\x1b[K`;
    }
    painted = lines;
    if (out) process.stdout.write(`\x1b[?2026h${out}\x1b[?2026l`);
  };

  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    try {
      process.stdout.write(LEAVE);
    } catch {
      /* stdout may already be torn down, and there is nothing left to put back */
    }
  };

  const onExit = (): void => restore();
  const onSignal = (signal: NodeJS.Signals): void => {
    restore();
    // Re-raise under the default handler so the exit code carries the signal. In
    // raw mode the app sees ctrl-c as 0x03 first; this is only the backstop for a
    // signal raised from somewhere else.
    process.removeListener(signal, onSignal);
    process.kill(process.pid, signal);
  };
  const onFatal = (error: unknown): void => {
    restore();
    console.error(error);
    process.exit(1);
  };

  const decoder = new StringDecoder("utf8");
  let waiting = "";
  let escTimer: NodeJS.Timeout | null = null;

  const drain = (flush: boolean): void => {
    const read = decode(waiting, flush);
    waiting = read.pending;
    for (const stroke of read.keys) onKey(stroke);
  };

  const receive = (chunk: Buffer): void => {
    if (escTimer) clearTimeout(escTimer);
    escTimer = null;
    // A code point split across two chunks decodes to replacement characters
    // unless the leftover bytes are carried into the next one.
    waiting += decoder.write(chunk);
    drain(false);
    if (!waiting) return;
    escTimer = setTimeout(() => drain(true), ESC_MS);
    escTimer.unref();
  };

  const resized = (): void => {
    rows = process.stdout.rows || 24;
    columns = process.stdout.columns || 80;
    // Emptying the cache is the whole repaint. Clearing the screen here would
    // wipe a frame that has already been drawn at the new size.
    painted = [];
    onResize();
  };

  process.on("exit", onExit);
  for (const signal of SIGNALS) process.on(signal, onSignal);
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);

  // Input ending is a way out, and without it the process outlives its terminal:
  // a closed window, an exhausted pipe, a detached session all leave the loop
  // waiting on keys that can never arrive. Ctrl-D means the same thing.
  const ended = (): void => onKey({ name: "char", text: "\x04", ctrl: true, shift: false, meta: false });

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", receive);
  process.stdin.once("end", ended);
  process.stdin.once("close", ended);
  process.stdout.on("resize", resized);

  process.stdout.write(ENTER);
  process.stdout.write(cursor.hide);

  return {
    get rows() {
      return rows;
    },
    get columns() {
      return columns;
    },
    draw(lines) {
      next = lines;
      if (frameTimer) return;
      frameTimer = setTimeout(paint, FRAME_MS);
      frameTimer.unref();
    },
    close() {
      if (frameTimer) clearTimeout(frameTimer);
      if (escTimer) clearTimeout(escTimer);
      process.stdin.off("data", receive);
      process.stdin.off("end", ended);
      process.stdin.off("close", ended);
      process.stdout.off("resize", resized);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      restore();
      process.removeListener("exit", onExit);
      for (const signal of SIGNALS) process.removeListener(signal, onSignal);
      process.removeListener("uncaughtException", onFatal);
      process.removeListener("unhandledRejection", onFatal);
    },
  };
}
