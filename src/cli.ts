#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { createAgent, type AgentEvent } from "./agent.ts";
import { readClientConfig } from "./config.ts";
import { askForKey, envLines, save } from "./onboard.ts";
import { discoverSkills, type Skill, type Warning } from "./skills.ts";
import { runTui } from "./tui.ts";
import {
  aboutBlock,
  bannerFrames,
  bannerLapFrames,
  bannerLines,
  failure,
  goatArea,
  notice,
  openAnswer,
  openThought,
  railAnswer,
  railThought,
  resourceLine,
  skillLine,
  thought,
  toolLine,
} from "./ui/chrome.ts";
import { turnStatus } from "./ui/hud.ts";
import { createWrapper, measure } from "./ui/layout.ts";
import { composer, opening } from "./ui/session.ts";
import { parseInvocation, type Invocation } from "./ui/invocation.ts";
import { createMarkdownStream } from "./ui/markdown.ts";
import { play, repaint } from "./ui/motion.ts";
import { trackClicks } from "./ui/pointer.ts";
import { strings } from "./ui/strings.ts";
import { color, cursor, motion, rule, space } from "./ui/tokens.ts";

/** Sixty frames a second. Below that the goat visibly steps rather than runs. */
const FRAME_MS = 16;

/** How long `goat` has to sit on the prompt before the goat takes it. */
const SETTLE_MS = 250;

/** Shown on the first-run screen, so it matches what was installed. */
const VERSION = `v${process.env["npm_package_version"] ?? "1.0.0"}`;

/** The skills a parsed line named, for handing to `agent.send`. */
const named = (invocation: Invocation): string[] =>
  invocation.kind === "skill" ? [invocation.name] : [];

function reportWarnings(warnings: Warning[]): void {
  for (const warning of warnings) {
    process.stderr.write(`${space.gutter}${color.muted(warning.path)}\n${space.indent}${color.dim(warning.message)}\n`);
  }
}

