import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, describe, test } from "node:test";
import { completionsWire } from "../src/completions.ts";
import { messagesWire } from "../src/messages.ts";
import { speaksMessages, type Stream, type ToolDefinition } from "../src/wire.ts";

const TOOLS: ToolDefinition[] = [
  {
    name: "load_skill",
    description: "Load a skill by name",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
];

/** One `data:` line per event, exactly as a gateway writes them. */
const sse = (chunks: unknown[]): string =>
  `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;

const delta = (body: Record<string, unknown>, finish: string | null = null) => ({
  choices: [{ index: 0, delta: body, finish_reason: finish }],
});

type Sent = { body: any; headers: IncomingMessage["headers"]; url: string };

/** A stand-in gateway that records what it was sent and replies with a script. */
function gateway(replies: string[]): Promise<{ url: string; sent: Sent[]; close: () => void }> {
  const sent: Sent[] = [];
  let at = 0;

  return new Promise((done) => {
    const server: Server = createServer((request, response) => {
      let raw = "";
      request.on("data", (piece) => (raw += piece));
      request.on("end", () => {
        sent.push({ body: JSON.parse(raw || "{}"), headers: request.headers, url: request.url ?? "" });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(replies[Math.min(at++, replies.length - 1)]);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      done({ url: `http://127.0.0.1:${port}`, sent, close: () => server.close() });
    });
  });
}

/** Collects both lanes a turn emits, so each can be asserted on separately. */
function sink() {
  const text: string[] = [];
  const thinking: string[] = [];
  const stream: Stream = { text: (d) => void text.push(d), thinking: (d) => void thinking.push(d) };
  return { text, thinking, stream };
}

/** For turns where only the return value matters. */
const nowhere: Stream = { text: () => {}, thinking: () => {} };

const closers: Array<() => void> = [];
after(() => closers.forEach((close) => close()));

const open = (url: string, model = "deepseek/deepseek-v4-flash") =>
  completionsWire({ apiKey: "k", baseURL: url, model, system: "be brief", tools: TOOLS, maxTokens: 64 });

describe("which wire a model speaks", () => {
  test("Claude goes to messages, however the gateway spells it", () => {
    for (const id of ["claude-sonnet-5", "anthropic/claude-sonnet-4.6", "claude-haiku-4-5-20251001"]) {
      assert.equal(speaksMessages(id), true, id);
    }
  });

  test("everything else goes to chat completions", () => {
    for (const id of ["deepseek/deepseek-v4-flash", "gpt-5.6-luna", "zai-org/GLM-5.2", "my-deployment"]) {
      assert.equal(speaksMessages(id), false, id);
    }
  });
});

