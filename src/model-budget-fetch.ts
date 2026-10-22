// fetch wrapper that takes a slot from the shared model budget
// (src/model-budget.ts) before each model request, and reports per-minute
// 429s back to it. Used by the pi main loop (src/pi/models.ts) and the
// explore/task subagents (src/subagent-runner.ts).
//
// It sits under any 429 retry wrapper, so every resend asks for its own
// slot. Fails open: if the budget call throws, the request goes out.

import { abortableSleep, retryAfterMs, transient } from "./pi/rate-limit-fetch";
import type { BudgetDecision, BudgetPriority } from "./model-budget";
import { budgetKey, modelRpm } from "./model-budget";
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
  onWait?: (info: ModelBudgetWaitInfo) => void;
  /** For tests. */
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
}

const DEFAULT_MAX_WAIT_MS = 90_000;
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
  const { client, key, rpm, priority } = options;

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    let waited = 0;
    for (;;) {
      const decision = await client.acquire(key, rpm, priority).catch(() => undefined);
      if (!decision || decision.ok) break;
      const left = maxWaitMs - waited;
      if (left <= 0) break;
      const waitMs = Math.min(left, decision.waitMs + Math.random() * WAIT_JITTER_MS);
      options.onWait?.({ key, priority, waitMs, used: decision.used, limit: decision.limit });
      await sleep(waitMs, init?.signal);
      waited += waitMs;
    }
    const response = await base(input, init);
    if (response.status === 429) {
      const body = await response.clone().text().catch(() => "");
      if (transient(body)) {
        await client.report429(key, rpm, retryAfterMs(response.headers)).catch(() => {});
      }
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
  });
}
