// Shared per-model request budget for Workers AI's per-minute cap.
//
// Workers AI limits requests per minute per account, per model (AiError
// 3021 "inference request per min rate reached"). Frontier models get
// 20/min on standard billing and 50/min on AI Gateway credits
// (developers.cloudflare.com/workers-ai/platform/limits); DeepSeek V4.1
// Flash 1017 measured ~30-40/min on Dodo's account (PR #115 bench). Every
// Dodo session on one deployment uses the same gateway account, so a main
// turn and every explore/task subagent of every user draw from one budget.
//
// PR #121 made a main turn wait out a 429. This module removes most of
// the 429s: before a request goes out, the caller asks the book for a
// slot. Subagents may only use the budget minus a reserve kept for main
// turns, so a subagent fan-out waits first and the user's own turn keeps
// moving. A 429 that gets through anyway (cap lower than configured,
// traffic from outside Dodo) lowers the subagents' learned cap to what was
// in flight and holds them back for the Retry-After; main turns keep the
// configured cap. The learned cap climbs back by 10% of the configured cap
// per quiet minute.
//
// Main turns are never limited by what subagents learned: subagents yield
// first, and a main-turn 429 is waited out by src/pi/rate-limit-fetch.ts.
//
// The book lives in memory in the SharedIndex DO (one per deployment). If
// that DO restarts, the window starts empty: worst case one burst of 429s,
// which the 429 retries still absorb. Callers fail open: a budget call that
// throws never blocks a model request.

import { log } from "./logger";

export type BudgetPriority = "main" | "subagent";

export interface BudgetDecision {
  ok: boolean;
  /** When `ok` is false: how long to wait before asking again. */
  waitMs: number;
  /** Requests recorded in the last minute (including this one when ok). */
  used: number;
  /** The most this priority may use per minute right now. */
  limit: number;
  /** Learned cap (≤ configured rpm). */
  cap: number;
}

export interface BudgetSnapshotEntry {
  key: string;
  rpm: number;
  cap: number;
  used: number;
  cooldownMs: number;
  throttled: number;
  rateLimited: number;
}

export const WINDOW_MS = 60_000;
/** Share of the cap subagents must leave free for main turns. */
export const SUBAGENT_RESERVE = 0.25;
/** The learned cap never drops below this share of the configured rpm. */
const MIN_CAP_SHARE = 0.25;
/** Raise per quiet minute, as a share of the configured rpm. */
const RECOVERY_SHARE = 0.1;
/** Least cut to the learned cap per 429 episode. */
const CAP_CUT_SHARE = 0.2;
/** The cap is cut at most once per interval, however many 429s arrive (main-turn 429s count too). */
const CUT_INTERVAL_MS = 15_000;
/** Subagent hold after a 429 without Retry-After. */
const DEFAULT_COOLDOWN_MS = 5_000;
const MAX_COOLDOWN_MS = WINDOW_MS;
const MIN_WAIT_MS = 50;

interface Bucket {
  rpm: number;
  cap: number;
  stamps: number[];
  cooldownUntil: number;
  lastCapChange: number;
  lastCutAt: number;
  throttled: number;
  rateLimited: number;
}

/** Whole requests per minute, at least 1 (RPC and env input may be fractional or junk). */
function normaliseRpm(rpm: number): number {
  return Number.isFinite(rpm) ? Math.max(1, Math.floor(rpm)) : 1;
}

function minCap(rpm: number): number {
  return Math.max(1, Math.floor(rpm * MIN_CAP_SHARE));
}

/**
 * Requests per minute a priority may use. Subagents: the learned cap minus
 * the main-turn reserve. Main turns: the configured rpm. They ignore the
 * learned cap and the cooldown, so subagents always yield first; a 429 on
 * a main turn is still waited out by rate-limit-fetch.ts.
 */
export function priorityLimit(cap: number, priority: BudgetPriority, rpm = cap): number {
  if (priority === "main") return rpm;
  return Math.max(1, cap - Math.max(1, Math.ceil(cap * SUBAGENT_RESERVE)));
}

export class ModelBudgetBook {
  private buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private bucket(key: string, rawRpm: number, now: number): Bucket {
    const rpm = normaliseRpm(rawRpm);
    let b = this.buckets.get(key);
    if (!b) {
      b = { rpm, cap: rpm, stamps: [], cooldownUntil: 0, lastCapChange: now, lastCutAt: Number.NEGATIVE_INFINITY, throttled: 0, rateLimited: 0 };
      this.buckets.set(key, b);
    }
    if (b.rpm !== rpm) {
      // Config changed: keep what was learned, within the new range.
      b.rpm = rpm;
      b.cap = Math.min(Math.max(b.cap, minCap(rpm)), rpm);
    }
    const cutoff = now - WINDOW_MS;
    let drop = 0;
    while (drop < b.stamps.length && b.stamps[drop] <= cutoff) drop++;
    if (drop) b.stamps.splice(0, drop);
    const quietMinutes = Math.floor((now - b.lastCapChange) / WINDOW_MS);
    if (b.cap < b.rpm && quietMinutes > 0) {
      b.cap = Math.min(b.rpm, b.cap + quietMinutes * Math.max(1, Math.ceil(b.rpm * RECOVERY_SHARE)));
      b.lastCapChange += quietMinutes * WINDOW_MS;
    }
    return b;
  }

