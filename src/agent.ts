import { buildSystemPrompt } from "./catalog.ts";
import type { Skill } from "./skills.ts";
import { createSkillTools, type ToolEvent } from "./tools.ts";
import { createToolkit } from "./toolkit.ts";
import type { Gate } from "./permission.ts";
import { openWire, type Result } from "./wire.ts";
import { describe, openWorkspace, type Workspace } from "./workspace.ts";

/** Everything the UI can react to. */
export type AgentEvent =
  | ToolEvent
  /** A request is in flight. Nothing will arrive until the first text_delta. */
  | { type: "request_start"; turn: number }
  /** A fragment of the answer, as it is generated. */
  | { type: "text_delta"; text: string }
  /** A fragment of the model's reasoning. Never part of the answer. */
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call"; tool: string; input: unknown }
  /** A workspace tool finished. `label` is what it acted on. */
  | { type: "tool_done"; tool: string; label: string; failed: boolean }
  /** What the turn cost, once it is over. */
  | { type: "usage"; input: number; output: number; ttftMs: number; elapsedMs: number }
  /** The turn was cancelled. Whatever text arrived first is still valid. */
  | { type: "aborted" };

export type Agent = {
  /** Exactly what is sent as the system prompt. Printed by `--verbose`. */
  readonly systemPrompt: string;
  /** The model these turns actually go to, after all the defaulting. */
  readonly model: string;
  /** Every tool the model is offered, for `/tools`. */
  readonly tools: ReadonlyArray<{ name: string; description?: string }>;
  /** Sends one user turn. */
  send(
    userText: string,
    onEvent?: (event: AgentEvent) => void,
    signal?: AbortSignal,
    activate?: readonly string[],
  ): Promise<string>;
};

export type AgentOptions = {
  skills: Skill[];
  apiKey: string;
  model?: string;
  /**
   * The gateway root. Both wire formats hang off it — `/v1/messages` for Claude
   * and `/v1/chat/completions` for everything else — so one URL covers both.
   */
  baseURL?: string;
  maxTokens?: number;
  /** Safety net: stop after this many round trips, in case the model loops. */
  maxTurns?: number;
  /** Where file tools and shell commands are confined to. Defaults to the cwd. */
  workspace?: Workspace;
  /** Shared across agents so a mode change reaches all of them. */
  gate?: Gate;
};

export function createAgent(options: AgentOptions): Agent {
  // 8192 rather than 4096 because thinking and the answer share this budget: a
  // cap costs nothing unused, but one set too low truncates the reply to make
  // room for the reasoning that preceded it.
  const { skills, apiKey, baseURL, model = "claude-sonnet-5", maxTokens = 8192, maxTurns = 8 } = options;

  const tools = createSkillTools(skills);
  const workspace = options.workspace ?? openWorkspace();
  const toolkit = createToolkit(workspace, options.gate);
  const systemPrompt = buildSystemPrompt(skills, describe(workspace));

  // Skill tools only exist when there are skills; the workspace tools always do.
  const offered = [...(skills.length > 0 ? tools.definitions : []), ...toolkit.definitions];
  const wire = openWire({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    model,
    system: systemPrompt,
    tools: offered,
    maxTokens,
  });

  async function send(
    userText: string,
    onEvent?: (event: AgentEvent) => void,
    signal?: AbortSignal,
    activate: readonly string[] = [],
  ): Promise<string> {
    // Where the conversation stood before this turn.
    const checkpoint = wire.length;
    let answer = "";

    const startedAt = Date.now();
    let firstTokenAt = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    // Skills the user named directly.
    const preloaded = activate
      .map((name) => {
        const outcome = tools.run("load_skill", { name });
        if (outcome.event) onEvent?.(outcome.event);
        return outcome.isError ? "" : outcome.content;
      })
      .filter(Boolean);

    wire.user(preloaded.length > 0 ? `${preloaded.join("\n\n")}\n\n${userText}` : userText);

    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        onEvent?.({ type: "request_start", turn });

        // Rejects if the request fails or is aborted, so both surface here
        // rather than through an unhandled event.
        const response = await wire.send(
          {
            text: (delta) => {
              firstTokenAt ||= Date.now();
              answer += delta;
              onEvent?.({ type: "text_delta", text: delta });
            },
            // Counts toward time-to-first-token: the wait is over the moment
            // anything arrives, and reasoning is the first thing that does.
            thinking: (delta) => {
              firstTokenAt ||= Date.now();
              onEvent?.({ type: "thinking_delta", text: delta });
            },
          },
          signal,
        );

        // Summed across turns: one question that took three round trips cost the
        // reader all three, so reporting only the last would understate it.
        inputTokens += response.input;
        outputTokens += response.output;

        if (response.stop !== "tools") {
          onEvent?.({
            type: "usage",
            input: inputTokens,
            output: outputTokens,
            ttftMs: firstTokenAt ? firstTokenAt - startedAt : 0,
            elapsedMs: Date.now() - startedAt,
          });

          const text = response.text.trim();
          // Say so rather than handing back a sentence that stops mid-word.
          return response.stop === "length" ? `${text}\n\n[cut off at the ${maxTokens}-token limit]` : text;
        }

        const results: Result[] = [];
        for (const call of response.calls) {
          onEvent?.({ type: "tool_call", tool: call.name, input: call.input });

          if (toolkit.owns(call.name)) {
            const outcome = await toolkit.run(call.name, call.input);
            onEvent?.({ type: "tool_done", tool: call.name, label: outcome.label, failed: outcome.isError });
            results.push({ id: call.id, content: outcome.content, isError: outcome.isError });
            continue;
          }

          const outcome = tools.run(call.name, call.input);
          if (outcome.event) onEvent?.(outcome.event);
          results.push({ id: call.id, content: outcome.content, isError: outcome.isError });
        }

        wire.results(results);
      }

      return `Stopped after ${maxTurns} turns without a final answer.`;
    } catch (error) {
      wire.rewind(checkpoint);

      // A cancellation is a normal outcome, not a failure: hand back whatever
      // arrived before the user changed their mind.
      if (signal?.aborted) {
        onEvent?.({ type: "aborted" });
        return answer.trim();
      }
      throw error;
    }
  }

  return { systemPrompt, model, tools: [...tools.definitions, ...toolkit.definitions], send };
}