describe("the chat completions wire", () => {
  test("streams text and reports what the turn cost", async () => {
    const endpoint = await gateway([
      sse([
        delta({ role: "assistant" }),
        delta({ content: "Hel" }),
        delta({ content: "lo." }),
        delta({}, "stop"),
        { choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } },
      ]),
    ]);
    closers.push(endpoint.close);

    const wire = open(endpoint.url);
    wire.user("hi");

    const got = sink();
    const turn = await wire.send(got.stream);
    const seen = got.text;

    assert.deepEqual(seen, ["Hel", "lo."], "each fragment reaches the renderer as it lands");
    assert.equal(turn.text, "Hello.");
    assert.equal(turn.stop, "end");
    assert.equal(turn.input, 11);
    assert.equal(turn.output, 3);
    assert.equal(endpoint.sent[0]?.url, "/v1/chat/completions");
  });

  test("surfaces the model's reasoning without folding it into the answer", async () => {
    // Open models stream `reasoning` beside `content`. It has to be shown, and
    // it has to stay out of the reply that gets replayed on the next turn.
    const endpoint = await gateway([
      sse([
        delta({ reasoning: "The user wants" }),
        delta({ reasoning: " a product." }),
        delta({ content: "42" }),
        delta({}, "stop"),
      ]),
    ]);
    closers.push(endpoint.close);

    const wire = open(endpoint.url);
    wire.user("hi");

    const got = sink();
    const turn = await wire.send(got.stream);

    assert.deepEqual(got.thinking, ["The user wants", " a product."], "reasoning reaches its own lane");
    assert.deepEqual(got.text, ["42"], "and never the answer's");
    assert.equal(turn.text, "42");
  });

  test("reassembles a tool call split across chunks", async () => {
    const endpoint = await gateway([
      sse([
        delta({ tool_calls: [{ index: 0, id: "call_1", function: { name: "load_skill", arguments: "" } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"na' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'me":"welcome-me"}' } }] }),
        delta({}, "tool_calls"),
      ]),
    ]);
    closers.push(endpoint.close);

    const wire = open(endpoint.url);
    wire.user("I am new here");
    const turn = await wire.send(nowhere);

    assert.equal(turn.stop, "tools");
    assert.deepEqual(turn.calls, [{ id: "call_1", name: "load_skill", input: { name: "welcome-me" } }]);
  });

  test("carries the result back addressed to the call that asked for it", async () => {
    const endpoint = await gateway([
      sse([
        delta({ tool_calls: [{ index: 0, id: "call_1", function: { name: "load_skill", arguments: "{}" } }] }),
        delta({}, "tool_calls"),
      ]),
      sse([delta({ content: "done" }), delta({}, "stop")]),
    ]);
    closers.push(endpoint.close);

    const wire = open(endpoint.url);
    wire.user("go");
    await wire.send(nowhere);
    wire.results([{ id: "call_1", content: "the skill body", isError: false }]);
    await wire.send(nowhere);

    const second = endpoint.sent[1]!.body.messages;
    assert.deepEqual(second[0], { role: "system", content: "be brief" });
    // The assistant turn has to carry the call, or the tool reply is an orphan.
    assert.equal(second[2].role, "assistant");
    assert.equal(second[2].tool_calls[0].id, "call_1");
    assert.deepEqual(second[3], { role: "tool", tool_call_id: "call_1", content: "the skill body" });
  });

  test("tells the model a tool failed", async () => {
    const endpoint = await gateway([sse([delta({ content: "ok" }), delta({}, "stop")])]);
    closers.push(endpoint.close);

    const wire = open(endpoint.url);
    wire.user("go");
    wire.results([{ id: "call_9", content: "no such skill", isError: true }]);
    await wire.send(nowhere);

    // Chat completions has no error flag on a tool message, so it has to be said.
    assert.match(endpoint.sent[0]!.body.messages.at(-1).content, /^Error: no such skill/);
  });

  test("offers the tools in the shape this API expects", async () => {
    const endpoint = await gateway([sse([delta({ content: "hi" }), delta({}, "stop")])]);
    closers.push(endpoint.close);

    const wire = open(endpoint.url);
    wire.user("hi");
    await wire.send(nowhere);

    const [tool] = endpoint.sent[0]!.body.tools;
    assert.equal(tool.type, "function");
    assert.equal(tool.function.name, "load_skill");
    // `input_schema` on the Anthropic side, `parameters` here.
    assert.deepEqual(tool.function.parameters, TOOLS[0]!.input_schema);
    assert.equal(endpoint.sent[0]!.body.stream, true);
    assert.deepEqual(endpoint.sent[0]!.body.stream_options, { include_usage: true });
  });

  test("sends the key both ways gateways read it", async () => {
    const endpoint = await gateway([sse([delta({ content: "hi" }), delta({}, "stop")])]);
    closers.push(endpoint.close);

    const wire = open(endpoint.url);
    wire.user("hi");
    await wire.send(nowhere);

    assert.equal(endpoint.sent[0]!.headers["authorization"], "Bearer k");
    assert.equal(endpoint.sent[0]!.headers["x-api-key"], "k");
  });

  test("rewinds a failed turn to where the conversation stood", async () => {
    const endpoint = await gateway([sse([delta({ content: "hi" }), delta({}, "stop")])]);
    closers.push(endpoint.close);

    const wire = open(endpoint.url);
    const checkpoint = wire.length;
    assert.equal(checkpoint, 1, "the system prompt is the first message, and stays");

    wire.user("one");
    await wire.send(nowhere);
    assert.ok(wire.length > checkpoint);

    wire.rewind(checkpoint);
    assert.equal(wire.length, checkpoint);
  });

  test("surfaces the endpoint's own sentence when it refuses", async () => {
    const refusing = await new Promise<{ url: string; close: () => void }>((done) => {
      const server = createServer((_request, response) => {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "MODEL_NOT_IN_PLAN: needs Pro" } }));
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        done({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
      });
    });
    closers.push(refusing.close);

    const wire = open(refusing.url);
    wire.user("hi");
    await assert.rejects(wire.send(nowhere), /403 MODEL_NOT_IN_PLAN: needs Pro/);
  });
});

