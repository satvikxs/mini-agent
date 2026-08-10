import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";
import {
  describeModel,
  envLines,
  fallbackModels,
  FALLBACK_MODELS,
  fetchModels,
  filterModels,
  findProvider,
  modelName,
  PROVIDERS,
} from "../src/providers.ts";

/** By id, so that adding a provider cannot silently re-point an assertion. */
const provider = (id: string) => {
  const found = findProvider(id);
  assert.ok(found, `no provider "${id}"`);
  return found;
};

/**
 * The exact strings each endpoint's live model list returned when these were
 * checked. A right key against a wrong model name reads as a bad key, so the
 * spelling is pinned rather than left to a rule nobody re-reads.
 */
const EXPECTED: Record<string, string[]> = {
  anthropic: ["claude-opus-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5"],
  // Namespaces every other vendor, but not Anthropic — its own catalog lists
  // `claude-sonnet-4-6`, hyphens and all.
  cmd: ["claude-opus-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5"],
  openrouter: [
    "anthropic/claude-opus-5",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-sonnet-4.6",
    "anthropic/claude-opus-4.8",
    "anthropic/claude-haiku-4.5",
  ],
  vercel: [
    "anthropic/claude-opus-5",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-sonnet-4.6",
    "anthropic/claude-opus-4.8",
    "anthropic/claude-haiku-4.5",
  ],
  custom: ["claude-opus-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5"],
};

test("each provider spells every fallback model the way its own catalog does", () => {
  // Every provider is covered: a new one without a pinned spelling fails here
  // rather than passing by not being looked at.
  assert.deepEqual(PROVIDERS.map((entry) => entry.id).sort(), Object.keys(EXPECTED).sort());

  for (const entry of PROVIDERS) {
    const got = fallbackModels(entry).map((model) => model.id);
    assert.deepEqual(got, EXPECTED[entry.id], entry.id);
  }
});

test("the fallback list reaches past Sonnet", () => {
  const families = new Set(FALLBACK_MODELS.map((model) => /^claude-([a-z]+)/.exec(model.id)?.[1]));
  assert.deepEqual([...families].sort(), ["haiku", "opus", "sonnet"]);
});

test("model ids carry no date suffix", () => {
  // The aliases are complete as written; a date suffix appended from memory 404s.
  for (const model of FALLBACK_MODELS) assert.doesNotMatch(model.id, /-\d{8}$/);
});

test("a gateway writes its own base URL, and direct writes none", () => {
  const direct = envLines(provider("anthropic"), "sk-ant-x", "claude-sonnet-5");
  assert.equal(direct["ANTHROPIC_BASE_URL"], undefined);
  assert.equal(direct["ANTHROPIC_MODEL"], "claude-sonnet-5");

  const cmd = envLines(provider("cmd"), "cc-x", "claude-sonnet-4-6");
  assert.equal(cmd["ANTHROPIC_BASE_URL"], "https://api.commandcode.ai/provider");
  assert.equal(cmd["ANTHROPIC_MODEL"], "claude-sonnet-4-6");
});

test("the chosen model is written exactly as chosen", () => {
  // Spelling is settled when the list is built. Translating again here would
  // namespace an already-namespaced id into `anthropic/anthropic/…`.
  const values = envLines(provider("openrouter"), "sk-or-x", "anthropic/claude-sonnet-4.6");
  assert.equal(values["ANTHROPIC_MODEL"], "anthropic/claude-sonnet-4.6");
});

test("a custom endpoint overrides the provider's own", () => {
  const values = envLines(provider("custom"), "key", "claude-sonnet-5", "https://example.invalid/anthropic");
  assert.equal(values["ANTHROPIC_BASE_URL"], "https://example.invalid/anthropic");
});