/** Renders agent events as they arrive. */
function createRenderer(verbose: boolean, expand: boolean) {
  const out = (text: string): void => void process.stdout.write(text);

  // Column 0 carries ◆ on the first line of an answer and the rail on every line
  // after, so a reply reads as one block instead of as loose paragraphs.
  let opened = false;
  const markdown = createMarkdownStream((text) => {
    const gutter = opened ? railAnswer() : openAnswer();
    opened = true;
    out(text === "\n" ? `${railAnswer().trimEnd()}\n` : `${gutter}${text}`);
  });

  // Reasoning gets its own lane: dim, rail-led, and closed before the answer
  // opens, so the working-out can never be mistaken for the reply.
  //
  // Folded to its opening line unless asked for. A scrolling transcript cannot
  // be re-folded once it is written, so the choice has to be made before the
  // text lands rather than after — which is what `--thinking` is for.
  let thinkingOpen = false;
  let folded = 0;
  const thinking = createWrapper(Math.max(8, measure() - 2), (line) => {
    if (!expand && thinkingOpen) {
      folded += 1;
      return;
    }
    out(`${thinkingOpen ? railThought() : openThought()}${thought(line)}\n`);
    thinkingOpen = true;
  });

  const endThinking = (): void => {
    thinking.end();
    if (thinkingOpen) {
      if (folded > 0) out(`${space.gutter}${color.muted(strings.moreWith(folded, strings.thinkingFlag))}\n`);
      out("\n");
    }
    thinkingOpen = false;
    folded = 0;
  };

  let skillsUsed = 0;
  let wroteAnything = false;
  let usage = { input: 0, output: 0, ttftMs: 0, elapsedMs: 0 };
  // What the agent did and what it said are separate things, so a blank line
  // goes between them — but only if there was any work to separate from.
  let separateFromWork = false;

  const work = (row: string): void => {
    // Anything the model said or thought before reaching for a tool has to land
    // first, otherwise this row prints above what came before it.
    endThinking();
    markdown.flush();
    out(`${row}\n`);
    separateFromWork = true;
  };

  const handle = (event: AgentEvent): void => {
    switch (event.type) {
      case "thinking_delta":
        if (separateFromWork) {
          out("\n");
          separateFromWork = false;
        }
        thinking.push(event.text);
        return;

      case "text_delta":
        // The reply closes the reasoning above it, whatever the model does next.
        endThinking();
        if (separateFromWork && event.text.trim().length > 0) {
          out("\n");
          separateFromWork = false;
        }
        wroteAnything ||= event.text.trim().length > 0;
        markdown.push(event.text);
        return;

      case "request_start":
        // A later turn is a fresh block of prose. Without this, its first words
        // run straight on from the tail of the previous turn's last sentence.
        if (event.turn > 0) markdown.flush();
        return;

      case "tool_call":
        // The row itself is drawn on tool_done, which knows what the tool
        // actually acted on. This is the raw arguments, for --verbose only.
        if (verbose) out(`${space.gutter}${color.dim(`${event.tool} ${JSON.stringify(event.input)}`)}\n`);
        return;

      case "tool_done":
        work(toolLine(event.tool, event.label, event.failed));
        return;

      case "skill_activated":
        skillsUsed += 1;
        work(skillLine(event.skill));
        return;

      case "resource_loaded":
        work(resourceLine(event.file));
        return;

      case "usage":
        usage = { input: event.input, output: event.output, ttftMs: event.ttftMs, elapsedMs: event.elapsedMs };
        return;

      case "aborted":
        markdown.end();
        out(`\n${notice(strings.cancelled)}\n`);
        return;
    }
  };

  /** Closes the answer, and adds the status row only if it earned its line. */
  const finish = (): void => {
    // A turn that only thought still has to close its lane.
    endThinking();
    markdown.end();

    if (wroteAnything) {
      const row = turnStatus({ skills: skillsUsed, ...usage });
      if (row !== null) out(`\n${row}\n`);
    }

    // Cleared at the end of a turn rather than the start of the next one, so
    // anything that happens before the first request still counts.
    opened = false;
    skillsUsed = 0;
    wroteAnything = false;
    separateFromWork = false;
    usage = { input: 0, output: 0, ttftMs: 0, elapsedMs: 0 };
  };

  return { handle, endLine: finish };
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: {
      verbose: { type: "boolean", short: "v", default: false },
      "skills-dir": { type: "string", multiple: true },
      model: { type: "string" },
      thinking: { type: "boolean", default: false },
      "no-mouse": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(strings.help);
    return 0;
  }

  // Both animations hide the cursor and both put it back, but neither gets to run if the
  // process dies between those two writes.
  if (motion) process.once("exit", () => void process.stdout.write(cursor.show));

  let config = readClientConfig();
  if (!config) {
    // With a terminal on both ends there is a screen to ask on; piped, there is
    // nobody to answer, so the old message is still the right outcome.
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error(failure(strings.missingKey));
      console.error(notice(strings.missingKeyHelp));
      return 1;
    }

    const chosen = await askForKey(VERSION);
    if (!chosen) return 1;

    const values = envLines(chosen.provider, chosen.apiKey, chosen.model, chosen.baseURL);
    const path = save(values);
    Object.assign(process.env, values);
    console.log(notice(strings.onboard.saved(path)));

    config = readClientConfig();
    if (!config) return 1;
  }

  const roots = values["skills-dir"]?.map((dir) => resolve(dir));
  const { skills, warnings } = discoverSkills(roots ? { roots } : {});

  if (warnings.length > 0) reportWarnings(warnings);
  if (skills.length === 0) console.error(notice(strings.noSkills));

  // --model beats ANTHROPIC_MODEL, which beats the built-in default.
  const agent = createAgent({ skills, ...config, ...(values.model ? { model: values.model } : {}) });

  // The exact bytes sent as the system prompt. Everything the model knows about
  // skills before it calls a tool is in here — and no skill body is.
  if (values.verbose) {
    console.log(notice(strings.systemPromptLabel(skills.length)));
    console.log(`${space.gutter}${rule()}`);
    console.log(agent.systemPrompt);
    console.log(`${space.gutter}${rule()}\n`);
  }

  // --verbose already prints everything else; it opens this too.
  const renderer = createRenderer(values.verbose, values.verbose || values.thinking);
  const skillNames = skills.map((skill) => skill.name);
  const prompt = positionals.join(" ").trim();

  if (prompt) {
    const invocation = parseInvocation(prompt, skillNames);
    if (invocation.kind === "unknown") {
      console.error(failure(invocation.message));
      return 1;
    }

    const cancel = new AbortController();
    process.once("SIGINT", () => cancel.abort());

    // The answer is printed by the renderer as it streams, so the return value
    // is deliberately ignored here.
    await agent.send(invocation.text, renderer.handle, cancel.signal, named(invocation));
    renderer.endLine();
    // 130 is the conventional exit code for "terminated by Ctrl-C".
    return cancel.signal.aborted ? 130 : 0;
  }

  // The full-screen TUI needs a terminal on both ends: with either side piped it
  // returns a screen that never emits a key, and waiting on it would hang. Piped
  // input falls back to the scrolling session, which reads fine in a log.
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return runTui({ skills, ...config, ...(values.model ? { model: values.model } : {}), mouse: !values["no-mouse"] });
  }

  return runInteractive(agent, skills, renderer, !values["no-mouse"]);
}

