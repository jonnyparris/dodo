// fetch wrapper that takes a slot from the shared model budget
// (src/model-budget.ts) before each model request, and reports per-minute
// 429s back to it. Used by the pi main loop (src/pi/models.ts) and the
// explore/task subagents (src/subagent-runner.ts).
//
// It sits under any 429 retry wrapper, so every resend asks for its own
// slot. Fails open: if the budget call throws or takes longer than
// BUDGET_CALL_TIMEOUT_MS, the request goes out. That adds at most 1s to a
// request when the SharedIndex DO is slow. After maxWaitMs of waiting
// the request goes out anyway: a subagent is never failed by the budget,
// and a 429 it then gets is retried (and re-gated) by the AI SDK.

import { abortableSleep, retryAfterMs, transient } from "./pi/rate-limit-fetch";
import type { BudgetDecision, BudgetPriority } from "./model-budget";
import { budgetKey, modelRpm } from "./model-budget";
import { log } from "./logger";
import type { Env } from "./types";

export interface ModelBudgetClient {
  acquire(key: string, rpm: number, priority: BudgetPriority): Promise<BudgetDecision>;
  report429(key: string, rpm: number, retryAfterMs?: number): Promise<void>;
}

export interface ModelBudgetWaitInfo {
  key: string;
  priority: BudgetPriority;
  waitMs: number;
  used: number;
  limit: number;
}

export interface BudgetFetchOptions {
  client: ModelBudgetClient;
  key: string;
  rpm: number;
  priority: BudgetPriority;
  /** Most time spent waiting for a slot before sending anyway. */
  maxWaitMs?: number;
  /**
   * "request" (default): maxWaitMs applies to each fetch call. "total": to
   * every call this wrapper makes, so one pi model request and all its 429
   * resends share one wait allowance (the wrapper is built per request).
   */
  maxWaitScope?: "request" | "total";
  onWait?: (info: ModelBudgetWaitInfo) => void;
  /** For tests. */
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  /** For tests. Default BUDGET_CALL_TIMEOUT_MS. */
  callTimeoutMs?: number;
}

/** Budget calls that fail open, logged at most once a minute per isolate. */
let lastFailOpenLog = 0;
function logFailOpen(key: string, error: unknown): void {
  const now = Date.now();
  if (now - lastFailOpenLog < 60_000) return;
  lastFailOpenLog = now;
  log("warn", "model budget unavailable, sending without a slot", { key, error: error instanceof Error ? error.message : String(error) });
}

/** `call()` with a deadline; a synchronous throw becomes a rejection. */
function withTimeout<T>(call: () => Promise<T>, ms: number): Promise<T> {
  const promise = Promise.resolve().then(call);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("model budget call timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const DEFAULT_MAX_WAIT_MS = 90_000;
/** A budget call slower than this is skipped (fail open): the DO is busy or far away. */
export const BUDGET_CALL_TIMEOUT_MS = 1_000;
/** Spread waiters out so they don't all ask again at the same moment. */
const WAIT_JITTER_MS = 500;

/** The SharedIndex DO's budget RPCs. One book per deployment. */
export function sharedIndexBudgetClient(env: Pick<Env, "SHARED_INDEX">): ModelBudgetClient {
  const stub = () => env.SHARED_INDEX.get(env.SHARED_INDEX.idFromName("global"));
  return {
    acquire: (key, rpm, priority) => stub().modelBudgetAcquire(key, rpm, priority),
    report429: (key, rpm, retryAfter) => stub().modelBudgetReport429(key, rpm, retryAfter),
  };
}

export function budgetFetch(base: typeof fetch, options: BudgetFetchOptions): typeof fetch {
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const sleep = options.sleep ?? abortableSleep;
  const callTimeoutMs = options.callTimeoutMs ?? BUDGET_CALL_TIMEOUT_MS;
  const { client, key, rpm, priority } = options;
  let waitedTotal = 0;

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal ?? (typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined);
    let waited = options.maxWaitScope === "total" ? waitedTotal : 0;
    for (;;) {
      const decision = await withTimeout(() => client.acquire(key, rpm, priority), callTimeoutMs).catch((error) => {
        logFailOpen(key, error);
        return undefined;
      });
      if (decision && !decision.ok && !Number.isFinite(decision.waitMs)) logFailOpen(key, new Error(`bad waitMs ${decision.waitMs}`));
      if (!decision || decision.ok || !Number.isFinite(decision.waitMs)) break;
      const left = maxWaitMs - waited;
      if (left <= 0) break;
      const waitMs = Math.min(left, decision.waitMs + Math.random() * WAIT_JITTER_MS);
      options.onWait?.({ key, priority, waitMs, used: decision.used, limit: decision.limit });
      await sleep(waitMs, signal);
      waited += waitMs;
      waitedTotal += waitMs;
    }
    const response = await base(input, init);
    if (response.status === 429) {
      const body = await response.clone().text().catch(() => "");
      // Not awaited: the caller's own 429 wait shouldn't start late.
      if (transient(body)) void withTimeout(() => client.report429(key, rpm, retryAfterMs(response.headers)), callTimeoutMs).catch((error) => logFailOpen(key, error));
    }
    return response;
  }) as typeof fetch;
}

/**
 * `base` wrapped in the budget for `modelId`, or `base` unchanged when the
 * model has no budget (anything that isn't Workers AI) or there is no
 * SharedIndex binding.
 */
export function withModelBudget(
  base: typeof fetch,
  args: {
    env: Pick<Env, "SHARED_INDEX" | "MODEL_RPM_LIMITS">;
    gateway: string;
    modelId: string;
    priority: BudgetPriority;
    client?: ModelBudgetClient;
    onWait?: (info: ModelBudgetWaitInfo) => void;
    maxWaitMs?: number;
    maxWaitScope?: "request" | "total";
  },
): typeof fetch {
  const rpm = modelRpm(args.modelId, args.env.MODEL_RPM_LIMITS);
  if (rpm === undefined) return base;
  const client = args.client ?? (args.env.SHARED_INDEX ? sharedIndexBudgetClient(args.env) : undefined);
  if (!client) return base;
  return budgetFetch(base, {
    client,
    key: budgetKey(args.gateway, args.modelId),
    rpm,
    priority: args.priority,
    onWait: args.onWait,
    maxWaitMs: args.maxWaitMs,
    maxWaitScope: args.maxWaitScope,
  });
}
