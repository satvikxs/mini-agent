import type { Call, Result, Stream, ToolDefinition, Turn, Wire, WireOptions } from "./wire.ts";

type PingOptions = { apiKey: string; baseURL?: string; model: string };

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/**
 * Chat Completions lives beside the Messages API on the same root, so the base
 * URL already in `.env` reaches both — `/v1/messages` and `/v1/chat/completions`
 * are two routes on one gateway, not two endpoints to configure.
 */
const routeFor = (baseURL: string | undefined, path: string): string =>
  `${(baseURL || "https://api.openai.com").replace(/\/+$/, "")}/v1/${path}`;

/**
 * Both, deliberately.
 *
 * Gateways disagree about which header carries the key — OpenRouter and Vercel
 * read Authorization, Command Code takes either — and none of them is
 * api.anthropic.com, which is the one endpoint that rejects a request carrying
 * both. Sending each costs a header and removes a whole class of "that key was
 * refused" against a key that was fine.
 */
const headers = (apiKey: string): Record<string, string> => ({
  "content-type": "application/json",
  authorization: `Bearer ${apiKey}`,
  "x-api-key": apiKey,
});

/** The endpoint's own sentence, so a failure says something a person can act on. */
async function complain(response: Response): Promise<never> {
  const body = await response.text().catch(() => "");
  let detail = body;
  try {
    const parsed: unknown = JSON.parse(body);
    const error = (parsed as { error?: unknown })?.error;
    const message = typeof error === "string" ? error : (error as { message?: unknown })?.message;
    if (typeof message === "string" && message !== "") detail = message;
  } catch {
    // Not JSON. The raw body is still the best thing we have to show.
  }
  throw new Error(`${response.status} ${detail}`.trim());
}

const functionsFor = (tools: readonly ToolDefinition[]) =>
  tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.input_schema,
    },
  }));

const stopOf = (reason: string | null | undefined): Turn["stop"] =>
  reason === "tool_calls" ? "tools" : reason === "length" ? "length" : "end";

/** Arguments arrive as a stream of fragments, and a model may still send none. */
function parseInput(args: string): unknown {
  const text = args.trim();
  if (text === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    // Handed to the tool as-is; it reports the shape it wanted far better than
    // a parse error here could.
    return { _raw: text };
  }
}

/**
 * The OpenAI Chat Completions API, which is what every non-Claude model speaks.
 *
 * Written against `fetch` rather than a second SDK: the streaming wire format
 * is a documented one-page contract, and the alternative is a dependency whose
 * only job would be to re-serialise it.
 */
export function completionsWire(options: WireOptions): Wire {
  const { apiKey, baseURL, model, system, tools, maxTokens } = options;
  const functions = functionsFor(tools);

  // Unlike the Messages API, the system prompt is just the first message.
  const messages: Message[] = system ? [{ role: "system", content: system }] : [];

  return {
    get length() {
      return messages.length;
    },

    user(text) {
      messages.push({ role: "user", content: text });
    },

    rewind(to) {
      messages.length = to;
    },

    results(results: readonly Result[]) {
      // One message per result, addressed by call id — where the Messages API
      // gathers them all into a single user turn.
      for (const result of results) {
        messages.push({
          role: "tool",
          tool_call_id: result.id,
          content: result.isError ? `Error: ${result.content}` : result.content,
        });
      }
    },

    async send(stream: Stream, signal) {
      const response = await fetch(routeFor(baseURL, "chat/completions"), {
        method: "POST",
        headers: headers(apiKey),
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          stream: true,
          // Usage is otherwise absent from a streamed response entirely.
          stream_options: { include_usage: true },
          messages,
          ...(functions.length > 0 ? { tools: functions } : {}),
        }),
        ...(signal ? { signal } : {}),
      });

      if (!response.ok || !response.body) await complain(response);

      const pending = new Map<number, { id: string; name: string; args: string }>();
      let text = "";
      let finish: string | null = null;
      let input = 0;
      let output = 0;

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Server-sent events: `data: {json}` per line, `data: [DONE]` at the end.
      // Read line by line rather than per chunk, because a chunk boundary lands
      // mid-line often enough that parsing whole chunks silently drops tokens.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let cut = buffer.indexOf("\n");
        for (; cut >= 0; cut = buffer.indexOf("\n")) {
          const line = buffer.slice(0, cut).trim();
          buffer = buffer.slice(cut + 1);
          if (!line.startsWith("data:")) continue;

          const payload = line.slice(5).trim();
          if (payload === "" || payload === "[DONE]") continue;

          let chunk: Record<string, any>;
          try {
            chunk = JSON.parse(payload) as Record<string, any>;
          } catch {
            continue;
          }

          if (chunk["usage"]) {
            input = Number(chunk["usage"].prompt_tokens) || 0;
            output = Number(chunk["usage"].completion_tokens) || 0;
          }

          const choice = chunk["choices"]?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finish = choice.finish_reason;

          const delta = choice.delta ?? {};
          if (typeof delta.content === "string" && delta.content !== "") {
            text += delta.content;
            stream.text(delta.content);
          }
          // Open models stream their reasoning beside the answer under its own
          // key. It is kept out of `text` — that is the reply, and the reply is
          // what gets handed back and replayed on the next turn — but it is
          // still shown, on its own lane.
          if (typeof delta.reasoning === "string" && delta.reasoning !== "") {
            stream.thinking(delta.reasoning);
          }

          for (const call of delta.tool_calls ?? []) {
            const at = Number(call.index) || 0;
            const slot = pending.get(at) ?? { id: "", name: "", args: "" };
            if (call.id) slot.id = call.id;
            if (call.function?.name) slot.name = call.function.name;
            if (call.function?.arguments) slot.args += call.function.arguments;
            pending.set(at, slot);
          }
        }
      }

      const collected = [...pending.entries()].sort(([a], [b]) => a - b).map(([, slot]) => slot);
      const calls: Call[] = collected.map((slot, at) => ({
        // Some gateways omit the id when there is only one call to address.
        id: slot.id || `call_${at}`,
        name: slot.name,
        input: parseInput(slot.args),
      }));

      messages.push({
        role: "assistant",
        content: text === "" ? null : text,
        ...(collected.length > 0
          ? {
              tool_calls: collected.map((slot, at) => ({
                id: slot.id || `call_${at}`,
                type: "function" as const,
                function: { name: slot.name, arguments: slot.args || "{}" },
              })),
            }
          : {}),
      });

      // A model that asked for a tool but whose gateway forgot to say so still
      // needs its calls run, or the loop answers with an empty turn.
      return { text, calls, stop: calls.length > 0 ? "tools" : stopOf(finish), input, output };
    },
  };
}

export async function completionsPing(options: PingOptions): Promise<void> {
  const response = await fetch(routeFor(options.baseURL, "chat/completions"), {
    method: "POST",
    headers: headers(options.apiKey),
    body: JSON.stringify({
      model: options.model,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),
  });

  if (!response.ok) await complain(response);
}
