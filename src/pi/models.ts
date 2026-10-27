// pi-ai model access for Dodo's two gateways.
//
// Replaces the AI SDK `createOpenAICompatible` provider plus Dodo's own
// Anthropic cache-marker body rewrite and session-affinity header: pi-ai's
// `openai-completions` API does both through `compat` (cacheControlFormat,
// sessionAffinityFormat), driven by the conversation's persisted provider
// session id.
//
// Exception: Anthropic models on AI Gateway go through the Agents SDK's
// `createAI` over the `AI` binding, on Anthropic's native Messages wire (see
// src/cloudflare-ai.ts). The unified `/compat` endpoint strips every
// `cache_control` marker (measured 2026-10-21, PR #110), so on `/compat`
// every Anthropic turn paid full input price for the whole prefix. Those
// models are registered under createAI's own provider id (`cloudflare`).
//
// With WORKERS_AI_VIA_BINDING on, `@cf/` models go through createAI too, on
// its Workers AI run path (`env.AI.run` + per-model request quirks), main
// session only. Off by default until the live A/B says so.

import type { Api, Model, ProviderStreams, TranscriptContext } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway.models";
import { CLOUDFLARE_PROVIDER_ID, createAI } from "agents/models/pi-ai";
import { bindingGatewayId, adaptBindingForCreateAI, compatBindingFetch, compatBindingGatewayId, gatewayMetadata, workersAIOnRunPath } from "../cloudflare-ai";
import { contextWindowFor, FALLBACK_MODELS, modelSupportsVision, WORKERS_AI_MODELS } from "../model-catalog";
import { aigMetadataHeader, resolveWireModelId } from "../subagent-runner";
import type { Env } from "../types";
import { log } from "../logger";
import { type ModelBudgetClient, type ModelBudgetWaitInfo, withModelBudget } from "../model-budget-fetch";
import { rateLimitFetch, type RateLimitFetchOptions } from "./rate-limit-fetch";
import { type StreamIdleTimeoutInfo, withStreamIdleTimeout } from "./stream-idle-timeout";

// Moved to cloudflare-ai.ts (the subagents use it too); re-exported for existing callers.
export { workersAIOnRunPath };

export const DODO_PROVIDER_ID = "dodo-gateway";
/** The `api` createAI gives Workers AI models (its run path, not a wire format). */
export const WORKERS_AI_API = "cloudflare-ai";
type WorkersAIApi = typeof WORKERS_AI_API;
/** Provider id of models that go through createAI (Anthropic on AI Gateway). */
export const CREATE_AI_PROVIDER_ID = CLOUDFLARE_PROVIDER_ID;
const DEFAULT_MAX_TOKENS = 32_000;

export interface GatewayConfig {
  activeGateway: "opencode" | "ai-gateway";
  opencodeBaseURL: string;
  aiGatewayBaseURL: string;
  /** Tags AI Gateway logs with the session (cf-aig-metadata), so cost can be pulled per session. */
  sessionId?: string;
}

const CATALOG = new Map<string, { costInput: number | null; costOutput: number | null }>(
  [...FALLBACK_MODELS, ...WORKERS_AI_MODELS].map((m) => [m.id, m]),
);