  /** Take a slot, or say how long to wait for one. */
  acquire(key: string, rpm: number, rawPriority: BudgetPriority): BudgetDecision {
    // RPC input: anything that isn't "main" is treated as a subagent.
    const priority: BudgetPriority = rawPriority === "main" ? "main" : "subagent";
    const now = this.now();
    const b = this.bucket(key, rpm, now);
    const limit = priorityLimit(b.cap, priority, b.rpm);
    const used = b.stamps.length;
    if (priority === "subagent" && b.cooldownUntil > now) {
      b.throttled++;
      return { ok: false, waitMs: Math.max(MIN_WAIT_MS, b.cooldownUntil - now), used, limit, cap: b.cap };
    }
    if (used < limit) {
      b.stamps.push(now);
      return { ok: true, waitMs: 0, used: used + 1, limit, cap: b.cap };
    }
    // Wait until enough stamps age out that used < limit.
    const freesAt = b.stamps[used - limit] + WINDOW_MS;
    b.throttled++;
    return { ok: false, waitMs: Math.max(MIN_WAIT_MS, freesAt - now), used, limit, cap: b.cap };
  }

  /** A request on this key got a per-minute 429 anyway. */
  report429(key: string, rpm: number, retryAfterMs?: number): void {
    const now = this.now();
    const b = this.bucket(key, rpm, now);
    b.rateLimited++;
    // Shrink at most once per CUT_INTERVAL_MS: the 429s of one burst arrive
    // together and must not each cut the cap. The rejected request is already stamped, so
    // the real cap is below `used`; `used` can also include requests sent
    // past the budget (or rejected ones), so cut by at least 20% as well.
    if (now - b.lastCutAt >= CUT_INTERVAL_MS) {
      b.lastCutAt = now;
      const learned = Math.max(minCap(b.rpm), Math.min(b.stamps.length - 1, Math.floor(b.cap * (1 - CAP_CUT_SHARE))));
      if (learned < b.cap) b.cap = learned;
    }
    b.lastCapChange = now;
    const hold = Math.min(MAX_COOLDOWN_MS, Math.max(1_000, retryAfterMs ?? DEFAULT_COOLDOWN_MS));
    b.cooldownUntil = Math.max(b.cooldownUntil, now + hold);
  }

  snapshot(): BudgetSnapshotEntry[] {
    const now = this.now();
    return [...this.buckets.keys()].map((key) => {
      const b = this.bucket(key, this.buckets.get(key)!.rpm, now);
      return {
        key,
        rpm: b.rpm,
        cap: b.cap,
        used: b.stamps.length,
        cooldownMs: Math.max(0, b.cooldownUntil - now),
        throttled: b.throttled,
        rateLimited: b.rateLimited,
      };
    });
  }
}

// ─── Which models have a budget ───

/**
 * Workers AI models that need the Workers Paid plan get 20/50 rpm; the
 * rest get 300. These patterns cover the frontier models Dodo uses.
 */
const FRONTIER_PATTERNS = [/^@cf\/moonshotai\/kimi-k2/, /^@cf\/zai-org\/glm-5/, /^@cf\/deepseek-ai\/deepseek-v4/];
const FRONTIER_RPM = 50;
const DEFAULT_WORKERS_AI_RPM = 300;

/**
 * Requests per minute allowed for `modelId`, or undefined for no budget.
 * Only Workers AI (`@cf/…`) models have one. `MODEL_RPM_LIMITS` (JSON
 * object, model id or "@cf/*" → rpm; 0 turns the budget off) overrides
 * the defaults.
 */
export function modelRpm(modelId: string, overridesJson?: string): number | undefined {
  if (!modelId.startsWith("@cf/")) return undefined;
  const overrides = parseOverrides(overridesJson);
  const value = overrides[modelId] ?? overrides["@cf/*"];
  if (value !== undefined) return value > 0 ? value : undefined;
  return FRONTIER_PATTERNS.some((p) => p.test(modelId)) ? FRONTIER_RPM : DEFAULT_WORKERS_AI_RPM;
}

const overrideCache = new Map<string, Record<string, number>>();
function parseOverrides(json?: string): Record<string, number> {
  if (!json) return {};
  const cached = overrideCache.get(json);
  if (cached) return cached;
  let out: Record<string, number> = {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [id, value] of Object.entries(parsed)) {
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[id] = value > 0 ? Math.max(1, Math.floor(value)) : 0;
        else log("warn", "MODEL_RPM_LIMITS entry ignored: rpm must be a number >= 0", { model: id });
      }
    }
  } catch {
    out = {};
    log("warn", "MODEL_RPM_LIMITS is not valid JSON; using default model budgets");
  }
  overrideCache.set(json, out);
  return out;
}

export function budgetKey(gateway: string, modelId: string): string {
  return `${gateway}:${modelId}`;
}
