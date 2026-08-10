import { createAgent, type AgentEvent } from "./agent.ts";
import { createGate } from "./permission.ts";
import { createSmoother, type Smoother } from "./ui/stream.ts";
import type { Skill } from "./skills.ts";
import type { Entry } from "./ui/ledger.ts";
import { strings } from "./ui/strings.ts";

export type AgentState = "idle" | "running" | "done" | "error";

export type Session = {
  readonly id: string;
  name: string;
  state: AgentState;
  entries: Entry[];
  live: string;
  /** Reasoning held until the turn moves on, then placed as one entry. */
  thinking: string;
  scrollUp: number;
  skills: number;
  usage: { input: number; output: number; ttftMs: number; elapsedMs: number };
};

export type Manager = {
  readonly sessions: readonly Session[];
  readonly model: string;
  create(name?: string): Session;
  remove(id: string): void;
  send(id: string, text: string, activate?: readonly string[]): void;
  abort(id: string): void;
  abortAll(): void;
  /** Moves smoothed text into the sessions. Returns true if anything appeared. */
  drain(): boolean;
  /** What the commands need to answer for themselves. */
  systemPrompt(): string;
  tools(): ReadonlyArray<{ name: string; description?: string }>;
  cost(): { turns: number; input: number; output: number; elapsedMs: number };
  setModel(name: string): string;
  setMode(name: string): string;
  reset(id: string): void;
};

export type ManagerOptions = {
  skills: Skill[];
  apiKey: string;
  model?: string;
  baseURL?: string;
  maxTokens?: number;
  maxTurns?: number;
};

/** One agent and one abort per session, shared with nothing — the whole point. */
type Runtime = { agent: ReturnType<typeof createAgent>; controller: AbortController | null };

const NAME_WIDTH = 24;

/** `a7` was created as "agent 7", so a name still equal to that is untouched. */
const defaultName = (id: string): string => `agent ${id.slice(1)}`;

