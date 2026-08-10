export type Provider = {
  id: string;
  label: string;
  /** What it is, in the width of a list row. */
  note: string;
  /** Empty means the SDK's own default, api.anthropic.com. */
  baseURL: string;
  /** Where the key comes from, shown while asking for it. */
  source: string;
  /** Set when the endpoint reads the key from Authorization rather than x-api-key. */
  bearer?: boolean;
  /** Set when models are namespaced and versions are dotted, as both gateways do. */
  gateway?: boolean;
};

export type Model = {
  /**
   * Spelled the way the chosen endpoint spells it, ready to send.
   *
   * A live id arrives already correct. A fallback id is Anthropic's own, and
   * `modelName` converts it on the way into the list — so by the time anything
   * reads this field, the distinction is gone.
   */
  id: string;
  label: string;
  note: string;
};

/**
 * What to offer when the endpoint will not say what it hosts.
 *
 * Azure's Anthropic passthrough has no `/v1/models`, and a custom gateway need
 * not have one either, so the list cannot always be discovered. These are the
 * current aliases, complete as written — a date suffix appended from memory
 * 404s. Anything absent from here is still reachable: the filter doubles as a
 * field for typing a name the list does not carry.
 */
export const FALLBACK_MODELS: Model[] = [
  { id: "claude-opus-5", label: "Opus 5", note: "most capable — complex agentic and coding work" },
  { id: "claude-sonnet-5", label: "Sonnet 5", note: "the balance of speed and intelligence" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", note: "previous generation" },
  { id: "claude-opus-4-8", label: "Opus 4.8", note: "previous generation, Opus tier" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", note: "fastest and cheapest" },
];

/**
 * Every entry offers both wire formats off one root: `/v1/messages` for Claude
 * and `/v1/chat/completions` for everything else. That is why a provider is a
 * base URL and not a client — the agent carries both, and picks by model name.
 *
 * Verified against each endpoint rather than taken from docs: OpenRouter's
 * `/api/v1/messages` is real but undocumented, and answers 401 rather than 404.
 */
export const PROVIDERS: Provider[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    note: "direct, pay as you go",
    baseURL: "",
    source: "console.anthropic.com/settings/keys",
  },
  {
    id: "cmd",
    label: "Command Code",
    // The key from `commandcode login` is the same one the API takes, so anyone
    // with the CLI already has one.
    note: "one key for the CLI and the API",
    // The SDK appends `/v1/messages`, and Command Code serves it under
    // `/provider` — not at the root, where the product's own API answers 404.
    baseURL: "https://api.commandcode.ai/provider",
    source: "commandcode.ai/studio",
    bearer: true,
    // Deliberately not a gateway: it namespaces every other vendor's models but
    // spells Anthropic's exactly as Anthropic does, checked against its own
    // `/provider/v1/models`. Sonnet 4.5 is the one gap — it is absent there, and
    // picking it is refused at the check rather than after the first real turn.
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    note: "one key, many models",
    baseURL: "https://openrouter.ai/api",
    source: "openrouter.ai/keys",
    bearer: true,
    gateway: true,
  },
  {
    id: "vercel",
    label: "Vercel AI Gateway",
    note: "one key, no markup, spend in one place",
    baseURL: "https://ai-gateway.vercel.sh",
    source: "vercel.com/dashboard → AI Gateway",
    bearer: true,
    gateway: true,
  },
  {
    id: "custom",
    label: "Somewhere else",
    note: "any Anthropic-compatible endpoint, including Azure",
    baseURL: "",
    source: "your gateway's base URL, then its key",
  },
];

/**
 * The same model, spelled the way the chosen endpoint spells it.
 *
 * Anthropic writes `claude-sonnet-4-6`; both gateways namespace it and dot the
 * version — `anthropic/claude-sonnet-4.6`. Checked against each one's live model
 * list, because a right key against a wrong model name reads as a bad key.
 */
export function modelName(provider: Provider, id: string): string {
  return provider.gateway ? `anthropic/${id.replace(/-(\d+)-(\d+)$/, "-$1.$2")}` : id;
}

export const findProvider = (id: string): Provider | undefined =>
  PROVIDERS.find((provider) => provider.id === id);

/** A context window as a person reads it: 1000000 → "1M context". */
function context(tokens: unknown): string {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return "";
  const millions = tokens / 1_000_000;
  return millions >= 1
    ? `${Number(millions.toFixed(1))}M context`
    : `${Math.round(tokens / 1000)}K context`;
}

/**
 * A readable name for an id, for endpoints that list ids and nothing else.
 *
 * `anthropic/claude-sonnet-4.6` → `Sonnet 4.6`. The vendor prefix and the
 * `claude-` stem are noise once every row carries them, and a trailing date is
 * a snapshot of the same model. Anything that is not a Claude id is left alone:
 * inventing a prettier spelling for someone else's model only risks lying.
 */
export function describeModel(id: string): string {
  const bare = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  const claude = /^claude-(.+)$/.exec(bare);
  if (!claude?.[1]) return bare;

  const parts = claude[1].replace(/-\d{8}$/, "").split("-");
  const [family = "", ...version] = parts;
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return version.length > 0 ? `${name} ${version.join(".")}` : name;
}

/**
 * Claude first, then everyone else in the order the endpoint gave them.
 *
 * Both are offered, because the agent speaks both wire formats: a Claude id
 * routes to `/v1/messages` and anything else to `/v1/chat/completions`. Claude
 * leads only because it is what the skill catalog and tool loop were tuned
 * against, not because the rest are second class.
 */
const claudeFirst = (a: Model, b: Model): number =>
  Number(/(^|\/)claude-/i.test(b.id)) - Number(/(^|\/)claude-/i.test(a.id));

/**
 * What the endpoint says it hosts, or why it would not say.
 *
 * `refused` is separated from `unavailable` because they mean opposite things
 * to the person waiting: a rejected key is theirs to fix, while an endpoint
 * without a model list is nobody's fault and must not stop onboarding.
 */
export type Catalog =
  | { kind: "live"; models: Model[] }
  | { kind: "refused" }
  | { kind: "unavailable" };

/**
 * Asks the endpoint what it hosts, so the list is the provider's own.
 *
 * Every gateway checked here answers `GET <base>/v1/models` with an OpenAI
 * shaped `{ data: [{ id }] }`, and so does api.anthropic.com — one shape covers
 * all of them. Failure is never fatal: a provider that does not answer falls
 * back to the curated list rather than blocking the only screen that can fix it.
 */
export async function fetchModels(
  provider: Provider,
  apiKey: string,
  baseURL: string,
  timeoutMs = 8000,
): Promise<Catalog> {
  const root = (baseURL || "https://api.anthropic.com").replace(/\/+$/, "");

  try {
    const response = await fetch(`${root}/v1/models`, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // Some gateways read the key from Authorization and ignore x-api-key.
        ...(provider.bearer ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status === 401 || response.status === 403) return { kind: "refused" };
    if (!response.ok) return { kind: "unavailable" };

    const body: unknown = await response.json();
    const rows = (body as { data?: unknown })?.data;
    if (!Array.isArray(rows)) return { kind: "unavailable" };

    const models: Model[] = [];
    for (const row of rows) {
      const entry = row as Record<string, unknown>;
      const id = entry["id"];
      if (typeof id !== "string" || id === "") continue;

      const given = entry["display_name"] ?? entry["name"];
      models.push({
        id,
        label: typeof given === "string" && given !== "" ? given : describeModel(id),
        note: context(entry["context_length"] ?? entry["max_input_tokens"]),
      });
    }

    // An endpoint that answers with an empty list has told us nothing usable.
    if (models.length === 0) return { kind: "unavailable" };
    return { kind: "live", models: models.sort(claudeFirst) };
  } catch {
    return { kind: "unavailable" };
  }
}

/** The curated list, spelled the way this provider spells things. */
export const fallbackModels = (provider: Provider): Model[] =>
  FALLBACK_MODELS.map((model) => ({ ...model, id: modelName(provider, model.id) }));

/**
 * Narrows a list as someone types.
 *
 * Substring rather than the fuzzy match the command palette uses: a model list
 * is a list of near-identical names, and fuzzy scoring across them puts
 * surprising rows at the top of a list where the user usually knows the exact
 * string they are after.
 */
export function filterModels(models: readonly Model[], term: string): Model[] {
  const needle = term.trim().toLowerCase();
  if (needle === "") return [...models];
  return models.filter((model) => `${model.label} ${model.id}`.toLowerCase().includes(needle));
}

/** What gets written to .env: where to reach the model, and which one. */
export function envLines(
  provider: Provider,
  apiKey: string,
  model: string,
  baseURL?: string,
): Record<string, string> {
  const url = baseURL ?? provider.baseURL;
  return {
    ANTHROPIC_API_KEY: apiKey,
    ...(url ? { ANTHROPIC_BASE_URL: url } : {}),
    // Written exactly as chosen. Spelling is settled when the list is built —
    // a live id arrives correct, and a fallback id went through `modelName` —
    // so translating again here would namespace an already-namespaced name.
    ANTHROPIC_MODEL: model,
  };
}
