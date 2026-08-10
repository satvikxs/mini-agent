import Anthropic from "@anthropic-ai/sdk";
import type { Result, Stream, Turn, Wire, WireOptions } from "./wire.ts";

type PingOptions = { apiKey: string; baseURL?: string; model: string };

const open = ({ apiKey, baseURL }: PingOptions): Anthropic =>
  new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });

/** How Anthropic's stop reasons map onto the two things the loop cares about. */
const stopOf = (reason: string | null): Turn["stop"] =>
  reason === "tool_use" ? "tools" : reason === "max_tokens" ? "length" : "end";

/**
 * Adaptive thinking, with the summary actually turned on.
 *
 * The current models default `display` to `"omitted"`, which still streams
 * thinking blocks but with the text emptied — so asking for thinking without
 * asking for the summary shows a long pause and nothing else.
 */
const THINKING = { type: "adaptive", display: "summarized" } as const;

/** Whether a failure was about the thinking parameter rather than the request. */
const rejectsThinking = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /thinking/i.test(message) && /(400|invalid|unsupported|unexpected|not supported)/i.test(message);
};

/** The Anthropic Messages API, which is what Claude models speak everywhere. */
export function messagesWire(options: WireOptions): Wire {
  const { model, system, tools, maxTokens } = options;
  const client = open(options);
  const messages: Anthropic.MessageParam[] = [];

  /**
   * Cleared for good the first time an endpoint refuses it.
   *
   * Not every Anthropic-compatible gateway forwards `thinking`, and finding out
   * costs one rejected request — after which the turn is retried plainly and
   * nothing asks again. Better than shipping a flag nobody knows to unset.
   */
  let thinking = true;

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
      messages.push({
        role: "user",
        content: results.map((result) => ({
          type: "tool_result" as const,
          tool_use_id: result.id,
          content: result.content,
          is_error: result.isError,
        })),
      });
    },

    async send(stream: Stream, signal) {
      const ask = async (): Promise<Anthropic.Message> => {
        const live = client.messages.stream(
          {
            model,
            max_tokens: maxTokens,
            system,
            ...(tools.length > 0 ? { tools: [...tools] } : {}),
            ...(thinking ? { thinking: THINKING } : {}),
            messages,
          },
          { ...(signal ? { signal } : {}) },
        );

        live.on("text", (delta) => stream.text(delta));
        // The typed `text` event has no thinking counterpart, so the summary is
        // read off the raw event instead.
        live.on("streamEvent", (event) => {
          if (event.type === "content_block_delta" && event.delta.type === "thinking_delta") {
            stream.thinking(event.delta.thinking);
          }
        });

        // Rejects if the request fails or is aborted, so both surface here
        // rather than through an unhandled event.
        return live.finalMessage();
      };

      let response: Anthropic.Message;
      try {
        response = await ask();
      } catch (error) {
        if (!thinking || signal?.aborted || !rejectsThinking(error)) throw error;
        thinking = false;
        response = await ask();
      }

      messages.push({ role: "assistant", content: response.content });

      return {
        text: response.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join(""),
        calls: response.content
          .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
          .map((block) => ({ id: block.id, name: block.name, input: block.input })),
        stop: stopOf(response.stop_reason),
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      };
    },
  };
}

export async function messagesPing(options: PingOptions): Promise<void> {
  await open(options).messages.create({
    model: options.model,
    max_tokens: 1,
    messages: [{ role: "user", content: "hi" }],
  });
}
