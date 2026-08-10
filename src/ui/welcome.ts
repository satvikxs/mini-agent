import { column, keyRail } from "./frame.ts";
import { truncate, windowStart } from "./layout.ts";
import { arrival, BLINKING, draw, ROWS, STANDING } from "./mascot.ts";
import { type Model, type Provider } from "../providers.ts";
import { strings } from "./strings.ts";
import { color, glyph, invert, PAD, space } from "./tokens.ts";

export type Step = "provider" | "endpoint" | "key" | "checking" | "rejected" | "model";

export type WelcomeProps = {
  columns: number;
  rows: number;
  version: string;
  step: Step;
  providers: readonly Provider[];
  selected: number;
  /** Already filtered by `term`, so the index below counts rows on screen. */
  models: readonly Model[];
  model: number;
  /** What has been typed into the model filter. */
  term: string;
  value: string;
  message: string;
  frame: number;
};

const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/** The run-in, drawn once at open. Held, because it is the same every time. */
const ARRIVAL = arrival();
const HOME = draw(STANDING, { rows: ROWS });
const WINK = draw(BLINKING, { rows: ROWS });

/** How many frames the goat spends running in. The caller paces the clock by it. */
export const ARRIVAL_LENGTH = ARRIVAL.length;

/** Idle frames between blinks, and how long one lasts. */
const BLINK_EVERY = 38;
const BLINK_FOR = 2;

/**
 * The goat at a moment in time: running in, then standing and blinking.
 *
 * A mascot that arrives and then holds perfectly still reads as a picture. One
 * that blinks reads as something waiting for you, which is what this screen is.
 */
export function goat(frame: number): string[] {
  if (frame < ARRIVAL.length) return ARRIVAL[frame] ?? HOME;
  return (frame - ARRIVAL.length) % BLINK_EVERY < BLINK_FOR ? WINK : HOME;
}

/** A key is a secret on someone's screen, so only its length is shown. */
const masked = (value: string, width: number): string =>
  value.length === 0 ? "" : "•".repeat(Math.min(value.length, Math.max(8, width - 4)));

const RAIL: Record<Step, ReadonlyArray<readonly [string, string]>> = {
  provider: [["↑↓", "choose"], ["↵", "continue"], ["^C", "quit"]],
  endpoint: [["↵", "continue"], ["esc", "back"], ["^C", "quit"]],
  key: [["↵", "continue"], ["esc", "back"], ["^C", "quit"]],
  checking: [["^C", "quit"]],
  rejected: [["↵", "try again"], ["esc", "back"], ["^C", "quit"]],
  model: [["↑↓", "choose"], ["↵", "start"], ["esc", "back"], ["^C", "quit"]],
};

/** How many model rows to draw when the terminal has room for them. */
const MODEL_ROWS = 8;

/** Rows the model screen spends on everything that is not the list. */
const MODEL_CHROME = 21;

/** Long enough for any Claude name, short enough to leave the note room. */
const LABEL_WIDTH = 24;

/**
 * The first screen, and for most people the only one they will ever read.
 *
 * Three questions, one at a time: where the model comes from, the key for it,
 * then which model. Asking at once would mean explaining which key format goes
 * with which endpoint, and the answer to the first question already says.
 */
export function welcomeFrame(props: WelcomeProps): string[] {
  const { width, left } = column(props.columns);
  const inner = width - space.gutter.length;
  const provider = props.providers[props.selected];

  const art = goat(props.frame).map((row) => `${space.gutter}${color.accent(row.trimEnd())}`);

  const block = [
    "",
    ...art,
    "",
    `${space.gutter}${color.text(strings.product)}  ${color.muted(props.version)}`,
    "",
    ...body(props, provider, inner),
  ];

  // A little above centre: an empty lower half reads as room to work, where a
  // block pinned to the middle reads as a dialog that has stopped everything.
  const top = Math.max(0, Math.floor((props.rows - block.length) / 4));
  const lines = [
    ...Array.from({ length: top }, () => ""),
    ...block,
    ...Array.from({ length: Math.max(0, props.rows - top - block.length - 2) }, () => ""),
    keyRail(RAIL[props.step], width),
    "",
  ];

  return lines.slice(0, props.rows).map((line) => left + line);
}