/** The Anthropic stream format: a named event per line, then its JSON. */
const anthropicSse = (events: Array<{ type: string; body: Record<string, unknown> }>): string =>
  events.map(({ type, body }) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`).join("");

const CLAUDE_TURN = anthropicSse([
  {
    type: "message_start",
    body: {
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    },
  },
  { type: "content_block_start", body: { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } } },
  { type: "content_block_delta", body: { index: 0, delta: { type: "thinking_delta", thinking: "Seventeen times" } } },
  { type: "content_block_delta", body: { index: 0, delta: { type: "thinking_delta", thinking: " twenty-three." } } },
  { type: "content_block_delta", body: { index: 0, delta: { type: "signature_delta", signature: "sig" } } },
  { type: "content_block_stop", body: { index: 0 } },
  { type: "content_block_start", body: { index: 1, content_block: { type: "text", text: "" } } },
  { type: "content_block_delta", body: { index: 1, delta: { type: "text_delta", text: "391" } } },
  { type: "content_block_stop", body: { index: 1 } },
  {
    type: "message_delta",
    body: { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } },
  },
  { type: "message_stop", body: {} },
]);

/** Replies with a script; a `null` entry means "refuse this one over thinking". */
function claudeGateway(script: Array<string | null>): Promise<{ url: string; sent: any[]; close: () => void }> {
  const sent: any[] = [];
  let at = 0;

  return new Promise((done) => {
    const server = createServer((request, response) => {
      let raw = "";
      request.on("data", (piece) => (raw += piece));
      request.on("end", () => {
        sent.push(JSON.parse(raw || "{}"));
        const reply = script[Math.min(at++, script.length - 1)];
        if (reply === null) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              type: "error",
              error: { type: "invalid_request_error", message: "thinking: Extra inputs are not permitted" },
            }),
          );
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(reply);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      done({ url: `http://127.0.0.1:${port}`, sent, close: () => server.close() });
    });
  });
}

const openClaude = (url: string) =>
  messagesWire({ apiKey: "k", baseURL: url, model: "claude-sonnet-5", system: "be brief", tools: [], maxTokens: 64 });

describe("the messages wire", () => {
  test("asks for thinking, and streams the summary on its own lane", async () => {
    const endpoint = await claudeGateway([CLAUDE_TURN]);
    closers.push(endpoint.close);

    const wire = openClaude(endpoint.url);
    wire.user("what is 17*23?");

    const got = sink();
    const turn = await wire.send(got.stream);

    // Without `display: summarized` the blocks still stream, with the text
    // emptied — which reads as a long pause and nothing else.
    assert.deepEqual(endpoint.sent[0].thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(got.thinking, ["Seventeen times", " twenty-three."]);
    assert.deepEqual(got.text, ["391"]);
    assert.equal(turn.text, "391");
    assert.equal(turn.stop, "end");
  });

  test("drops thinking for good once an endpoint refuses it", async () => {
    // Not every Anthropic-compatible gateway forwards the parameter. Finding
    // out costs one rejected request, and must not cost the turn.
    const endpoint = await claudeGateway([null, CLAUDE_TURN, CLAUDE_TURN]);
    closers.push(endpoint.close);

    const wire = openClaude(endpoint.url);
    wire.user("what is 17*23?");

    const first = sink();
    const turn = await wire.send(first.stream);
    assert.equal(turn.text, "391", "the turn survives the refusal");
    assert.equal(endpoint.sent.length, 2, "refused once, retried once");
    assert.ok(endpoint.sent[0].thinking, "the first attempt asked");
    assert.equal(endpoint.sent[1].thinking, undefined, "the retry did not");

    // And it never asks again for the life of this conversation.
    wire.user("again");
    await wire.send(nowhere);
    assert.equal(endpoint.sent[2].thinking, undefined);
  });
});