function trim(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** Anthropic prices cache reads at 0.1x and 5-minute cache writes at 1.25x base input. */
const ANTHROPIC_CACHE_READ_MULTIPLIER = 0.1;
const ANTHROPIC_CACHE_WRITE_MULTIPLIER = 1.25;

type ModelCost = Model<"openai-completions">["cost"];

// pi-ai's bundled vendor catalogs, keyed by the bare model id. Dodo ids are
// `vendor/model`, so `openai/gpt-5.4` → OPENAI_MODELS["gpt-5.4"].
const VENDOR_CATALOGS: Record<string, Record<string, { cost?: ModelCost } | undefined>> = {
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
  google: GOOGLE_MODELS,
  deepseek: DEEPSEEK_MODELS,
};

/**
 * Per-turn prices for a Dodo model id. pi-ai's vendor catalog wins when it
 * lists the model: it carries cache-read/write prices and long-context tiers
 * (GPT-5.4 above 272k, Gemini 2.5 Pro above 200k input tokens) that Dodo's
 * catalog doesn't. Otherwise Dodo's catalog, with Anthropic's standard cache
 * multipliers for Anthropic ids and no cache price for the rest (unknown).
 * Input/output agree either way: test/model-catalog-prices-unit.test.ts.
 * On the openai-completions path a cache write is only billed as one when the
 * gateway reports `prompt_tokens_details.cache_write_tokens`; otherwise pi-ai
 * counts those tokens as plain input.
 */
export function modelCost(modelId: string): ModelCost {
  const slash = modelId.indexOf("/");
  const vendor = slash > 0 ? VENDOR_CATALOGS[modelId.slice(0, slash)]?.[modelId.slice(slash + 1)] : undefined;
  if (vendor?.cost) return structuredClone(vendor.cost);
  const entry = CATALOG.get(modelId);
  const input = entry?.costInput ?? 0;
  const anthropic = modelId.startsWith("anthropic/");
  return {
    input,
    output: entry?.costOutput ?? 0,
    cacheRead: anthropic ? input * ANTHROPIC_CACHE_READ_MULTIPLIER : 0,
    cacheWrite: anthropic ? input * ANTHROPIC_CACHE_WRITE_MULTIPLIER : 0,
  };
}

// `anthropic/<id>` ids pi-ai's Cloudflare AI Gateway catalog lists. createAI
// resolves only these by id: the request body must carry Anthropic's own
// spelling, which it reads from the catalog entry.
let gatewayAnthropicIds: Set<string> | undefined;
function inGatewayCatalog(modelId: string): boolean {
  gatewayAnthropicIds ??= new Set(
    Object.values(CLOUDFLARE_AI_GATEWAY_MODELS as Record<string, { id: string; baseUrl: string }>)
      .filter((e) => e.baseUrl.replace(/\/$/, "").endsWith("/anthropic"))
      .map((e) => `anthropic/${e.id}`),
  );
  return gatewayAnthropicIds.has(modelId);
}

/**
 * The gateway id when this model goes through createAI: an Anthropic id
 * pi-ai's gateway catalog lists, on an AI Gateway URL the `AI` binding can
 * reach. Otherwise undefined, and the model stays on the OpenAI-compatible
 * path (uncached for Anthropic on `/compat`).
 */
export function createAIGatewayId(
  modelId: string,
  config: GatewayConfig,
  env: Pick<Env, "AI" | "CLOUDFLARE_ACCOUNT_ID" | "WORKERS_AI_VIA_BINDING">,
): string | undefined {
  const anthropic = modelId.startsWith("anthropic/") && inGatewayCatalog(modelId);
  if (!anthropic && !workersAIOnRunPath(modelId, env)) return undefined;
  return bindingGatewayId(config, env);
}


function createAIFor(config: GatewayConfig, env: Env, gatewayId: string, rateLimit?: RateLimitFetchOptions, budget?: ModelBudgetStreamOptions) {
  // createAI never calls fetch, so the 429 wait wraps the binding call. The
  // URL is a label only: the wrapped "fetch" ignores it and calls the binding.
  // On the Workers AI run path each send (429 resends included) also takes a
  // slot from the shared per-model budget, as withModelBudgetStreams does on
  // /compat: same key, so main turns and subagents share one book. Built per
  // `run` call (createAI makes one per model request), so maxWaitScope
  // "total" covers one request and its resends.
  const binding = adaptBindingForCreateAI(env.AI, (run, signal, model) => {
    const send: typeof fetch = () => run();
    const gated =
      budget && model
        ? withModelBudget(send, {
            env: budget.env,
            gateway: budget.gateway,
            modelId: model,
            priority: "main",
            client: budget.client,
            onWait: budget.onWait,
            maxWaitMs: MAIN_BUDGET_MAX_WAIT_MS,
            maxWaitScope: "total",
          })
        : send;
    return rateLimitFetch(gated, rateLimit)("https://gateway.ai.cloudflare.com/universal", { signal: signal ?? undefined });
  });
  const metadata = gatewayMetadata(config.sessionId, "main");
  return createAI({ binding, id: gatewayId, ...(metadata ? { metadata } : {}) });
}

/** The pi-ai model for one Dodo model id on the configured gateway. */
export function dodoModel(modelId: string, config: GatewayConfig, env: Env): Model<"openai-completions"> | Model<"anthropic-messages"> | Model<WorkersAIApi> {
  const gatewayId = createAIGatewayId(modelId, config, env);
  if (gatewayId && modelId.startsWith("@cf/")) return workersAIModel(modelId, gatewayId, env);
  if (gatewayId) {
    // createAI's catalog model (api anthropic-messages, gateway-shaped
    // baseUrl, provider `cloudflare`, id = the Dodo id) with Dodo's limits and
    // prices. Spreading keeps createAI's routing tags.
    const base = createAI({ binding: adaptBindingForCreateAI(env.AI), id: gatewayId })(modelId) as Model<"anthropic-messages">;
    return {
      ...base,
      name: modelId,
      reasoning: false,
      input: modelSupportsVision(modelId) ? ["text", "image"] : ["text"],
      cost: modelCost(modelId),
      // Dodo's catalog first, then createAI's own entry, then contextWindowFor's fallbacks.
      contextWindow: CATALOG.has(modelId) || !base.contextWindow ? contextWindowFor(modelId) : base.contextWindow,
      maxTokens: DEFAULT_MAX_TOKENS,
    };
  }
  return compatModel(modelId, config);
}

/**
 * createAI's Workers AI model (api `cloudflare-ai`, run path) with Dodo's
 * limits and prices. `reasoning: false` like the `/compat` leg: pi sends no
 * effort, so the model keeps its own default, same as before. The context
 * window falls back to pi-ai's Workers AI catalog (e.g. 32k for Qwen3 30B),
 * which also bounds `max_tokens` (withWorkersAIMaxTokens).
 */
function workersAIModel(modelId: string, gatewayId: string, env: Env): Model<WorkersAIApi> {
  const base = createAI({ binding: adaptBindingForCreateAI(env.AI), id: gatewayId })(modelId) as Model<WorkersAIApi>;
  return {
    ...base,
    name: modelId,
    reasoning: false,
    input: modelSupportsVision(modelId) ? ["text", "image"] : ["text"],
    cost: modelCost(modelId),
    contextWindow: CATALOG.has(modelId) || !base.contextWindow ? contextWindowFor(modelId) : base.contextWindow,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

/** The OpenAI-compatible (`/compat` or OpenCode) model for a Dodo id, whatever leg new turns use. */
function compatModel(modelId: string, config: GatewayConfig): Model<"openai-completions"> {
  const isOpencode = config.activeGateway === "opencode";
  const anthropic = modelId.startsWith("anthropic/");
  return {
    id: resolveWireModelId(modelId, config.activeGateway),
    name: modelId,
    api: "openai-completions",
    provider: DODO_PROVIDER_ID,
    baseUrl: trim(isOpencode ? config.opencodeBaseURL : config.aiGatewayBaseURL),
    reasoning: false,
    input: modelSupportsVision(modelId) ? ["text", "image"] : ["text"],
    cost: modelCost(modelId),
    contextWindow: contextWindowFor(modelId),
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: {
      // Both gateways are unified OpenAI-compatible endpoints in front of
      // many vendors; stick to the lowest common denominator.
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsUsageInStreaming: true,
      // Workers AI prefix caching is per replica: affinity keeps one
      // conversation's steps on one replica (was a hand-set header).
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: "openai-nosession",
      // Anthropic via OpenAI-compat (OpenCode, or an AI Gateway URL the
      // binding can't reach) gets explicit cache_control markers (was
      // addAnthropicCacheMarkers). AI Gateway `/compat` strips them, which is
      // why Anthropic there goes through createAI instead; not verified on
      // OpenCode.
      ...(anthropic ? { cacheControlFormat: "anthropic" as const } : {}),
    },
  };
}

/** Headers gatewayHeaders() can add, which the createAI leg must never send. */
const GATEWAY_AUTH_HEADERS = new Set(["authorization", "x-api-key", "cf-aig-authorization", "cf-aig-metadata", "cf-access-token"]);

/**
 * Gateway auth headers. `Authorization: null` stops the OpenAI client from
 * sending its placeholder bearer token, which AI Gateway would otherwise
 * read as a (bad) Cloudflare API token — the same thing pi-ai's own
 * cloudflare-ai-gateway provider does.
 */
export function gatewayHeaders(config: GatewayConfig, env: Env): Record<string, string | null> {
  if (config.activeGateway === "opencode") return { "cf-access-token": env.OPENCODE_GATEWAY_TOKEN ?? "", Authorization: null };
  // Over the binding (withCompatBinding) the binding is the auth: no key.
  const key: Record<string, string> = compatBindingGatewayId(config, env)
    ? {}
    : { "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_KEY ?? ""}`, "x-api-key": env.AI_GATEWAY_KEY ?? "" };
  return { ...key, ...aigMetadataHeader(config.sessionId, "main"), Authorization: null };
}

/**
 * Send `/compat` model requests over the `AI` binding instead of HTTP with
 * AI_GATEWAY_KEY (compatBindingFetch), when the binding reaches the
 * configured gateway. Sets the request's base fetch, so
 * withRateLimitRetry (applied inside this) still waits out 429s around it.
 */
export function withCompatBinding(api: ProviderStreams, config: GatewayConfig, env: Env): ProviderStreams {
  const gatewayId = compatBindingGatewayId(config, env);
  if (!gatewayId) return api;
  const compatBase = trim(config.aiGatewayBaseURL);
  const wrap = <O extends { fetch?: typeof fetch } | undefined>(model: Model<Api>, o: O): O =>
    trim(model.baseUrl) === compatBase ? ({ ...o, fetch: compatBindingFetch(env.AI, gatewayId, compatBase, o?.fetch) } as O) : o;
  return {
    ...api,
    stream: (model, context, options) => api.stream(model, context, wrap(model, options)),
    streamSimple: (model, context, options) => api.streamSimple(model, context, wrap(model, options)),
  };
}

/**
 * createAI's chat-completions wire sends `max_tokens` only when the caller
 * passes `maxTokens`, and pi-durable doesn't. pi-ai's own openai-completions
 * leg fills it from the model (clamped to the room left in the context), so
 * on `/compat` every turn had a cap. Without one Workers AI uses its own
 * small default: on preview gpt-oss-120b stopped with `length` and an empty
 * answer (2026-10-22). Fill it the way pi-ai does, Workers AI models only.
 */
export function withWorkersAIMaxTokens(api: ProviderStreams): ProviderStreams {
  const fill = <O extends { maxTokens?: number } | undefined>(model: Model<Api>, context: TranscriptContext, options: O): O =>
    model.api !== WORKERS_AI_API || options?.maxTokens !== undefined
      ? options
      : ({ ...options, maxTokens: clampMaxTokensToContext(model, context, model.maxTokens) } as O);
  return {
    ...api,
    stream: (model, context, options) => api.stream(model, context, fill(model, context, options)),
    streamSimple: (model, context, options) => api.streamSimple(model, context, fill(model, context, options)),
  };
}

/** True for a Workers AI model's `/compat` entry (wire id `workers-ai/@cf/...`). */
function isWorkersAICompatModel(model: Model<Api>): boolean {
  return model.name.startsWith("@cf/") || model.id.startsWith("workers-ai/@cf/");
}

/** The placeholder the attachment guard uses for a part the model cannot take. */
const DROPPED_ATTACHMENT_NOTE = "[attachment removed from context — this model cannot process file attachments]";

/**
 * Make a `/compat` body acceptable to Workers AI, which validates `content`
 * as a string per message and rejects two shapes pi-ai sends:
 *
 * - `content: null` on a tool-only assistant turn. pi-ai writes
 *   `compat.requiresAssistantAfterToolResult ? "" : null`, and Workers AI
 *   answers `400 Bad input ... required properties at '/messages/2' are
 *   'role,content'`.
 * - `content: [...]` on a turn with more than one block. A text-only model
 *   answers the same 400.
 *
 * On `jp-gw` these failed 30 `@cf/openai/gpt-oss-120b` turns on 2026-10-22 —
 * every turn past the first, while the first turn of the same session, model
 * and gateway succeeded. Vision `@cf/` models keep arrays (glm-5.3-flash
 * parses them: its own 400 was an image-count limit), so `acceptsImages`
 * decides whether an array collapses to its text.
 */
export function stringMessageContent(payload: unknown, acceptsImages: boolean): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const body = payload as { messages?: unknown };
  if (!Array.isArray(body.messages)) return payload;
  let changed = false;
  const messages = body.messages.map((message) => {
    if (!message || typeof message !== "object") return message;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role === "assistant" && content === null) {
      changed = true;
      return { ...(message as Record<string, unknown>), content: "" };
    }
    if (!acceptsImages && Array.isArray(content)) {
      const text = content
        .map((part) => {
          const p = part as { type?: unknown; text?: unknown };
          return p?.type === "text" && typeof p.text === "string" ? p.text : "";
        })
        .filter((t) => t.length > 0)
        .join("\n\n");
      changed = true;
      return { ...(message as Record<string, unknown>), content: text.length > 0 ? text : DROPPED_ATTACHMENT_NOTE };
    }
    return message;
  });
  return changed ? { ...body, messages } : payload;
}

/**
 * Apply stringMessageContent to `/compat` requests for `@cf/` models. A
 * caller-supplied onPayload is chained, not replaced.
 */
export function withWorkersAIStringContent(api: ProviderStreams): ProviderStreams {
  type PayloadHook = (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
  const normalize = <O extends { onPayload?: PayloadHook } | undefined>(model: Model<Api>, options: O): O =>
    isWorkersAICompatModel(model)
      ? ({
          ...options,
          onPayload: async (payload: unknown, m: Model<Api>) => stringMessageContent((await options?.onPayload?.(payload, m)) ?? payload, m.input.includes("image")),
        } as O)
      : options;
  return {
    ...api,
    stream: (model, context, options) => api.stream(model, context, normalize(model, options)),
    streamSimple: (model, context, options) => api.streamSimple(model, context, normalize(model, options)),
  };
}

/**
 * Give every model request a fetch that waits out 429s (see
 * rate-limit-fetch.ts). A caller-supplied fetch is kept as the base.
 */
export function withRateLimitRetry(api: ProviderStreams, fetchOptions?: Parameters<typeof rateLimitFetch>[1]): ProviderStreams {
  const wrap = <O extends { fetch?: typeof fetch } | undefined>(o: O) => ({ ...o, fetch: rateLimitFetch(o?.fetch, fetchOptions) });
  return {
    ...api,
    stream: (model, context, options) => api.stream(model, context, wrap(options)),
    streamSimple: (model, context, options) => api.streamSimple(model, context, wrap(options)),
  };
}

/**
 * Longest one main-turn model request (one harness attempt, with all its
 * 429 resends) waits for budget slots before sending anyway. With the 60s
 * 429 wait in rate-limit-fetch.ts that is at most ~90s of waiting per
 * attempt, inside the 5-minute stream idle timeout; the harness makes up
 * to 4 attempts per prompt.
 */
export const MAIN_BUDGET_MAX_WAIT_MS = 30_000;

export interface ModelBudgetStreamOptions {
  env: Pick<Env, "SHARED_INDEX" | "MODEL_RPM_LIMITS">;
  gateway: string;
  client?: ModelBudgetClient;
  onWait?: (info: ModelBudgetWaitInfo) => void;
}

/**
 * Give every model request a fetch that takes a slot from the shared
 * per-model budget first (src/model-budget.ts), as a main turn: it may use
 * the reserve subagents leave free. Must wrap *outside* withRateLimitRetry,
 * so the 429 resends go through the budget too. `model.name` is the Dodo id.
 */
export function withModelBudgetStreams(api: ProviderStreams, budget: ModelBudgetStreamOptions): ProviderStreams {
  const wrap = <O extends { fetch?: typeof fetch } | undefined>(model: Model<never>, o: O) => ({
    ...o,
    fetch: withModelBudget(o?.fetch ?? ((input, init) => fetch(input, init)), {
      env: budget.env,
      gateway: budget.gateway,
      modelId: model.name,
      priority: "main",
      client: budget.client,
      onWait: budget.onWait,
      maxWaitMs: MAIN_BUDGET_MAX_WAIT_MS,
      // wrap() runs once per model request, so this is per request incl. resends.
      maxWaitScope: "total",
    }),
  });
  return {
    ...api,
    stream: (model, context, options) => api.stream(model, context, wrap(model as Model<never>, options)),
    streamSimple: (model, context, options) => api.streamSimple(model, context, wrap(model as Model<never>, options)),
  };
}

/** Options for setDodoProvider: a production hook plus a test seam. */
export interface DodoProviderOptions {
  /** A main-turn request is waiting for a model-budget slot (UI: "waiting for model capacity"). */
  onBudgetWait?: (info: ModelBudgetWaitInfo) => void;
  /** Overrides the stream idle timeout (tests only; default DEFAULT_STREAM_IDLE_TIMEOUT_MS). */
  idleMs?: number;
}

/**
 * Install (or replace) the Dodo gateway provider with exactly these models.
 * Models on the createAI leg go into a second provider, `cloudflare`, whose
 * streams are createAI's (no gateway key; auth is the binding).
 *
 * The same models are also listed under `dodo-gateway` with their old
 * `anthropic-messages` api: a turn persisted before this change refers to
 * them as `dodo-gateway/anthropic/…`, and pi-durable resumes it with that
 * ref. Those streams look the model up by id and send the createAI one.
 *
 * Workers AI models take a slot from the shared per-model budget
 * (model-budget.ts) on both legs: `openai-completions` (/compat) and the
 * createAI run path (WORKERS_AI_VIA_BINDING).
 */
export function setDodoProvider(
  models: MutableModels,
  modelIds: readonly string[],
  config: GatewayConfig,
  env: Env,
  opts: DodoProviderOptions = {},
): MutableModels {
  const unique = [...new Set(modelIds.filter(Boolean))];
  const rateLimitOptions = {
    onWait: ({ attempt, delayMs, retryAfter }: { attempt: number; delayMs: number; retryAfter: string | null }) =>
      log("warn", "pi: model rate limited, waiting", { sessionId: config.sessionId, attempt, delayMs: Math.round(delayMs), retryAfter }),
  };
  const viaCreateAI = unique.filter((id) => createAIGatewayId(id, config, env) !== undefined);
  // `@cf/` ids not on the run path (flag off, or the binding can't reach the
  // gateway) still get an entry under `cloudflare`, so a turn that started
  // on the run path (ref `cloudflare/@cf/…`) resumes after a rollback. That
  // entry is a /compat model: turning the flag off moves in-flight turns
  // back to /compat too. New turns use `dodo-gateway` (agentModelRef).
  const draining = unique.filter((id) => id.startsWith("@cf/") && !viaCreateAI.includes(id));
  const gatewayId = viaCreateAI.length > 0 ? createAIGatewayId(viaCreateAI[0], config, env) : undefined;
  const createAIModels = viaCreateAI.map((id) => dodoModel(id, config, env) as Model<"anthropic-messages"> | Model<WorkersAIApi>);
  const drainModels = draining.map((id): Model<"openai-completions"> => ({ ...compatModel(id, config), id, provider: CREATE_AI_PROVIDER_ID }));
  // Anthropic createAI models are also listed under dodo-gateway (legacy
  // refs, see below). `@cf/` ones are not: their old ref is
  // `dodo-gateway/workers-ai/@cf/…` on openai-completions, so they stay in
  // the /compat list too and a persisted turn resumes on `/compat` as it started.
  const legacyAliased = createAIModels.filter((m): m is Model<"anthropic-messages"> => m.api === "anthropic-messages");
  const viaCompat = unique.filter((id) => !legacyAliased.some((m) => m.id === id));

  const byId = new Map(createAIModels.map((m) => [m.id, m]));
  // The dodo-gateway auth resolver adds the gateway key headers to every
  // call; createAI would forward them as extra headers. Drop them here.
  const keyless = <O extends { headers?: Record<string, string | null> } | undefined>(options: O): O =>
    options?.headers
      ? ({ ...options, headers: Object.fromEntries(Object.entries(options.headers).filter(([k]) => !GATEWAY_AUTH_HEADERS.has(k.toLowerCase()))) } as O)
      : options;
  const budget: ModelBudgetStreamOptions = {
    env,
    gateway: config.activeGateway,
    onWait: (info) => {
      log("info", "pi: waiting for model capacity", { sessionId: config.sessionId, ...info, waitMs: Math.round(info.waitMs) });
      opts.onBudgetWait?.(info);
    },
  };
  const ai = gatewayId ? createAIFor(config, env, gatewayId, rateLimitOptions, budget) : undefined;
  const idleOptions = {
    idleMs: opts.idleMs,
    onTimeout: (info: StreamIdleTimeoutInfo) => log("warn", "pi: model stream idle, failing the request for retry", { sessionId: config.sessionId, ...info }),
  };
  // Every leg fails a request that goes quiet as retryable (stream-idle-timeout.ts).
  const createAIStreams: ProviderStreams | undefined =
    ai && withStreamIdleTimeout(withWorkersAIMaxTokens({ stream: ai.stream, streamSimple: ai.streamSimple } as ProviderStreams), idleOptions);
  // withCompatBinding is the outermost stream wrapper, so its binding fetch
  // is the base: at request time the 429 wait and the budget wrap the
  // binding call (each resend takes a slot, then goes over the binding).
  const compatStreams = withStreamIdleTimeout(
    withWorkersAIStringContent(
      withCompatBinding(withModelBudgetStreams(withRateLimitRetry(openAICompletionsApi(), rateLimitOptions), budget), config, env),
    ),
    idleOptions,
  );
  // Drained `cloudflare/@cf/…` refs: send the /compat model (wire id
  // `workers-ai/@cf/…`) with the gateway auth the `cloudflare` provider
  // doesn't resolve.
  const drainAuth = <O extends { headers?: Record<string, string | null>; apiKey?: string } | undefined>(options: O): O =>
    ({ ...options, apiKey: "unused", headers: { ...options?.headers, ...gatewayHeaders(config, env) } }) as O;
  const drainStreams: ProviderStreams = {
    stream: (model, context, options) => compatStreams.stream(compatModel(model.id, config), context, drainAuth(options)),
    streamSimple: (model, context, options) => compatStreams.streamSimple(compatModel(model.id, config), context, drainAuth(options)),
  };
  const legacyAnthropic: ProviderStreams | undefined = createAIStreams && {
    stream: (model, context, options) => createAIStreams.stream(byId.get(model.id) ?? model, context, keyless(options)),
    streamSimple: (model, context, options) => createAIStreams.streamSimple(byId.get(model.id) ?? model, context, keyless(options)),
  };
  models.setProvider(
    createProvider({
      id: DODO_PROVIDER_ID,
      name: "Dodo gateway",
      auth: {
        apiKey: {
          name: "Dodo gateway",
          // Placeholder key satisfies pi-ai's key check; the header it would
          // produce is removed by `Authorization: null` in gatewayHeaders().
          resolve: async () => ({ auth: { apiKey: "unused", headers: gatewayHeaders(config, env) } }),
        },
      },
      models: [
        // `@cf/` ids on the run path keep their /compat entry here for
        // persisted `dodo-gateway/workers-ai/@cf/…` refs.
        ...viaCompat.map((id): Model<"openai-completions"> | Model<"anthropic-messages"> => compatModel(id, config)),
        ...legacyAliased.map((m) => ({ ...m, provider: DODO_PROVIDER_ID })),
      ],
      // Waits out per-minute 429s inside the request (rate-limit-fetch.ts)
      // and fails a request that goes quiet as retryable (stream-idle-timeout.ts).
      api: {
        // Workers AI models also take a slot from the shared per-model budget (model-budget.ts).
        "openai-completions": compatStreams,
        ...(legacyAnthropic ? { "anthropic-messages": legacyAnthropic } : {}),
      },
    }),
  );
  if (!ai && drainModels.length === 0) {
    // Nothing on the createAI leg now: drop a provider an earlier config installed.
    models.deleteProvider(CREATE_AI_PROVIDER_ID);
    return models;
  }
  models.setProvider(
    createProvider({
      id: CREATE_AI_PROVIDER_ID,
      name: "Cloudflare AI (binding)",
      auth: { apiKey: { name: "Cloudflare AI (binding)", resolve: async () => ({ auth: {} }) } },
      models: [...createAIModels, ...drainModels],
      api: {
        ...(createAIStreams ? { "anthropic-messages": createAIStreams, [WORKERS_AI_API]: createAIStreams } : {}),
        "openai-completions": drainStreams,
      },
    }),
  );
  return models;
}

export function agentModelRef(modelId: string, config: GatewayConfig, env: Pick<Env, "AI" | "CLOUDFLARE_ACCOUNT_ID" | "WORKERS_AI_VIA_BINDING">): { provider: string; modelId: string } {
  // Must match the provider/id setDodoProvider() registers the model under.
  if (createAIGatewayId(modelId, config, env)) return { provider: CREATE_AI_PROVIDER_ID, modelId };
  return { provider: DODO_PROVIDER_ID, modelId: resolveWireModelId(modelId, config.activeGateway) };
}
