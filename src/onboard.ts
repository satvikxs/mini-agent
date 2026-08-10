import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  envLines,
  fallbackModels,
  fetchModels,
  filterModels,
  PROVIDERS,
  type Model,
  type Provider,
} from "./providers.ts";
import { ping } from "./wire.ts";
import { openScreen, type Key } from "./ui/screen.ts";
import { strings } from "./ui/strings.ts";
import { ARRIVAL_LENGTH, welcomeFrame, type Step } from "./ui/welcome.ts";

const ENV = resolve(import.meta.dirname, "..", ".env");

/** Sixty frames a second, for the run-in only. */
const FRAME_MS = 16;

/** Once the goat has arrived: fast enough for a spinner, cheap enough to idle on. */
const IDLE_MS = 100;

export type Chosen = { provider: Provider; apiKey: string; baseURL: string; model: string };

/**
 * Confirms the key against the endpoint before it is written.
 *
 * A key saved unverified fails later, wrapped in whatever the first real turn
 * was doing. One `max_tokens: 1` request turns "it does not work" into a
 * sentence about the key, and catches the commonest mistake of all — the right
 * key against the wrong endpoint.
 */
async function check(provider: Provider, apiKey: string, baseURL: string, model: string): Promise<string | null> {
  try {
    // Over whichever wire this model actually speaks, so that a Claude model
    // and an open one are each checked against the route that will serve them.
    await ping({ apiKey, ...(baseURL ? { baseURL } : {}), model });
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Before the 401/403 catch-all, and that ordering is the point: a plan
    // without API access is refused with a 403 over a key that is perfectly
    // good, and "that key was refused" would send someone to re-paste it for as
    // long as their patience held. The endpoint names the plan and where to
    // change it, so its sentence is better than any of ours.
    if (/permission_error|upgrade_required/i.test(message)) return summarise(message);
    if (/401|403|invalid.*key|unauthor/i.test(message)) return strings.onboard.refused;
    if (/404|not.?found/i.test(message)) return `Nothing serving that model there — no "${model}".`;
    // Reachable, and not hypothetically: Command Code carries Sonnet 5 and 4.6
    // but not 4.5, and answers 400 rather than 404 for the one it lacks.
    if (/unsupported_model|not supported|does not exist/i.test(message)) {
      return `That endpoint does not host "${model}".`;
    }
    if (/ENOTFOUND|EAI_AGAIN|fetch failed/i.test(message)) return "Could not reach that endpoint.";
    return summarise(message);
  }
}

/**
 * One line of the endpoint's own words, for a failure nothing above anticipated.
 *
 * The SDK puts the whole response body in `message`, so truncating it raw spends
 * the width on `400 {"type":"error","error":{"type":...` and cuts off before the
 * sentence a person could act on. That sentence is the innermost `message`.
 *
 * Fitting it to the screen is the screen's job — this only bounds a response
 * that turns out to be a page of HTML rather than a line of JSON.
 */
