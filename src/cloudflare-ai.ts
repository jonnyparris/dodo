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
// `@cf/` ids take createAI's Workers AI run path (`env.AI.run` with the
// gateway option, plus createAI's per-model request quirks) when
// WORKERS_AI_VIA_BINDING is on, main session only. Off by default until a
// live A/B shows it is at least as good as `/compat` (run bench/model-ab.ts
// against two deploys, one with the var set; the bench can't set it).
//
// Everything else on AI Gateway (OpenAI, Google, DeepSeek; `@cf/` with the
// flag off or in explore/task subagents) stays on `/compat` with
// AI_GATEWAY_KEY: createAI has no `/compat` route, Google and DeepSeek are
// not in pi-ai's gateway catalog, moving OpenAI to the Responses wire needs
// its own A/B, and createAI's AI SDK models are LanguageModelV4, which
// AI SDK 6 (the subagents' `ai`) rejects.

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
      log("warn", "createAI: CLOUDFLARE_ACCOUNT_ID is unset or doesn't match AI_GATEWAY_BASE_URL; createAI models (Anthropic, and @cf/ with WORKERS_AI_VIA_BINDING) stay on /compat", {
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
  // Start the call first: a synchronous throw then leaves no abort listener behind.
  const pending = run(request, rest);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    // run() may have aborted the signal synchronously; "abort" won't fire again.
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
  });
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

/** `model` is the Workers AI model id on the run path (for the per-model budget); undefined on `gateway(id).run`. */
type Retry = (send: () => Promise<Response>, signal?: AbortSignal | null, model?: string) => Promise<Response>;

/** Workers AI rate-limit errors: 3021 (requests per minute) and 3040 (capacity), by code or by their wording. */
const RATE_LIMIT_ERROR = /(?:^|AiError:?\s*)(3021|3040):|per min rate reached|capacity temporarily exceeded/i;

/**
 * `env.AI.run` with `returnRawResponse` should hand back a 429 as a Response,
 * but an `AiError` can also be thrown (3021 arrives that way on other paths;
 * see rate-limit-fetch.ts). Turn a thrown rate limit into a 429 Response so
 * the retry wrapper waits it out; anything else is rethrown unchanged.
 */
export async function runAsResponse(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    const httpCode = (error as { httpCode?: unknown } | null)?.httpCode;
    const message = error instanceof Error ? error.message : String(error);
    if (httpCode !== 429 && !RATE_LIMIT_ERROR.test(message)) throw error;
    return new Response(JSON.stringify({ errors: [{ message }] }), { status: 429, headers: { "content-type": "application/json" } });
  }
}

/**
 * The `AI` binding, adapted for createAI: `gateway(id).run` (Anthropic) and
 * `run` (Workers AI run path) keep the AbortSignal on this side of the RPC
 * boundary (runWithLocalSignal) and, when `retry` is given, go through it.
 * `run` also turns a thrown rate limit into a 429 (runAsResponse). createAI
 * never calls `fetch`, so the 429 wait in rate-limit-fetch.ts has to sit on
 * the binding instead. `then` and `aiGatewayLogId` read as undefined (on the
 * stub they'd be remote calls); everything else passes through.
 */
export function adaptBindingForCreateAI(binding: Ai, retry?: Retry): Ai {
  // `env.AI` is an RPC stub: every property access, `.bind` and `.call`
  // included, becomes a remote call. So never touch methods on it; call them
  // by name through closures (seen live 2026-10-22: `.bind` sent an
  // RpcPromise over the wire and failed to serialise). `gateway(id)` returns
  // a plain wrapper; the underlying call is still a pipelined RPC.
  // Two calls are adapted: `gateway(id).run` (Anthropic) and `run` (the
  // Workers AI path for `@cf/` models when WORKERS_AI_VIA_BINDING is on).
  type Callable = Record<PropertyKey, (...args: unknown[]) => unknown>;
  const stub = binding as unknown as Callable;
  const local = (run: GatewayRun, model?: string): GatewayRun => (request, options) => {
    const send = () => runWithLocalSignal(run, request, options);
    return retry ? retry(send, options?.signal, model) : send();
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
      // Workers AI run path (`@cf/` models when WORKERS_AI_VIA_BINDING is
      // on): same AbortSignal problem, and the same 429 wait as the gateway
      // leg, because `/compat` waited out Workers AI 429s too.
      if (prop === "run") {
        return (model: unknown, inputs: unknown, options?: Parameters<GatewayRun>[1]) =>
          local((_req, opts) => runAsResponse(() => stub.run(model, inputs, opts) as Promise<Response>), typeof model === "string" ? model : undefined)(undefined, options);
      }
      // createAI reads this after a run call as a fallback log id. On the stub
      // it would be a remote property (an RpcPromise, not a string); the
      // `cf-aig-log-id` response header carries the same id.
      if (prop === "aiGatewayLogId") return undefined;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (...args: unknown[]) => stub[prop](...args) : value;
    },
  });
}
