// pi-ai model access for Dodo's two gateways.
//
// Replaces the AI SDK `createOpenAICompatible` provider plus Dodo's own
// Anthropic cache-marker body rewrite and session-affinity header: pi-ai's
// `openai-completions` API does both through `compat` (cacheControlFormat,
// sessionAffinityFormat), driven by the conversation's persisted provider
// session id.
//
// Exception: Anthropic models on AI Gateway use pi-ai's `anthropic-messages`
// API against the gateway's provider-native `/anthropic` endpoint. The
// unified `/compat` endpoint strips every `cache_control` marker (measured
// 2026-10-21, PR #110), so on `/compat` every Anthropic turn paid full input
// price for the whole prefix. Explore/task subagents (src/subagent-runner.ts,
// AI SDK) do the same through `@ai-sdk/anthropic`, using the same URL helper.

import type { Model, ProviderStreams, StreamOptions } from "@earendil-works/pi-ai";
import { createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { FALLBACK_MODELS, modelSupportsVision, WORKERS_AI_MODELS } from "../model-catalog";
import { aigMetadataHeader, anthropicGatewayBaseUrl, resolveWireModelId } from "../subagent-runner";
import type { Env } from "../types";
import { log } from "../logger";
import { rateLimitFetch } from "./rate-limit-fetch";
import { withStreamIdleTimeout } from "./stream-idle-timeout";

export { anthropicGatewayBaseUrl };

export const DODO_PROVIDER_ID = "dodo-gateway";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 32_000;

export interface GatewayConfig {
  activeGateway: "opencode" | "ai-gateway";
  opencodeBaseURL: string;
  aiGatewayBaseURL: string;
  /** Tags AI Gateway logs with the session (cf-aig-metadata), so cost can be pulled per session. */
  sessionId?: string;
}

const CATALOG = new Map<string, { contextWindow: number; costInput: number | null; costOutput: number | null }>(
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

/** The pi-ai model for one Dodo model id on the configured gateway. */
export function dodoModel(modelId: string, config: GatewayConfig, env: Env): Model<"openai-completions"> | Model<"anthropic-messages"> {
  const isOpencode = config.activeGateway === "opencode";
  const entry = CATALOG.get(modelId);
  const anthropic = modelId.startsWith("anthropic/");
  const nativeAnthropicUrl = anthropic ? anthropicGatewayBaseUrl(config) : undefined;
  if (nativeAnthropicUrl) {
    return {
      // Keep the Dodo id: it is the model ref (agentModelRef) and the usage
      // key. The wire id (`claude-…`) is set in anthropicGatewayStreams.
      id: modelId,
      name: modelId,
      api: "anthropic-messages",
      provider: DODO_PROVIDER_ID,
      baseUrl: nativeAnthropicUrl,
      reasoning: false,
      input: modelSupportsVision(modelId) ? ["text", "image"] : ["text"],
      cost: modelCost(modelId),
      contextWindow: entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    };
  }
  return {
    id: resolveWireModelId(modelId, config.activeGateway),
    name: modelId,
    api: "openai-completions",
    provider: DODO_PROVIDER_ID,
    baseUrl: trim(isOpencode ? config.opencodeBaseURL : config.aiGatewayBaseURL),
    reasoning: false,
    input: modelSupportsVision(modelId) ? ["text", "image"] : ["text"],
    cost: modelCost(modelId),
    contextWindow: entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
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
      // Anthropic via OpenAI-compat (OpenCode, or an AI Gateway URL that isn't
      // `/compat`) gets explicit cache_control markers (was
      // addAnthropicCacheMarkers). AI Gateway `/compat` strips them, which is
      // why Anthropic there goes native instead; not verified on OpenCode.
      ...(anthropic ? { cacheControlFormat: "anthropic" as const } : {}),
    },
  };
}

/**
 * Gateway auth headers. `Authorization: null` stops the OpenAI client from
 * sending its placeholder bearer token, which AI Gateway would otherwise
 * read as a (bad) Cloudflare API token — the same thing pi-ai's own
 * cloudflare-ai-gateway provider does.
 */
export function gatewayHeaders(config: GatewayConfig, env: Env): Record<string, string | null> {
  return config.activeGateway === "opencode"
    ? { "cf-access-token": env.OPENCODE_GATEWAY_TOKEN ?? "", Authorization: null }
    : {
        "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_KEY ?? ""}`,
        "x-api-key": env.AI_GATEWAY_KEY ?? "",
        ...aigMetadataHeader(config.sessionId, "main"),
        Authorization: null,
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

/** Dodo's `anthropic/claude-…` id → the id Anthropic's Messages API expects. */
export function nativeAnthropicModelId(modelId: string): string {
  return modelId.replace(/^anthropic\//, "");
}

/**
 * pi-ai's anthropic-messages API, adapted to AI Gateway's native endpoint:
 * - Auth is `cf-aig-authorization` only. The provider's placeholder API key
 *   would go out as `x-api-key`, and the gateway forwards a key it doesn't
 *   recognise to Anthropic as bring-your-own-key, which 401s.
 * - The request carries the native model id (`claude-…`), while the pi-ai
 *   model (and so the transcript and usage keys) keeps Dodo's id.
 * pi-ai adds the cache breakpoints itself (system, last tool, last user
 * message; cacheRetention defaults to "short").
 */
export function anthropicGatewayStreams(api: ProviderStreams = anthropicMessagesApi()): ProviderStreams {
  const adapt = <T extends StreamOptions | undefined>(options: T): T => ({
    ...options,
    apiKey: undefined,
    headers: { ...options?.headers, "x-api-key": null, Authorization: null },
    onPayload: async (payload: unknown, model: Model<"anthropic-messages">) => {
      const replaced = await options?.onPayload?.(payload, model as never);
      const params = (replaced ?? payload) as { model?: unknown };
      return typeof params.model === "string" ? { ...params, model: nativeAnthropicModelId(params.model) } : params;
    },
  }) as T;
  return {
    stream: (model, context, options) => api.stream(model, context, adapt(options)),
    streamSimple: (model, context, options) => api.streamSimple(model, context, adapt(options)),
  };
}

/** Install (or replace) the Dodo gateway provider with exactly these models. */
export function setDodoProvider(models: MutableModels, modelIds: readonly string[], config: GatewayConfig, env: Env): MutableModels {
  const unique = [...new Set(modelIds.filter(Boolean))];
  const list = unique.map((id) => dodoModel(id, config, env));
  const rateLimitOptions = {
    onWait: ({ attempt, delayMs, retryAfter }: { attempt: number; delayMs: number; retryAfter: string | null }) =>
      log("warn", "pi: model rate limited, waiting", { sessionId: config.sessionId, attempt, delayMs: Math.round(delayMs), retryAfter }),
  };
  const idleOptions = {
    onTimeout: ({ model, idleMs, events }: { model: string; idleMs: number; events: number }) =>
      log("warn", "pi: model stream idle, failing the request for retry", { sessionId: config.sessionId, model, idleMs, events }),
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
      models: list,
      // Keyed by model.api: Anthropic on AI Gateway goes native (see top).
      // Both wait out per-minute 429s inside the request (rate-limit-fetch.ts),
      // and fail a request that goes quiet as retryable (stream-idle-timeout.ts).
      api: {
        "openai-completions": withStreamIdleTimeout(withRateLimitRetry(openAICompletionsApi(), rateLimitOptions), idleOptions),
        "anthropic-messages": withStreamIdleTimeout(withRateLimitRetry(anthropicGatewayStreams(), rateLimitOptions), idleOptions),
      },
    }),
  );
  return models;
}

export function agentModelRef(modelId: string, config: GatewayConfig): { provider: string; modelId: string } {
  // Must match the id dodoModel() registers: native Anthropic keeps the Dodo id.
  const native = modelId.startsWith("anthropic/") && anthropicGatewayBaseUrl(config) !== undefined;
  return { provider: DODO_PROVIDER_ID, modelId: native ? modelId : resolveWireModelId(modelId, config.activeGateway) };
}
