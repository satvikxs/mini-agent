import { glyph } from "./tokens.ts";

/** A picture: one string per pixel row, `#` lit and anything else clear. */
export type Sprite = readonly string[];

const LIT = "#";

/** Columns in the goat. Callers lay text out beside it, so they need to know. */
export const WIDTH = 32;

/** Rows of terminal the goat occupies — two pixel rows to each one. */
export const ROWS = 8;

/** Everything above the knees: horn, skull, eye, muzzle, beard, tail, barrel. */
const BODY: Sprite = [
  "................###.............",
  ".................###............",
  "..................############..",
  ".....................##########.",
  ".....................#####..####",
  ".....................#####..####",
  "...##..............#############",
  "...##............##############.",
  "...###################...##.....",
  "...####################..##.....",
  "...####################.........",
  "....##################..........",
];

/** The two rows the eye sits in, and the columns it spans. */
const EYE = { rows: [4, 5], from: 26, through: 27 };

/** Where each leg meets the body: the back pair, then the front pair. */
const HIPS = [5, 10, 15, 20];

/** What a leg can be doing. */
const STRIDE = {
  plant: [0, 0, 0, 0],
  fore: [1, 1, 1, 1],
  aft: [-1, -1, -1, -1],
  lift: [0, 0, null, null],
  liftFore: [1, 1, null, null],
} as const satisfies Record<string, readonly (number | null)[]>;

type Stride = keyof typeof STRIDE;

/** Four strides — back pair, then front pair — become a whole goat. */
function withLegs(strides: readonly [Stride, Stride, Stride, Stride]): Sprite {
  const legs = Array.from({ length: 4 }, () => Array.from({ length: WIDTH }, () => "."));

  strides.forEach((stride, leg) => {
    const hip = HIPS[leg];
    if (hip === undefined) return;

    STRIDE[stride].forEach((dx, row) => {
      if (dx === null) return;
      const bar = legs[row];
      if (!bar) return;
      bar[hip + dx] = LIT;
      bar[hip + dx + 1] = LIT;
    });
  });

  return [...BODY, ...legs.map((bar) => bar.join(""))];
}

/** Standing still. */
export const STANDING: Sprite = withLegs(["plant", "plant", "plant", "plant"]);

/** Standing still, mid-blink. Shutting the eye is filling its rows back in. */
export const BLINKING: Sprite = STANDING.map((row, index) =>
  EYE.rows.includes(index)
    ? row.slice(0, EYE.from) + LIT.repeat(EYE.through - EYE.from + 1) + row.slice(EYE.through + 1)
    : row,
);

/** One stride, as a trot: diagonal pairs move together, which is what a goat actually does and also what keeps two legs from landing on the same column. */
const GALLOP: readonly (readonly [Stride, Stride, Stride, Stride])[] = [
  ["fore", "aft", "aft", "fore"],
  ["lift", "plant", "plant", "liftFore"],
  ["aft", "fore", "fore", "aft"],
  ["plant", "lift", "lift", "plant"],
];

/** The goat mid-run, at a point in the stride. Out-of-range phases wrap. */
export function running(phase: number): Sprite {
  const step = GALLOP[Math.abs(Math.trunc(phase) || 0) % GALLOP.length];
  return withLegs(step ?? ["plant", "plant", "plant", "plant"]);
}

const lit = (sprite: Sprite, x: number, y: number): boolean => sprite[y]?.[x] === LIT;

/** Draws a sprite as terminal rows, two pixel rows to each one. */
export function draw(
  sprite: Sprite,
  options: { rows?: number; offsetX?: number; offsetY?: number; width?: number } = {},
): string[] {
  const { rows = Math.ceil(sprite.length / 2), offsetX = 0, offsetY = 0 } = options;
  const width = options.width ?? Math.max(0, ...sprite.map((row) => row.length));
  const canvas: string[] = [];

  for (let row = 0; row < rows; row++) {
    let line = "";
    for (let x = 0; x < width; x++) {
      const top = lit(sprite, x - offsetX, row * 2 - offsetY);
      const bottom = lit(sprite, x - offsetX, row * 2 + 1 - offsetY);
      line += top && bottom
        ? glyph.pixel.both
        : top
          ? glyph.pixel.top
          : bottom
            ? glyph.pixel.bottom
            : glyph.pixel.none;
    }
    canvas.push(line);
  }

  return canvas;
}

/** How far the goat travels between strides. */
const STRIDE_PIXELS = 4;

/** The stride the goat is in, having covered this much ground. */
const strideAt = (travelled: number): Sprite => running(Math.floor(travelled / STRIDE_PIXELS));

/** Cubic ease-out: quick off the mark, unhurried into it. */
const easeOut = (t: number): number => 1 - (1 - t) ** 3;

/** Frames in the run-in. At 60fps this is a little over half a second. */
const ARRIVAL_FRAMES = 38;

/** How far off the left edge the goat starts. */
const ARRIVAL_FROM = -WIDTH;

/** The goat running into the banner from off the left edge, and stopping. */
export function arrival(): string[][] {
  const frames: string[][] = [];

  for (let index = 0; index < ARRIVAL_FRAMES; index++) {
    const eased = easeOut(index / (ARRIVAL_FRAMES - 1));
    // Overshoot: the curve is aimed one pixel past home for most of the run and
    // eased back over the last few frames, so it settles rather than slams.
    const target = index > ARRIVAL_FRAMES - 5 ? 0 : 1;
    const offsetX = Math.round(ARRIVAL_FROM + (target - ARRIVAL_FROM) * eased);
    const travelled = offsetX - ARRIVAL_FROM;
    const arrived = index >= ARRIVAL_FRAMES - 4;

    frames.push(draw(arrived ? STANDING : strideAt(travelled), { rows: ROWS, offsetX }));
  }

  return [
    ...frames,
    draw(BLINKING, { rows: ROWS }),
    draw(BLINKING, { rows: ROWS }),
    draw(STANDING, { rows: ROWS }),
  ];
}

/** A lap: the goat runs out of its own frame to the right and back in from the left, ending exactly where it started. */
export function lap(): string[][] {
  const home = draw(STANDING, { rows: ROWS });
  // The first frame is exactly what is already on screen, and so is the last.
  const frames: string[][] = [home];

  // Out to the right, until the last of it has cleared the frame...
  for (let offsetX = 1; offsetX <= WIDTH; offsetX++) {
    frames.push(draw(strideAt(offsetX), { rows: ROWS, offsetX }));
  }
  // ...and back in from the left, up to the pixel it set off from.
  for (let offsetX = -WIDTH; offsetX < 0; offsetX++) {
    frames.push(draw(strideAt(WIDTH + WIDTH + offsetX), { rows: ROWS, offsetX }));
  }

  frames.push(home, draw(BLINKING, { rows: ROWS }), home);
  return frames;
}
