// Anthropic models on AI Gateway go through the Agents SDK's `createAI`
// (agents/models/pi-ai for the main session, agents/models/ai-sdk `routed`
// for explore/task subagents). Both call AI Gateway through the `AI` binding
// (`env.AI.gateway(id).run`, the universal endpoint), so this leg needs no
// AI_GATEWAY_KEY and no hand-built gateway URL or cf-aig-* headers.
//
// Replaces PR #110's special case, which pointed pi-ai / @ai-sdk/anthropic at
// the gateway's `/anthropic` URL with `cf-aig-authorization`. The reason for
// that case still holds: the unified `/compat` endpoint strips every
// `cache_control` marker, so Anthropic must use the native Messages wire.
// createAI's Anthropic wire is that native wire.
//
// Everything else on AI Gateway (`@cf/` ids, OpenAI, Google, DeepSeek) stays
// on `/compat` with AI_GATEWAY_KEY: createAI has no `/compat` route, Google
// and DeepSeek are not in pi-ai's gateway catalog, and moving `@cf/` to
// `env.AI.run` or OpenAI to the Responses wire changes behaviour that needs
// its own live A/B first.

import { log } from "./logger";
import type { Env } from "./types";

let warnedAccount = false;

export interface GatewayRouteConfig {
  activeGateway: "opencode" | "ai-gateway";
  aiGatewayBaseURL: string;
}

/**
 * The gateway the `AI` binding should call for this config, or undefined
 * when the binding can't stand in for the configured URL: not on AI
 * Gateway, no binding, a URL that isn't AI Gateway's
 * `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/compat`, or a
 * gateway in another account (the binding only reaches the Worker's own).
 * Fails closed: without CLOUDFLARE_ACCOUNT_ID there is no way to tell, so
 * the configured URL keeps going over HTTP.
 */
export function bindingGatewayId(config: GatewayRouteConfig, env: Pick<Env, "AI" | "CLOUDFLARE_ACCOUNT_ID">): string | undefined {
  if (config.activeGateway !== "ai-gateway" || !config.aiGatewayBaseURL || !env.AI) return undefined;
  let url: URL;
  try {
    url = new URL(config.aiGatewayBaseURL);
  } catch {
    return undefined;
  }
  if (url.host !== "gateway.ai.cloudflare.com") return undefined;
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  const match = /^\/v1\/([^/]+)\/([^/]+)\/compat$/.exec(path);
  if (!match) return undefined;
  const [, accountId, gatewayId] = match;
  if (env.CLOUDFLARE_ACCOUNT_ID?.trim() !== accountId) {
    if (!warnedAccount) {
      warnedAccount = true;
      log("warn", "createAI: CLOUDFLARE_ACCOUNT_ID is unset or doesn't match AI_GATEWAY_BASE_URL; Anthropic stays on /compat (no prompt caching)", {
        gatewayAccount: accountId,
        accountSet: !!env.CLOUDFLARE_ACCOUNT_ID,
      });
    }
    return undefined;
  }
  return gatewayId;
}

/** AI Gateway log metadata for one Dodo request (scalars only: the gateway rejects nested values). */
export function gatewayMetadata(sessionId: string | undefined, role: "main" | "subagent"): Record<string, string> | undefined {
  return sessionId ? { dodo_session: sessionId, dodo_role: role } : undefined;
}

type GatewayRun = (request: unknown, options?: { signal?: AbortSignal | null } & Record<string, unknown>) => Promise<Response>;

/**
 * The `AI` binding, with `gateway(id).run` sent through `retry`. createAI
 * never calls `fetch`, so the 429 wait in rate-limit-fetch.ts has to sit on
 * the binding instead. Everything else passes through untouched.
 */
export function bindingWithGatewayRetry(binding: Ai, retry: (send: () => Promise<Response>, signal?: AbortSignal | null) => Promise<Response>): Ai {
  return new Proxy(binding, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop !== "gateway" || typeof value !== "function") {
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      }
      return (id: string) => {
        const gateway = (value as (id: string) => object).call(target, id);
        return new Proxy(gateway, {
          get(g, p) {
            const member = Reflect.get(g, p, g) as unknown;
            if (typeof member !== "function") return member;
            if (p !== "run") return (member as (...a: unknown[]) => unknown).bind(g);
            const run = (member as GatewayRun).bind(g);
            return (request: unknown, options?: Parameters<GatewayRun>[1]) => retry(() => run(request, options), options?.signal);
          },
        });
      };
    },
  });
}