/** One question, its rows, and the selected one knocked out of a block. */
function pick(
  question: string,
  rows: ReadonlyArray<{ label: string; note: string }>,
  selected: number,
  inner: number,
): string[] {
  const column = Math.max(...rows.map((row) => row.label.length)) + 2;
  return [
    `${space.gutter}${color.text(question)}`,
    "",
    ...rows.map((row, index) => {
      const label = row.label.padEnd(column);
      const mark = index === selected ? invert(` ${label}`) : `${PAD}${color.name(label)}`;
      return `${space.gutter}${mark}  ${color.muted(truncate(row.note, inner - column - 6))}`;
    }),
  ];
}

/**
 * The model list, narrowed by whatever has been typed above it.
 *
 * A provider can offer three models or three hundred, and the same screen has
 * to work for both — so the list scrolls and the question doubles as a filter.
 * Typing something no row matches is not a dead end either: the field itself
 * becomes the answer, which is the only way to reach a model the endpoint
 * declines to list.
 */
function catalog(props: WelcomeProps, inner: number): string[] {
  const typed = props.term.trim();
  const head = [
    `${space.gutter}${color.text(strings.onboard.model)}`,
    "",
    `${space.gutter}${color.accent(glyph.prompt)} ${
      props.term === "" ? color.dim(strings.onboard.filter) : color.name(props.term)
    }${invert(" ")}`,
    "",
  ];

  const total = props.models.length;
  if (total === 0) return [...head, `${space.gutter}${color.muted(strings.onboard.useTyped(typed))}`];

  const per = Math.max(1, Math.min(MODEL_ROWS, props.rows - MODEL_CHROME));
  const at = Math.min(Math.max(props.model, 0), total - 1);
  const start = windowStart(at, per, total);
  const column = Math.min(LABEL_WIDTH, Math.max(...props.models.map((row) => row.label.length))) + 2;

  const rows = props.models.slice(start, start + per).map((row, offset) => {
    const label = truncate(row.label, column - 2).padEnd(column);
    const mark = start + offset === at ? invert(` ${label}`) : `${PAD}${color.name(label)}`;
    return `${space.gutter}${mark}  ${color.muted(truncate(row.note, Math.max(0, inner - column - 6)))}`;
  });

  // The id as the endpoint spells it, which is exactly what lands in .env.
  const chosen = props.models[at]?.id ?? "";
  const tally = strings.onboard.tally(total, per < total);
  return [...head, ...rows, "", `${space.gutter}${color.dim(tally)}  ${color.muted(truncate(chosen, inner))}`];
}

function body(props: WelcomeProps, provider: Provider | undefined, inner: number): string[] {
  if (props.step === "provider") {
    return pick(strings.onboard.provider, props.providers, props.selected, inner);
  }

  if (props.step === "model") return catalog(props, inner);

  // Where to fetch the key, cut to whatever the question leaves it. Styled once
  // it has been measured, because measuring afterwards counts the escapes.
  const ask = strings.onboard.ask;
  const source = truncate(provider?.source ?? "", Math.max(0, inner - ask.length - 2));

  const prompt =
    props.step === "endpoint"
      ? color.text(strings.onboard.endpoint)
      : `${color.text(ask)}  ${color.muted(source)}`;

  const shown = props.step === "endpoint" ? color.name(props.value) : color.name(masked(props.value, inner));
  const caret = props.step === "checking" ? color.muted(glyph.prompt) : color.accent(glyph.prompt);

  const note =
    props.step === "checking"
      ? color.muted(`${SPIN[props.frame % SPIN.length] ?? ""} ${props.message || strings.onboard.checking}`)
      : props.step === "rejected"
        // Cut to the column: an endpoint is free to answer with a paragraph, and
        // one line over the width wraps and pushes the key rail off the screen.
        ? color.danger(truncate(props.message, inner))
        : color.muted(strings.onboard.hint);

  return [
    `${space.gutter}${prompt}`,
    "",
    `${space.gutter}${caret} ${shown}${props.step === "checking" ? "" : invert(" ")}`,
    "",
    `${space.gutter}${note}`,
  ];
}