test("every provider that is not api.anthropic.com says where to reach it", () => {
  // `custom` is the exception by design: its endpoint is typed during onboarding.
  for (const entry of PROVIDERS) {
    if (entry.id === "anthropic" || entry.id === "custom") continue;
    assert.match(entry.baseURL, /^https:\/\//, entry.id);
    // The SDK appends `/v1/messages`, so a trailing slash would ask for `//v1`.
    assert.doesNotMatch(entry.baseURL, /\/$/, entry.id);
  }
});

test("an id reads as a name", () => {
  assert.equal(describeModel("claude-sonnet-4-6"), "Sonnet 4.6");
  assert.equal(describeModel("anthropic/claude-sonnet-4.6"), "Sonnet 4.6");
  assert.equal(describeModel("claude-opus-5"), "Opus 5");
  // A dated snapshot is the same model, so the date is not part of the name.
  assert.equal(describeModel("claude-haiku-4-5-20251001"), "Haiku 4.5");
  // Someone else's model keeps its own spelling rather than a prettier guess.
  assert.equal(describeModel("deepseek/deepseek-v4-flash"), "deepseek-v4-flash");
});

test("the filter reads names and ids alike", () => {
  const models = fallbackModels(provider("anthropic"));

  assert.equal(filterModels(models, "").length, models.length);
  assert.deepEqual(filterModels(models, "haiku").map((m) => m.id), ["claude-haiku-4-5"]);
  // By id, which is how anyone who knows the exact string will type it.
  assert.deepEqual(filterModels(models, "sonnet-4-6").map((m) => m.id), ["claude-sonnet-4-6"]);
  assert.equal(filterModels(models, "  OPUS  ").length, 2);
  assert.deepEqual(filterModels(models, "gpt-5"), []);
});

type Ask = { url: string; headers: Record<string, string | undefined> };

/** A stand-in endpoint, so the discovery path is exercised without a key. */
function serve(handler: (ask: Ask) => { status: number; body: unknown }): Promise<{ url: string; close: () => void }> {
  return new Promise((done) => {
    const server: Server = createServer((request, response) => {
      const { status, body } = handler({
        url: request.url ?? "",
        headers: request.headers as Record<string, string | undefined>,
      });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(typeof body === "string" ? body : JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      done({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

const closers: Array<() => void> = [];
after(() => closers.forEach((close) => close()));

test("a live catalog is read, labelled, and led by Claude", async () => {
  const endpoint = await serve(({ url }) => {
    assert.equal(url, "/v1/models", "the models route the gateways all answer");
    return {
      status: 200,
      body: {
        data: [
          { id: "deepseek/deepseek-v4-flash", context_length: 128000 },
          { id: "claude-sonnet-5", name: "Claude Sonnet 5", context_length: 1000000 },
          { id: "claude-haiku-4-5-20251001", max_input_tokens: 200000 },
        ],
      },
    };
  });
  closers.push(endpoint.close);

  const catalog = await fetchModels(provider("anthropic"), "key", endpoint.url);
  assert.equal(catalog.kind, "live");
  if (catalog.kind !== "live") return;

  // The open model is offered too — it routes over chat completions instead —
  // but Claude leads, because that is what the tool loop was tuned against.
  assert.deepEqual(catalog.models.map((model) => model.id), [
    "claude-sonnet-5",
    "claude-haiku-4-5-20251001",
    "deepseek/deepseek-v4-flash",
  ]);
  // The endpoint's own name wins; an id without one is made readable.
  assert.equal(catalog.models[0]?.label, "Claude Sonnet 5");
  assert.equal(catalog.models[1]?.label, "Haiku 4.5");
  assert.equal(catalog.models[0]?.note, "1M context");
  assert.equal(catalog.models[1]?.note, "200K context");
  assert.equal(catalog.models[2]?.note, "128K context");
});

test("an endpoint that lists no Claude model is still usable", async () => {
  const endpoint = await serve(() => ({
    status: 200,
    body: { data: [{ id: "my-deployment" }, { id: "internal/mixtral-next" }] },
  }));
  closers.push(endpoint.close);

  const catalog = await fetchModels(provider("custom"), "key", endpoint.url);
  assert.equal(catalog.kind, "live");
  if (catalog.kind !== "live") return;
  assert.deepEqual(catalog.models.map((model) => model.id), ["my-deployment", "internal/mixtral-next"]);
});

test("a refused key is told apart from an endpoint with no list", async () => {
  const refusing = await serve(() => ({ status: 401, body: { error: "no" } }));
  const silent = await serve(() => ({ status: 404, body: { error: "no such route" } }));
  const empty = await serve(() => ({ status: 200, body: { data: [] } }));
  const garbled = await serve(() => ({ status: 200, body: "not json at all" }));
  closers.push(refusing.close, silent.close, empty.close, garbled.close);

  const entry = provider("anthropic");
  // The one the user can fix, and the three they cannot — which must not block
  // onboarding, because the curated list stands in for all of them.
  assert.equal((await fetchModels(entry, "key", refusing.url)).kind, "refused");
  assert.equal((await fetchModels(entry, "key", silent.url)).kind, "unavailable");
  assert.equal((await fetchModels(entry, "key", empty.url)).kind, "unavailable");
  assert.equal((await fetchModels(entry, "key", garbled.url)).kind, "unavailable");
});

test("an unreachable endpoint is unavailable rather than a thrown error", async () => {
  // Port 1 on loopback: nothing listens there, so the fetch fails outright.
  const catalog = await fetchModels(provider("anthropic"), "key", "http://127.0.0.1:1", 1500);
  assert.equal(catalog.kind, "unavailable");
});

test("a gateway is asked with the header it actually reads", async () => {
  let seen: Record<string, string | undefined> = {};
  const endpoint = await serve(({ headers }) => {
    seen = headers;
    return { status: 200, body: { data: [{ id: "claude-sonnet-5" }] } };
  });
  closers.push(endpoint.close);

  // The bearer providers ignore x-api-key, so the key has to ride Authorization.
  await fetchModels(provider("openrouter"), "sk-or-x", endpoint.url);
  assert.equal(seen["authorization"], "Bearer sk-or-x");

  await fetchModels(provider("anthropic"), "sk-ant-x", endpoint.url);
  assert.equal(seen["x-api-key"], "sk-ant-x");
  assert.equal(seen["authorization"], undefined);
});

test("modelName still converts a canonical id for the gateways that need it", () => {
  assert.equal(modelName(provider("openrouter"), "claude-sonnet-4-6"), "anthropic/claude-sonnet-4.6");
  assert.equal(modelName(provider("anthropic"), "claude-sonnet-4-6"), "claude-sonnet-4-6");
});