/** A prompt as a list row: enough words to recognise the work, and no more. */
function title(text: string): string {
  const words = text.trim().split(/\s+/).slice(0, 6).join(" ");
  return words.length > NAME_WIDTH ? `${words.slice(0, NAME_WIDTH - 1).trimEnd()}…` : words;
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createManager(options: ManagerOptions, onChange: () => void): Manager {
  const sessions: Session[] = [];
  const runtimes = new Map<string, Runtime>();
  let counter = 0;

  // Read off a throwaway agent rather than defaulted a second time here, so the
  // model the chrome names is exactly the one the turns go to.
  let chosen = createAgent(options).model;
  // One gate for every agent, so `/mode` reaches the turns already in flight.
  const gate = createGate("ask");
  const smoothers = new Map<string, Smoother>();

  /** Always a fresh entry: ledger.ts caches rendered lines by entry identity. */
  function flush(session: Session): void {
    // Whatever the smoother is still pacing belongs in the answer, not lost.
    session.live += smoothers.get(session.id)?.flush() ?? "";
    if (!session.live) return;
    session.entries.push({ kind: "answer", text: session.live });
    session.live = "";
  }

  /**
   * Lands the reasoning as one entry, just above whatever it led to.
   *
   * Held rather than streamed: thinking arrives a few characters at a time, and
   * repainting every session in the frame for each fragment would spend the
   * whole budget on text that is deliberately set in the margin.
   */
  function settle(session: Session): void {
    if (!session.thinking) return;
    session.entries.push({ kind: "thinking", text: session.thinking });
    session.thinking = "";
  }

  function handle(session: Session, event: AgentEvent): void {
    switch (event.type) {
      case "thinking_delta":
        // Accumulated silently; `settle` places it when the turn moves on.
        session.thinking += event.text;
        return;
      case "text_delta": {
        // The reply closes the reasoning above it.
        const settled = session.thinking !== "";
        if (settled) settle(session);
        // Queued rather than appended: the driver drains it a few characters at
        // a time so a 120-character block does not land as one jump.
        smoothers.get(session.id)?.push(event.text);
        // The smoother drives the repaint from here; only the reasoning landing
        // is a change the frame has to be told about.
        if (!settled) return;
        break;
      }
      case "skill_activated":
        // Whatever was said or thought before reaching for the skill belongs above it.
        flush(session);
        settle(session);
        session.entries.push({ kind: "tool", label: event.skill, brief: event.skill, metric: strings.skillMark });
        session.skills += 1;
        break;
      case "resource_loaded":
        session.entries.push({ kind: "tool", label: event.file, brief: event.file, metric: strings.resourceMark });
        break;
      case "tool_done":
        flush(session);
        settle(session);
        session.entries.push({
          kind: "tool",
          label: event.tool,
          brief: event.label,
          ...(event.failed ? { metric: strings.toolFailed } : {}),
        });
        break;
      case "usage":
        session.usage = { input: event.input, output: event.output, ttftMs: event.ttftMs, elapsedMs: event.elapsedMs };
        break;
      case "aborted":
        // Whatever arrived before the user gave up is still an answer, and it belongs above the note.
        flush(session);
        settle(session);
        session.entries.push({ kind: "note", text: strings.cancelled });
        break;
      // request_start and tool_call change nothing on screen, and redrawing for
      // them would repaint every session on every round trip.
      default:
        return;
    }
    onChange();
  }

  function create(name?: string): Session {
    const id = `a${(counter += 1)}`;
    const session: Session = {
      id,
      name: name ?? defaultName(id),
      state: "idle",
      entries: [],
      live: "",
      thinking: "",
      scrollUp: 0,
      skills: 0,
      usage: { input: 0, output: 0, ttftMs: 0, elapsedMs: 0 },
    };

    sessions.push(session);
    runtimes.set(id, { agent: createAgent({ ...options, model: chosen, gate }), controller: null });
    smoothers.set(id, createSmoother());
    onChange();
    return session;
  }

  function send(id: string, text: string, activate: readonly string[] = []): void {
    const session = sessions.find((item) => item.id === id);
    const runtime = runtimes.get(id);
    if (!session || !runtime) return;

    // An agent holds one message array. A second turn pushed through it would
    // splice its tool results into the first turn's history.
    if (session.state === "running") {
      session.entries.push({ kind: "note", text: "busy" });
      onChange();
      return;
    }

    if (session.name === defaultName(id)) session.name = title(text) || session.name;
    session.entries.push({ kind: "user", text });
    session.state = "running";

    const controller = new AbortController();
    runtime.controller = controller;

    // Deliberately not awaited: send() hands control straight back to the event
    // loop, which is what lets the other sessions draw and take keys meanwhile.
    void (async () => {
      try {
        await runtime.agent.send(text, (event) => handle(session, event), controller.signal, activate);
        flush(session);
        session.state = "done";
      } catch (error) {
        // Caught per session: one dead turn must not end the turns beside it.
        flush(session);
        session.entries.push({ kind: "error", text: reason(error) });
        session.state = "error";
      }
      runtime.controller = null;
      onChange();
    })();

    onChange();
  }

  function abort(id: string): void {
    runtimes.get(id)?.controller?.abort();
    onChange();
  }

  function abortAll(): void {
    for (const runtime of runtimes.values()) runtime.controller?.abort();
    onChange();
  }

  function remove(id: string): void {
    const index = sessions.findIndex((session) => session.id === id);
    if (index < 0) return;

    // A turn still in flight settles against a session that is no longer listed,
    // which is harmless — it mutates a detached object and redraws once.
    runtimes.get(id)?.controller?.abort();
    runtimes.delete(id);
    sessions.splice(index, 1);
    onChange();
  }

  /**
   * A fresh agent for an existing session. The conversation lives inside the
   * agent, so forgetting it means replacing the agent rather than clearing a list.
   */
  function reset(id: string): void {
    const session = sessions.find((entry) => entry.id === id);
    if (!session) return;
    runtimes.get(id)?.controller?.abort();
    runtimes.set(id, { agent: createAgent({ ...options, model: chosen, gate }), controller: null });
    session.entries.length = 0;
    session.live = "";
    session.usage = { input: 0, output: 0, ttftMs: 0, elapsedMs: 0 };
    session.skills = 0;
    onChange();
  }

  /** Pulls whatever the pacing says should be visible by now. */
  function drain(): boolean {
    let moved = false;
    for (const session of sessions) {
      const text = smoothers.get(session.id)?.drain() ?? "";
      if (!text) continue;
      session.live += text;
      moved = true;
    }
    return moved;
  }

  const totals = (): { turns: number; input: number; output: number; elapsedMs: number } =>
    sessions.reduce(
      (sum, session) => ({
        turns: sum.turns + session.entries.filter((entry) => entry.kind === "answer").length,
        input: sum.input + session.usage.input,
        output: sum.output + session.usage.output,
        elapsedMs: sum.elapsedMs + session.usage.elapsedMs,
      }),
      { turns: 0, input: 0, output: 0, elapsedMs: 0 },
    );

  /** Takes effect on the next agent built, so existing conversations keep their model. */
  function setModel(name: string): string {
    chosen = name;
    return `model: ${name} — applies to new agents`;
  }

  const probe = createAgent({ ...options, model: chosen, gate });

  return {
    sessions,
    get model() {
      return chosen;
    },
    create,
    remove,
    send,
    abort,
    abortAll,
    reset,
    drain,
    setModel,
    systemPrompt: () => probe.systemPrompt,
    tools: () => probe.tools,
    cost: totals,
    setMode: (name) => {
      if (name !== "ask" && name !== "auto") return `mode: ${gate.mode} — say ask or auto`;
      gate.setMode(name);
      return `mode: ${name}`;
    },
  };
}
