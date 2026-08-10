import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fallbackModels, findProvider, PROVIDERS, type Model } from "../src/providers.ts";
import { displayWidth } from "../src/ui/layout.ts";
import { welcomeFrame, type Step, type WelcomeProps } from "../src/ui/welcome.ts";

const MODELS = fallbackModels(findProvider("anthropic")!);

const props = (over: Partial<WelcomeProps> = {}): WelcomeProps => ({
  columns: 100,
  rows: 30,
  version: "v1.0.0",
  step: "provider",
  providers: PROVIDERS,
  selected: 0,
  models: MODELS,
  model: 0,
  term: "",
  value: "",
  message: "",
  frame: 0,
  ...over,
});

const plain = (lines: string[]): string => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

/** A provider that lists far more models than the screen can hold at once. */
const many = (count: number): Model[] =>
  Array.from({ length: count }, (_, at) => ({ id: `vendor/model-${at}`, label: `Model ${at}`, note: "1M context" }));

const STEPS: Step[] = ["provider", "endpoint", "key", "checking", "rejected", "model"];

describe("welcomeFrame", () => {
  test("fits the terminal exactly, at every step and every size", () => {
    for (const [columns, rows] of [[40, 12], [80, 24], [200, 60]] as const) {
      for (const step of STEPS) {
        const lines = welcomeFrame(props({ columns, rows, step, message: "That key was refused." }));
        assert.equal(lines.length, rows, step);
        for (const line of lines) {
          assert.ok(displayWidth(line) <= columns, `${step}: ${displayWidth(line)} > ${columns}`);
        }
      }
    }
  });

  test("keeps a talkative endpoint inside the column", () => {
    // Verbatim from Command Code, which answers a plan gate with a sentence and
    // a billing URL. Left whole it wraps, and the wrap pushes the key rail off
    // the bottom of the screen.
    const message =
      "Your Go plan doesn't include API access. Upgrade to Provider or higher at https://commandcode.ai/billing to use these endpoints.";

    for (const columns of [40, 80, 100]) {
      const lines = welcomeFrame(props({ columns, step: "rejected", message }));
      for (const line of lines) assert.ok(displayWidth(line) <= columns, `${displayWidth(line)} > ${columns}`);
    }
  });

  test("offers every provider on the first screen", () => {
    const shown = plain(welcomeFrame(props({ columns: 100 })));
    for (const provider of PROVIDERS) assert.ok(shown.includes(provider.label), provider.label);
  });
});

describe("the model screen", () => {
  test("shows the models and the id that will be written", () => {
    const shown = plain(welcomeFrame(props({ step: "model", model: 1 })));
    assert.ok(shown.includes("Sonnet 5"), "the chosen label");
    assert.ok(shown.includes("claude-sonnet-5"), "the id that lands in .env");
    assert.ok(shown.includes("5 models"), "how many there are to choose from");
  });

  test("scrolls rather than growing past the terminal", () => {
    const models = many(300);
    for (const rows of [24, 30, 60]) {
      const lines = welcomeFrame(props({ step: "model", models, model: 0, rows }));
      assert.equal(lines.length, rows);
      // Every row on screen is one of the list's, and there are fewer of them
      // than the list holds — the frame never tries to draw all 300.
      const drawn = models.filter((model) => plain(lines).includes(model.label));
      assert.ok(drawn.length > 0 && drawn.length < models.length, `${drawn.length} of ${models.length}`);
    }
  });

  test("keeps the selected row on screen however far down the list it is", () => {
    const models = many(300);
    for (const at of [0, 7, 42, 299]) {
      const shown = plain(welcomeFrame(props({ step: "model", models, model: at })));
      assert.ok(shown.includes(models[at]!.label), `row ${at} scrolled out of view`);
    }
  });

  test("says how to reach a model the endpoint never listed", () => {
    // Nothing matched, so the field itself becomes the answer — the only route
    // to an Azure deployment name or a model the list left out.
    const shown = plain(welcomeFrame(props({ step: "model", models: [], term: "my-deployment" })));
    assert.ok(shown.includes('uses "my-deployment"'), shown);
  });

  test("carries nothing but colour, so no line can move the cursor", () => {
    const lines = welcomeFrame(props({ step: "model", models: many(300), model: 40, term: "mod" }));
    for (const line of lines) assert.doesNotMatch(line.replace(/\x1b\[[0-9;]*m/g, ""), /\x1b/);
  });
});
