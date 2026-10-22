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

/** Always an AbortError, so createAI and pi-ai report "aborted", not a failure. */
function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason as unknown;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const error = new Error("Request aborted", { cause: reason });
  error.name = "AbortError";
  return error;
}

/**
 * Call the binding without handing it the AbortSignal, and apply the signal
 * here instead. createAI passes `signal` to the binding's `run` calls, but
 * the binding is an RPC stub and workerd refuses to serialise an AbortSignal
 * ("AbortSignal serialization is not enabled", seen live on preview
 * 2026-10-22). On abort: the wait rejects at once, a response that arrives
 * later has its body cancelled, and a body already streaming stops (pipeTo
 * cancels the source). The binding call itself can't be cancelled from here,
 * so an upstream request already in flight may still run to completion.
 */
export async function runWithLocalSignal(run: GatewayRun, request: unknown, options?: Parameters<GatewayRun>[1]): Promise<Response> {
  const signal = options?.signal ?? undefined;
  if (!signal) return run(request, options);
  const { signal: _dropped, ...rest } = options!;
  if (signal.aborted) throw abortReason(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const pending = run(request, rest);
  let response: Response;
  try {
    response = await Promise.race([pending, aborted]);
  } catch (error) {
    // Lost the race to an abort: drop whatever the binding returns later.
    pending.then((late) => late.body?.cancel().catch(() => {}), () => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort!);
  }
  if (!response.body) return response;
  const { readable, writable } = new TransformStream();
  response.body.pipeTo(writable, { signal }).catch(() => {});
  return new Response(readable, response);
}

type Retry = (send: () => Promise<Response>, signal?: AbortSignal | null) => Promise<Response>;

/**
 * The `AI` binding, adapted for createAI: `gateway(id).run` keeps the
 * AbortSignal on this side of the RPC boundary (runWithLocalSignal) and, when
 * `retry` is given, goes through it. createAI never calls `fetch`, so the 429
 * wait in rate-limit-fetch.ts has to sit on the binding instead. Everything
 * else passes through untouched.
 */
export function adaptBindingForCreateAI(binding: Ai, retry?: Retry): Ai {
  // `env.AI` is an RPC stub: every property access, `.bind` and `.call`
  // included, becomes a remote call. So never touch methods on it; call them
  // by name through closures (seen live 2026-10-22: `.bind` sent an
  // RpcPromise over the wire and failed to serialise). `gateway(id)` returns
  // a plain wrapper; the underlying call is still a pipelined RPC.
  // Only `gateway(id).run` is adapted: Dodo's createAI leg is Anthropic only,
  // so createAI never takes the Workers AI `run` path here.
  type Callable = Record<PropertyKey, (...args: unknown[]) => unknown>;
  const stub = binding as unknown as Callable;
  const local = (run: GatewayRun): GatewayRun => (request, options) => {
    const send = () => runWithLocalSignal(run, request, options);
    return retry ? retry(send, options?.signal) : send();
  };
  return new Proxy(binding, {
    get(target, prop) {
      if (prop === "gateway") {
        return (id: string) => {
          const gateway = stub.gateway(id) as Callable;
          return {
            run: local((request, options) => gateway.run(request, options) as Promise<Response>),
            getLog: (...args: unknown[]) => gateway.getLog(...args),
            getUrl: (...args: unknown[]) => gateway.getUrl(...args),
            patchLog: (...args: unknown[]) => gateway.patchLog(...args),
          };
        };
      }
      // Never let the adapter look thenable: `await` on it would be a remote call.
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return Reflect.get(target, prop, target);
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (...args: unknown[]) => stub[prop](...args) : value;
    },
  });
}