async function runInteractive(
  agent: ReturnType<typeof createAgent>,
  skills: Skill[],
  renderer: ReturnType<typeof createRenderer>,
  mouse: boolean,
): Promise<number> {
  const write = (text: string): void => void process.stdout.write(text);
  const skillNames = skills.map((skill) => skill.name);
  const skillCount = skills.length;

  let inFlight: AbortController | null = null;
  let running = false;

  // Tracking starts before the banner: from here stdin is ours, so anything typed during the
  // entrance is held and handed to readline when it opens rather than lost to a prompt that
  // did not exist yet.
  const pointer = mouse ? trackClicks((column, row) => void poke({ column, row })) : null;

  // The goat runs in, then steps aside: the entrance is identity, and the screen
  // that follows is the one you work in. Awaited, because a prompt drawn under a
  // still-running goat reads as a glitch, and skipped when input is piped —
  // there is nobody watching, and the delay is latency the sender pays.
  const entrance = bannerFrames(skillCount);
  if (process.stdin.isTTY) {
    await play(entrance, FRAME_MS, write);
    write(cursor.up(entrance.at(-1)?.length ?? 0) + cursor.clearBelow);
  }

  write(`${opening(skills, agent.model)}\n`);

  /** How far the cursor sits below the banner's first row — a distance, not a remembered row number. */
  let depth = 0;

  /** Whether the banner is showing the goat's details instead of the wordmark. */
  let telling = false;

  /** What the goat has to say: the catalog it is guarding, and nothing it isn't. */
  const about = (): string[] =>
    strings.goat.about(skillCount, Buffer.byteLength(agent.systemPrompt), agent.model);

  /** Poke the goat, by click or by typing its name. */
  async function poke(hit?: { column: number; row: number }): Promise<boolean> {
    // Not while the agent is working — the screen belongs to the answer then.
    // Not while a lap is running either, or the two would draw over each other.
    if (!pointer || inFlight || running) return false;

    const frames = bannerLapFrames(
      telling ? about() : bannerLines(skillCount),
      telling ? bannerLines(skillCount) : about(),
    );
    if (frames.length === 0) return false;

    // A click reports an absolute row, so one absolute reference is needed to compare it
    // against.
    const at = await pointer.where();
    if (!at) return false;

    const top = at.row - depth;
    // Scrolled off the top of the screen. There is no goat up there to run.
    if (top < 1) return false;

    // A click is aimed at the goat and nothing else, so that clicking into your own
    // half-written sentence puts the cursor there instead of setting an animal off.
    if (hit) {
      const goatTop = top + goatArea.row;
      if (hit.row < goatTop || hit.row >= goatTop + goatArea.rows) return false;
      if (hit.column < goatArea.column || hit.column >= goatArea.column + goatArea.columns) return false;
    }

    running = true;
    pointer.hold();
    try {
      write(`${cursor.save}${cursor.up(depth)}${cursor.home}`);
      await repaint(frames, FRAME_MS, write);
      write(cursor.restore);
      telling = !telling;
      return true;
    } finally {
      pointer.resume();
      running = false;
    }
  }

  // Opened *after* the animation, and that ordering is load-bearing.
  const rl = pointer
    ? createInterface({ input: pointer.keys, output: process.stdout, terminal: true })
    : createInterface({ input: process.stdin, output: process.stdout });

  // Ctrl-C means two different things depending on what is happening.
  rl.on("SIGINT", () => {
    if (inFlight) {
      inFlight.abort();
      return;
    }
    // Releasing first is what actually ends the session: it closes the stream readline is
    // reading, which is the only thing readline treats as the end of input when that stream is
    // not the terminal itself.
    pointer?.release();
    rl.close();
  });

  /** Typing the goat's name is the whole gesture — there is nothing to submit. */
  if (pointer) {
    let settling: NodeJS.Timeout | null = null;

    pointer.keys.on("keypress", () => {
      // Every keystroke cancels the one before it: "goat facts, please" passes
      // through the word on its way somewhere else and never settles on it.
      if (settling) clearTimeout(settling);
      if (running || inFlight || rl.line.trim() !== strings.goat.command) return;

      settling = setTimeout(() => {
        if (running || inFlight || rl.line.trim() !== strings.goat.command) return;

        rl.write(null, { ctrl: true, name: "u" });
        void poke().then((ran) => {
          if (!ran) rl.write(strings.goat.command);
        });
      }, SETTLE_MS);
      settling.unref?.();
    });
  }

  try {
    while (true) {
      // The prompt is written the moment `question` is called, and it lands two
      // rows lower than where the cursor was: its own blank line, then its rule.
      const asked = rl.question(composer());
      depth += 2;

      const line = (await asked).trim();
      // ...and readline echoed the newline that submitted it.
      depth += 1;

      if (line.length === 0) continue;
      if (line === "exit" || line === "quit") break;

      // Answered here rather than sent to the model — paying for a round trip to be told about
      // our own mascot would be the joke going wrong.
      if (line === strings.goat.command) {
        if (!(await poke())) {
          const said = aboutBlock(about());
          write(`${said}\n`);
          depth += said.split("\n").length;
        }
        continue;
      }

      // Clickable until there is work on screen, then not again.
      pointer?.disarm();

      const invocation = parseInvocation(line, skillNames);
      if (invocation.kind === "unknown") {
        console.error(`\n${failure(invocation.message)}`);
        continue;
      }

      inFlight = new AbortController();
      try {
        // One blank line between what you asked and what comes back.
        process.stdout.write("\n");
        await agent.send(invocation.text, renderer.handle, inFlight.signal, named(invocation));
        renderer.endLine();
      } catch (error) {
        renderer.endLine();
        console.error(failure((error as Error).message));
      } finally {
        inFlight = null;
      }
    }
  } catch {
    // readline throws when the stream closes on Ctrl-D. That is a normal exit.
  } finally {
    // Before `rl.close()`, so the terminal is out of raw mode and out of mouse
    // reporting even if closing throws.
    pointer?.release();
    rl.close();
  }

  return 0;
}

// Set the exit code and let Node exit on its own.
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(failure((error as Error).message));
    process.exitCode = 1;
  });
