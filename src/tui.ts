import { execFileSync } from "node:child_process";
import { COMMANDS, costText, helpText, INIT_PROMPT, skillsText, toolsText } from "./commands.ts";
import { forget } from "./onboard.ts";
import { createManager, type Session } from "./agents.ts";
import type { Skill } from "./skills.ts";
import { parseInvocation } from "./ui/invocation.ts";
import { ledgerLines, maxScroll, windowLines } from "./ui/ledger.ts";
import { authorisesRun, commandArgs, commandQuery, isPaletteOpen, moveSelection, paletteHeight, paletteRows, rankCandidates, skillCandidates, type Candidate } from "./ui/palette.ts";
import { openScreen, type Key } from "./ui/screen.ts";
import { count, strings } from "./ui/strings.ts";
import { glyph } from "./ui/tokens.ts";
import { frame, measureFrame, type Group, type Pane, type Row as ViewRow } from "./ui/views.ts";

const MAX_ROWS = 6;
const PAGE = 6;
const WHEEL = 3;

/** Fast enough that a running turn visibly ticks. `screen.draw` coalesces the rest. */
const TICK_MS = 33;

/** The spinner turns on its own clock, slower than the frame, or it blurs. */
const SPIN_MS = 90;

/** How long a first Ctrl-C stays armed. */
const DOUBLE_MS = 2000;

const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

const CONTROL = /[\x00-\x1f\x7f]/g;
/** The same, but `\n` survives — a paste is many characters and may be many lines. */
const PASTE = /[\x00-\x09\x0b-\x1f\x7f]/g;

const BUILTINS: Candidate[] = COMMANDS.map((command) => ({
  id: `cmd:${command.name}`,
  label: `/${command.name}`,
  meta: command.summary,
  run: `/${command.name}`,
}));

/** The last thing the agent said, for `/copy`. */
function copyLast(session: { entries: readonly { kind: string; text?: string }[] }): string {
  const answer = [...session.entries].reverse().find((entry) => entry.kind === "answer")?.text;
  if (!answer) return "Nothing to copy yet.";

  try {
    execFileSync("pbcopy", { input: answer });
    return `Copied ${answer.length} characters.`;
  } catch {
    return "Could not reach the clipboard.";
  }
}

/** The rail says what Enter does here, which is the one key that means two things. */
const KEYS: ReadonlyArray<readonly [string, string]> = [
  ["↵", "send"], ["esc", "stop"], ["/", "commands"], ["↑↓", "history"], ["^C", "quit"],
];

/** Running, then idle, then done. Empty groups are dropped so the roster never pads itself. */
function groupsOf(sessions: readonly Session[]): Group[] {
  const rows = (...states: string[]): ViewRow[] =>
    sessions
      .filter((session) => states.includes(session.state))
      .map((session) => ({ id: session.id, name: session.name, state: session.state, badge: badge(session) }));

  return [
    { title: "running", rows: rows("running") },
    { title: "idle", rows: rows("idle") },
    { title: "done", rows: rows("done", "error") },
  ].filter((group) => group.rows.length > 0);
}

/**
 * The right end of a roster row. A turn that failed says so instead of reporting how
 * long it took to fail, and a clock only appears once the manager has one to report.
 */
function badge(session: Session): string {
  const secs = session.usage.elapsedMs > 0 ? `${(session.usage.elapsedMs / 1000).toFixed(1)}s` : "";
  if (session.state === "error") return "error";
  if (session.state !== "running") return secs;
  return `${SPIN[Math.floor(Date.now() / SPIN_MS) % SPIN.length] ?? ""} ${secs}`.trim();
}

/** Ctrl-<letter>. Some decoders hand back the letter, others the raw control byte. */
function chord(key: Key, letter: string): boolean {
  if (!key.ctrl) return false;
  const text = key.text.length === 1 && key.text < " " ? String.fromCharCode(key.text.charCodeAt(0) + 96) : key.text;
  return text.toLowerCase() === letter;
}

