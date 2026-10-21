// pi-ai model access for Dodo's two gateways.
//
// Replaces the AI SDK `createOpenAICompatible` provider plus Dodo's own
// Anthropic cache-marker body rewrite and session-affinity header: pi-ai's
// `openai-completions` API does both through `compat` (cacheControlFormat,
// sessionAffinityFormat), driven by the conversation's persisted provider
// session id.

import type { Model } from "@earendil-works/pi-ai";
import { createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { FALLBACK_MODELS, modelSupportsVision, WORKERS_AI_MODELS } from "../model-catalog";
import { aigMetadataHeader, resolveWireModelId } from "../subagent-runner";
import type { Env } from "../types";

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

/** The pi-ai model for one Dodo model id on the configured gateway. */
export function dodoModel(modelId: string, config: GatewayConfig, env: Env): Model<"openai-completions"> {
  const isOpencode = config.activeGateway === "opencode";
  const entry = CATALOG.get(modelId);
  const anthropic = modelId.startsWith("anthropic/");
  return {
    id: resolveWireModelId(modelId, config.activeGateway),
    name: modelId,
    api: "openai-completions",
    provider: DODO_PROVIDER_ID,
    baseUrl: trim(isOpencode ? config.opencodeBaseURL : config.aiGatewayBaseURL),
    reasoning: false,
    input: modelSupportsVision(modelId) ? ["text", "image"] : ["text"],
    cost: {
      input: entry?.costInput ?? 0,
      output: entry?.costOutput ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
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
      // Anthropic via OpenAI-compat needs explicit cache_control markers
      // (was addAnthropicCacheMarkers).
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

/** Install (or replace) the Dodo gateway provider with exactly these models. */
export function setDodoProvider(models: MutableModels, modelIds: readonly string[], config: GatewayConfig, env: Env): MutableModels {
  const unique = [...new Set(modelIds.filter(Boolean))];
  const list = unique.map((id) => dodoModel(id, config, env));
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
      api: openAICompletionsApi(),
    }),
  );
  return models;
}

export function agentModelRef(modelId: string, config: GatewayConfig): { provider: string; modelId: string } {
  return { provider: DODO_PROVIDER_ID, modelId: resolveWireModelId(modelId, config.activeGateway) };
}
