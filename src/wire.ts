import type Anthropic from "@anthropic-ai/sdk";
import { completionsPing, completionsWire } from "./completions.ts";
import { messagesPing, messagesWire } from "./messages.ts";

/** A tool as the tool modules declare it — Anthropic's shape, converted per wire. */
export type ToolDefinition = Anthropic.Tool;

export type Call = { id: string; name: string; input: unknown };
export type Result = { id: string; content: string; isError: boolean };

/** One assistant turn, whichever wire carried it. */
export type Turn = {
  text: string;
  calls: Call[];
  /** `tools` means it wants to call something; `length` means it was cut off. */
  stop: "end" | "tools" | "length";
  input: number;
  output: number;
};

/**
 * The two things a turn emits as it is generated.
 *
 * Kept apart all the way to the screen: reasoning is the model working, not its
 * answer, and folding the two into one callback would put the working-out
 * inside the reply with no way to tell them apart again.
 */
export type Stream = {
  text(delta: string): void;
  thinking(delta: string): void;
};

/**
 * One conversation in one wire format.
 *
 * The agent loop is the same either way — ask, stream, run the tools it asks
 * for, ask again — so only the shape of the messages differs. Each wire keeps
 * its own history in its own format rather than translating a shared one on
 * every request, because the two formats disagree about where the system prompt
 * lives, how a tool result is addressed, and whether an assistant turn can hold
 * both text and a call at once.
 */
export type Wire = {
  /** How many messages have accumulated, for rewinding a failed turn. */
  readonly length: number;
  user(text: string): void;
  send(stream: Stream, signal?: AbortSignal): Promise<Turn>;
  results(results: readonly Result[]): void;
  rewind(to: number): void;
};

export type WireOptions = {
  apiKey: string;
  baseURL?: string;
  model: string;
  system: string;
  tools: readonly ToolDefinition[];
  maxTokens: number;
};

/**
 * Which wire a model speaks, decided by its name.
 *
 * Every gateway spells Claude the same way up to a vendor prefix, and nothing
 * else is served over the Anthropic Messages API — Command Code answers a
 * non-Claude model on `/v1/messages` with a 400 naming `/chat/completions`.
 * Inferring it from the id keeps `.env` to the three variables it already has,
 * and means `--model` routes itself.
 */
export const speaksMessages = (model: string): boolean => /(^|\/)claude-/i.test(model);

export const openWire = (options: WireOptions): Wire =>
  speaksMessages(options.model) ? messagesWire(options) : completionsWire(options);

/** One tiny request, to prove a key and a model before either is written down. */
export const ping = (options: Omit<WireOptions, "system" | "tools" | "maxTokens">): Promise<void> =>
  speaksMessages(options.model) ? messagesPing(options) : completionsPing(options);