/** `mouse` is passed through to the screen, which owns pointer reporting and raw mode. */
export type TuiOptions = { skills: Skill[]; apiKey: string; model?: string; baseURL?: string; mouse?: boolean };

export function runTui(options: TuiOptions): Promise<number> {
  // Event-driven, so there is no loop to await: the exit path resolves this instead.
  return new Promise<number>((resolve) => {
    // Skills lead, so a builtin can never outrank a skill that shares its name.
    const pool = [...skillCandidates(options.skills), ...BUILTINS];
    const skillNames = options.skills.map((skill) => skill.name);

    const state = {
      view: "agent" as Pane, selected: 0,
      value: "", cursor: 0, picked: false, paletteIndex: 0,
      history: [] as string[], historyIndex: 0,
      lastCtrlC: 0, note: "",
      /** Whether reasoning is unfolded. One setting for the whole transcript. */
      thinking: false,
    };

    let ticker: NodeJS.Timeout | null = null;
    let closed = false;

    const manager = createManager(options, render);
    const screen = openScreen(onKey, render);

    const flat = (): ViewRow[] => groupsOf(manager.sessions).flatMap((group) => group.rows);

    const current = (): Session | undefined => {
      const id = flat()[state.selected]?.id;
      return manager.sessions.find((session) => session.id === id);
    };

    // Selection is an index into the flattened roster, and a session changing state moves it
    // between groups, so anything that acts on one re-finds it once the state has settled.
    const focus = (id: string): void => {
      const at = flat().findIndex((row) => row.id === id);
      if (at >= 0) state.selected = at;
    };

    const spawn = (): Session => {
      const session = manager.create();
      focus(session.id);
      return session;
    };

    /** Every buffer change goes through here: a stale pick would run the wrong row. */
    function edit(value: string, cursor: number): void {
      state.value = value;
      state.cursor = cursor;
      state.picked = false;
      state.paletteIndex = 0;
    }

    /** The frame clock: pace text out, then draw. */
    function tick(): void {
      manager.drain();
      render();
    }

    function render(): void {
      const groups = groupsOf(manager.sessions);
      const rows = groups.flatMap((group) => group.rows);
      // Closing a session shortens the roster under the selection.
      state.selected = Math.max(0, Math.min(state.selected, rows.length - 1));

      const open = isPaletteOpen(state.value);
      const term = open ? commandQuery(state.value) : "";
      const pal = open ? rankCandidates(term, pool) : null;
      // The panel eats rows from the body, so it is measured before anything is laid out.
      const layout = measureFrame(screen.columns, screen.rows, pal ? paletteHeight(pal.length, MAX_ROWS) : 0);

      // Home sets the transcript in the detail column; the agent pane gets the whole width.
      const session = current();
      const width = layout.width;
      const body = session ? ledgerLines(session.entries, width, session.live, state.thinking) : [];

      screen.draw(frame({
        columns: screen.columns,
        rows: screen.rows,
        view: state.view,
        groups,
        selected: state.selected,
        transcript: windowLines(body, layout.bodyHeight, session?.scrollUp ?? 0),
        composer: { value: state.value, cursor: state.cursor, busy: session?.state === "running" },
        palette: pal ? paletteRows(pal, term, state.paletteIndex, layout.width, MAX_ROWS) : null,
        status: state.note || `${count(manager.sessions.length, "agent")} ${glyph.dot} ${manager.model}`,
        keys: KEYS,
      }));

      // Nothing else pushes a frame while a turn is thinking, so the clock does.
      const busy = manager.sessions.some((agent) => agent.state === "running");
      if (busy && !ticker) ticker = setInterval(tick, TICK_MS);
      else if (!busy && ticker) {
        clearInterval(ticker);
        ticker = null;
      }
    }

    /** The single exit. Guarded, because Ctrl-C and `/quit` can both arrive mid-teardown. */
    function exit(status: number, parting?: string): void {
      if (closed) return;
      closed = true;
      if (ticker) clearInterval(ticker);

      try {
        manager.abortAll();
      } finally {
        // A throwing abort must still not leave the terminal in raw mode.
        screen.close();
      }
      // Written after the screen is closed, so it lands in the scrollback the
      // user is returned to rather than on a frame that is about to be torn down.
      if (parting) process.stdout.write(`${parting}\n`);
      resolve(status);
    }

    /** Walks `history` from the end; index 0 is an empty buffer rather than an entry. */
    function recall(step: number): void {
      const at = Math.max(0, Math.min(state.history.length, state.historyIndex - step));
      state.historyIndex = at;
      state.value = at === 0 ? "" : (state.history[state.history.length - at] ?? "");
      state.cursor = state.value.length;
    }

    function scroll(page: boolean, up: boolean, palRows: number): void {
      const session = current();
      if (!session) return;

      // Re-measured rather than remembered: the terminal may have been resized since.
      const layout = measureFrame(screen.columns, screen.rows, palRows);
      const width = layout.width;
      const total = ledgerLines(session.entries, width, session.live, state.thinking).length;
      const step = (page ? layout.bodyHeight : WHEEL) * (up ? 1 : -1);

      // 0 is pinned to the tail, which is how new output follows without being chased.
      session.scrollUp = Math.max(0, Math.min(session.scrollUp + step, maxScroll(total, layout.bodyHeight)));
    }

    function submit(text: string): void {
      state.history.push(text);
      state.historyIndex = 0;
      // Cleared before dispatch, so a synchronous re-render cannot find it and send it twice.
      edit("", 0);

      const invocation = parseInvocation(text, skillNames);
      if (invocation.kind === "unknown") {
        state.note = invocation.message;
        return render();
      }

      const session = current() ?? spawn();
      manager.send(session.id, invocation.text, invocation.kind === "skill" ? [invocation.name] : []);
      focus(session.id);
      render();
    }

    /** Dispatched by `run` rather than by `id`, so what you typed is what decides. */
    function run(candidate: Candidate, args: string): void {
      edit("", 0);
      const target = current();

      const session = target ?? spawn();
      // Anything that runs to more than a phrase lands in the ledger; the status
      // row is for one line that is gone by the next turn.
      const say = (text: string): void => void session.entries.push({ kind: "note", text });

      switch (candidate.run) {
        case "/help": say(helpText(options.skills)); break;
        case "/skills": say(skillsText(options.skills)); break;
        case "/tools": say(toolsText(manager.tools())); break;
        case "/context": say(manager.systemPrompt()); break;
        case "/cost": say(costText(manager.cost())); break;
        case "/model": say(args ? manager.setModel(args) : `model: ${manager.model}`); break;
        case "/mode": say(manager.setMode(args)); break;
        case "/thinking":
          // Named on/off explicitly, or flipped when neither is given.
          state.thinking = args === "on" ? true : args === "off" ? false : !state.thinking;
          say(state.thinking ? strings.thinkingShown : strings.thinkingHidden);
          break;
        case "/clear": session.entries.length = 0; break;
        case "/reset": manager.reset(session.id); break;
        case "/copy": say(copyLast(session)); break;
        case "/init": manager.send(session.id, INIT_PROMPT, []); break;
        // The agent in memory still holds the old key, and rebuilding it mid-session
        // would leave the transcript answered by a provider that is no longer set.
        // Signing out is therefore the end of the session, not a state within it.
        case "/logout": {
          const { backup } = forget();
          return exit(0, backup ? strings.onboard.loggedOut(backup) : strings.onboard.noKey);
        }
        case "/quit": return exit(0);
        // Everything else is a skill the user named rather than one the model chose.
        default: manager.send(session.id, args || strings.explicitOnly, [candidate.run.slice(1)]);
      }

      focus(session.id);
      render();
    }

    function onKey(key: Key): void {
      const ctrlC = chord(key, "c");
      // Any other key acknowledges the note, including the second half of a Ctrl-C pair.
      if (!ctrlC) state.note = "";

      // Re-ranked here rather than remembered from the last frame: the row under the
      // cursor has to come from the same ranking the panel is currently showing.
      const open = isPaletteOpen(state.value);
      const term = open ? commandQuery(state.value) : "";
      const pal = open ? rankCandidates(term, pool) : null;
      const palRows = pal ? paletteHeight(pal.length, MAX_ROWS) : 0;

      if (ctrlC) {
        const session = current();
        if (session?.state === "running") manager.abort(session.id);
        // 130 is the conventional exit code for "terminated by Ctrl-C".
        else if (Date.now() - state.lastCtrlC < DOUBLE_MS) return exit(130);
        else state.note = "press ctrl-c again to exit";
        state.lastCtrlC = Date.now();
        return render();
      }

      // Ctrl-D is end-of-input, so it only means anything with nothing left to end.
      if (chord(key, "d") && state.value.length === 0) return exit(0);

      if (key.name === "escape") {
        const session = current();
        // Stopping the model comes first; clearing the whole buffer, rather than just the
        // query, is what drops out of command mode once there is nothing to stop.
        if (session?.state === "running") manager.abort(session.id);
        else if (open) edit("", 0);
        return render();
      }


      if (pal) {
        const row = pal[state.paletteIndex];

        if (key.name === "up" || key.name === "down" || key.name === "pageup" || key.name === "pagedown") {
          const step = key.name === "up" ? -1 : key.name === "down" ? 1 : key.name === "pageup" ? -PAGE : PAGE;
          state.paletteIndex = moveSelection(state.paletteIndex, step, pal.length);
          state.picked = true;
          return render();
        }
        // Still starts with `/`, so the panel stays open — now ranked on the exact name,
        // with a trailing space ready for whatever the skill is being asked to do.
        if (key.name === "tab" && row) {
          edit(`${row.candidate.run} `, row.candidate.run.length + 1);
          return render();
        }
        // An Enter that neither picked a row nor typed the name out falls through and is
        // sent as an ordinary prompt, so `/` is never a mode you have to escape from.
        if (key.name === "return" && row && (state.picked || authorisesRun(term, row))) {
          return run(row.candidate, commandArgs(state.value));
        }
      }

      if (key.name === "up" || key.name === "down") {
        recall(key.name === "up" ? -1 : 1);
        return render();
      }

      if (key.name === "pageup" || key.name === "pagedown" || key.name === "wheelup" || key.name === "wheeldown") {
        scroll(key.name.startsWith("page"), key.name === "pageup" || key.name === "wheelup", palRows);
        return render();
      }

      if (key.name === "return") {
        const text = state.value.trim();
        if (text.length > 0) return submit(text);
        return render();
      }

      if (key.ctrl) {
        const word = state.value.slice(0, state.cursor).replace(/\s*\S+\s*$/, "").length;
        const target = current();
        if (chord(key, "a")) state.cursor = 0;
        else if (chord(key, "e")) state.cursor = state.value.length;
        else if (chord(key, "u")) edit(state.value.slice(state.cursor), 0);
        else if (chord(key, "w")) edit(state.value.slice(0, word) + state.value.slice(state.cursor), word);
        else if (chord(key, "n")) spawn();
        else if (chord(key, "x") && target) manager.remove(target.id);
        return render();
      }

      const { value, cursor } = state;
      switch (key.name) {
        case "left": state.cursor = Math.max(0, cursor - 1); break;
        case "right": state.cursor = Math.min(value.length, cursor + 1); break;
        case "home": state.cursor = 0; break;
        case "end": state.cursor = value.length; break;
        case "backspace": edit(value.slice(0, Math.max(0, cursor - 1)) + value.slice(cursor), Math.max(0, cursor - 1)); break;
        case "delete": edit(value.slice(0, cursor) + value.slice(cursor + 1), cursor); break;
        // A paste arrives on this same channel, so control bytes go — but a multi-character
        // arrival keeps the newlines that are the whole point of pasting.
        case "char": {
          const text = key.text.replace(key.text.length > 1 ? PASTE : CONTROL, "");
          if (text.length > 0) edit(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length);
        }
      }
      render();
    }

    // An empty roster has nothing to type into, so the first agent is already there.
    spawn();
    render();
  });
}