function summarise(message: string): string {
  const detail = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(message)?.[1];
  const text = detail === undefined ? message : detail.replace(/\\(["\\])/g, "$1");
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Written, never printed, and readable only by its owner. */
export function save(values: Record<string, string>): string {
  let text = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";

  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    // Replaced rather than appended: dotenv takes the first occurrence, so an
    // existing empty placeholder would keep winning.
    text = new RegExp(`^${key}=.*$`, "m").test(text)
      ? text.replace(new RegExp(`^${key}=.*$`, "m"), line)
      : `${text}${text.endsWith("\n") || text === "" ? "" : "\n"}${line}\n`;
  }

  writeFileSync(ENV, text.endsWith("\n") ? text : `${text}\n`);
  chmodSync(ENV, 0o600);
  return ENV;
}

/** The three lines onboarding writes, and the only ones logging out removes. */
const CREDENTIALS = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"];

/**
 * Signs out: drops the credentials from .env so the next run asks again.
 *
 * The old file is kept beside it as `.env.bak` rather than overwritten. A key is
 * a thing someone had to go and fetch, and "log out" should not be the same
 * gesture as "lose it" — .gitignore covers the copy.
 */
export function forget(): { path: string; backup: string | null } {
  if (!existsSync(ENV)) return { path: ENV, backup: null };

  const before = readFileSync(ENV, "utf8");
  const backup = `${ENV}.bak`;
  writeFileSync(backup, before);
  chmodSync(backup, 0o600);

  const after = before
    .split("\n")
    .filter((line) => !CREDENTIALS.some((key) => line.startsWith(`${key}=`)))
    .join("\n");

  writeFileSync(ENV, after.trim() === "" ? "" : after);
  chmodSync(ENV, 0o600);
  return { path: ENV, backup };
}

/** Resolves once a key is accepted, or null if the user leaves. */
export function askForKey(version: string): Promise<Chosen | null> {
  return new Promise((done) => {
    let step: Step = "provider";
    let selected = 0;
    let model = 0;
    /** Everything the endpoint offers, before the filter narrows it. */
    let offered: Model[] = [];
    let term = "";
    let value = "";
    let endpoint = "";
    let message = "";
    let frame = 0;
    let ticker: NodeJS.Timeout | null = null;
    let closed = false;
    /** Which request a rejection came from, so ↵ retries that one and not the other. */
    let retry: () => void = () => void load();

    const provider = (): Provider => PROVIDERS[selected] ?? PROVIDERS[0]!;
    const endpointFor = (chosen: Provider): string => (chosen.id === "custom" ? endpoint : chosen.baseURL);

    /** The rows on screen, and the list every index counts against. */
    const shown = (): Model[] => filterModels(offered, term);

    const screen = openScreen(onKey, render);

    /**
     * One clock for the whole screen, and it changes gear.
     *
     * The run-in needs 60fps — below that the goat visibly steps rather than
     * runs. Once it has arrived there is only a blink and a spinner left, and
     * holding 60fps for those would burn a frame every 16ms on a screen that is
     * mostly sitting still waiting for someone to type.
     */
    function clock(every: number): void {
      if (ticker) clearInterval(ticker);
      ticker = setInterval(() => {
        frame += 1;
        if (frame === ARRIVAL_LENGTH) clock(IDLE_MS);
        render();
      }, every);
      ticker.unref();
    }

    function render(): void {
      screen.draw(
        welcomeFrame({
          columns: screen.columns,
          rows: screen.rows,
          version,
          step,
          providers: PROVIDERS,
          selected,
          models: shown(),
          model,
          term,
          value,
          message,
          frame,
        }),
      );
    }

    function finish(result: Chosen | null): void {
      if (closed) return;
      closed = true;
      if (ticker) clearInterval(ticker);
      screen.close();
      done(result);
    }

    /**
     * Asks the endpoint what it hosts, then offers exactly that.
     *
     * Doubles as the first test of the key: a model list is a cheap request
     * that still needs authorisation, so a bad key is caught here rather than
     * after someone has also picked a model. An endpoint with no list is not an
     * error — the curated list stands in, and the filter can still reach past it.
     */
    async function load(): Promise<void> {
      step = "checking";
      message = strings.onboard.asking;
      render();

      const chosen = provider();
      const catalog = await fetchModels(chosen, value.trim(), endpointFor(chosen));

      if (catalog.kind === "refused") {
        step = "rejected";
        message = strings.onboard.refused;
        retry = () => void load();
        return render();
      }

      offered = catalog.kind === "live" ? catalog.models : fallbackModels(chosen);
      model = 0;
      term = "";
      message = "";
      step = "model";
      render();
    }

    async function verify(): Promise<void> {
      step = "checking";
      message = strings.onboard.checking;
      render();

      const chosen = provider();
      const baseURL = endpointFor(chosen);
      // Falling back to the term is what makes a model the endpoint never
      // listed reachable at all — see the empty-list case on the model screen.
      const id = shown()[model]?.id ?? term.trim();
      const failure = await check(chosen, value.trim(), baseURL, id);

      if (failure) {
        step = "rejected";
        message = failure;
        retry = () => void verify();
        // The rejected key stays in the field: a typo is worth correcting, and
        // retyping forty characters to fix one is not.
        return render();
      }

      finish({ provider: chosen, apiKey: value.trim(), baseURL, model: id });
    }

    function advance(): void {
      // Checked last, against the model that was actually picked — verifying a
      // different one would reject a good key on an endpoint that happens not to
      // host it, and would not prove the name being written to .env works.
      if (step === "model") return void verify();

      if (step === "provider") {
        step = provider().id === "custom" ? "endpoint" : "key";
        value = "";
        return render();
      }

      if (step === "endpoint") {
        if (value.trim().length === 0) {
          message = strings.onboard.noUrl;
          step = "rejected";
          return render();
        }
        endpoint = value.trim().replace(/\/+$/, "");
        value = "";
        step = "key";
        return render();
      }

      if (value.trim().length === 0) {
        message = strings.onboard.empty;
        step = "rejected";
        retry = () => void load();
        return render();
      }

      void load();
    }

    function onKey(key: Key): void {
      if (step === "checking") return;
      if (key.ctrl && (key.text.toLowerCase() === "c" || key.text.toLowerCase() === "d")) return finish(null);

      if (key.name === "escape") {
        // Back one question, or out of a rejection into the field it is shown over.
        if (step === "rejected") step = "key";
        else if (step === "model") step = "key";
        else if (step === "key" && provider().id === "custom") step = "endpoint";
        else if (step !== "provider") {
          step = "provider";
          value = "";
        }
        return render();
      }

      if (step === "provider") {
        const length = PROVIDERS.length;
        if (key.name === "up") selected = (selected - 1 + length) % length;
        else if (key.name === "down") selected = (selected + 1) % length;
        else if (key.name === "return") return advance();
        else return;
        return render();
      }

      // The model list is a list *and* a text field, because a provider can
      // offer more rows than anyone wants to arrow through — and because the
      // field is the only way to name a model the endpoint did not list.
      if (step === "model") {
        const length = shown().length;

        if (key.name === "up") model = length === 0 ? 0 : (model - 1 + length) % length;
        else if (key.name === "down") model = length === 0 ? 0 : (model + 1) % length;
        else if (key.name === "return") return advance();
        else if (key.name === "backspace") term = term.slice(0, -1);
        else if (key.name === "char" && !key.ctrl) term += key.text.replace(/[\r\n\t]/g, "");
        else return;

        // Any edit re-ranks the rows under the cursor, so it goes back to the
        // top rather than pointing at whatever now happens to sit at its index.
        if (key.name === "backspace" || key.name === "char") model = 0;
        return render();
      }

      // Retrying an unchanged key is worth offering: half of these failures are
      // a gateway hiccup rather than a bad key.
      if (step === "rejected" && key.name === "return") return retry();

      if (key.name === "return") return advance();

      if (key.name === "backspace") value = value.slice(0, -1);
      // A pasted key arrives as one chunk, and some terminals append a newline.
      else if (key.name === "char" && !key.ctrl) value += key.text.replace(/[\r\n\t]/g, "");
      else return;

      // Typing over a rejection is how a typo gets fixed, so the error clears
      // the moment the field changes rather than sitting under the correction.
      if (step === "rejected") step = "key";
      render();
    }

    clock(FRAME_MS);
    render();
  });
}

export { envLines };
