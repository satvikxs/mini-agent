import { displayWidth } from "./layout.ts";
import { cursor, motion } from "./tokens.ts";

export type Write = (text: string) => void;

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((done) => setTimeout(done, ms));

/** Pads a styled line out to `width` visible columns. */
const pad = (line: string, width: number): string => line + " ".repeat(Math.max(0, width - displayWidth(line)));

/** Plays a sequence of equal-height frames, leaving the last one on screen. */
export async function play(frames: readonly string[][], intervalMs: number, write: Write): Promise<void> {
  const last = frames.at(-1);
  if (!last) return;

  if (!motion) {
    write(`${last.join("\n")}\n`);
    return;
  }

  const rows = last.length;
  const width = Math.max(...frames.flatMap((frame) => frame.map(displayWidth)));

  write(`${cursor.hide}${"\n".repeat(rows)}`);

  try {
    const startedAt = Date.now();

    for (const [index, frame] of frames.entries()) {
      const body =
        index === frames.length - 1
          ? `${cursor.clearBelow}${frame.join("\n")}`
          : frame.map((line) => pad(line, width)).join("\n");

      write(`${cursor.up(rows)}${body}\n`);
      await sleep(startedAt + (index + 1) * intervalMs - Date.now());
    }
  } finally {
    write(cursor.show);
  }
}

/** Repaints a block that is already on screen, adding and removing no rows. */
export async function repaint(frames: readonly string[][], intervalMs: number, write: Write): Promise<void> {
  const last = frames.at(-1);
  if (!motion || !last) return;

  const rows = last.length;
  const width = Math.max(...frames.flatMap((frame) => frame.map(displayWidth)));

  write(cursor.hide);

  try {
    const startedAt = Date.now();

    for (const [index, frame] of frames.entries()) {
      const body = frame.map((line) => pad(line, width)).join("\n");
      write(`${body}${cursor.home}${cursor.up(rows - 1)}`);
      await sleep(startedAt + (index + 1) * intervalMs - Date.now());
    }
  } finally {
    write(cursor.show);
  }
}

