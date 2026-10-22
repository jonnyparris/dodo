// Wait out per-minute rate limits (HTTP 429) inside one model request.
//
// pi's harness retries a failed generation 3 times with 2s/4s/8s backoff:
// about 14s in total. Workers AI caps requests per model per minute
// (AiError 3021 "inference request per min rate reached"), so when
// subagents on the same model have used the minute's budget, all four
// attempts land inside the same window and the prompt fails (bench 10-21,
// session 68128c4b). The harness only sees the error text, not the
// response headers, so it cannot honour Retry-After.
//
// This wrapper sits under the OpenAI client as its `fetch`. On a 429 it
// waits (Retry-After when the gateway sends one, else 4s, 8s, 16s, ...)
// and sends the same request again, for up to `budgetMs` in total. If the
// limit is still there, it returns the last 429 and the harness retry
// takes over. The budget counts sleep time only; every wait is at least
// about 1s, so short Retry-After values can't become a tight loop. Other
// statuses pass through untouched: 5xx keep the
// harness's short backoff.
//
// Worst case: each of the harness's 4 attempts gets its own budget, so a
// rate limit that never clears fails the turn after about 4 x 60s + 14s
// of waiting (plus request time) instead of 14s. On Workers AI models the
// shared model budget (src/model-budget-fetch.ts) can add up to 30s of
// waiting per attempt before a send. The wait here is in memory: if the DO is evicted during
// it, pi-durable's recovery reruns the generation (the fiber heartbeat
// wakes it), so the cost is a restarted wait, not a stuck turn.

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";

export interface RateLimitFetchOptions {
  /** Longest total wait inside one request. Default 60s: one rate-limit window. */
  budgetMs?: number;
  /** First wait when the response has no Retry-After; doubles each time. Default 4s. */
  baseDelayMs?: number;
  /** For tests. */
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  /** Called before each wait (logging). */
  onWait?: (info: { attempt: number; delayMs: number; retryAfter: string | null }) => void;
}

const DEFAULT_BUDGET_MS = 60_000;
const DEFAULT_BASE_DELAY_MS = 4_000;
/** Floor for every wait, so `Retry-After: 0` can't turn into a tight resend loop. */
const MIN_DELAY_MS = 1_000;
/** Extra random wait on top of Retry-After, so parallel callers don't all resend at the same moment. */
const RETRY_AFTER_JITTER_MS = 1_000;

// A 429 that will not clear in a minute (quota, billing, subscription or
// daily limits): waiting only delays the error. pi-ai's own classifier
// decides (the "429" prefix makes everything else count as transient),
// plus Workers AI's daily free-allocation wording.
const DAILY_LIMIT = /daily|per day|\bRPD\b|\bTPD\b|allocation/i;
export function transient(body: string): boolean {
  if (DAILY_LIMIT.test(body)) return false;
  return isRetryableAssistantError({ stopReason: "error", errorMessage: `429 ${body}` } as AssistantMessage);
}

function abortError(): Error {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

export function abortableSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Milliseconds the server asked for, or undefined. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms) {
    const v = Number.parseFloat(ms);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  const ra = headers.get("retry-after");
  if (ra) {
    const seconds = Number.parseFloat(ra);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  return undefined;
}

function replayable(input: RequestInfo | URL, init?: RequestInit): boolean {
  // A Request object or a stream body can only be read once.
  if (typeof Request !== "undefined" && input instanceof Request) return false;
  const body = init?.body;
  return body == null || typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof URLSearchParams;
}

export function rateLimitFetch(base: typeof fetch = (...a) => fetch(...a), options: RateLimitFetchOptions = {}): typeof fetch {
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options.sleep ?? abortableSleep;

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    let response = await base(input, init);
    if (response.status !== 429 || !replayable(input, init)) return response;

    let waited = 0;
    for (let attempt = 1; ; attempt++) {
      if (response.headers.get("x-should-retry") === "false") return response;
      const body = await response.clone().text().catch(() => "");
      if (!transient(body)) return response;
      const asked = retryAfterMs(response.headers);
      const left = budgetMs - waited;
      // Jitter either way (after the floor), so parallel callers on one model don't retry in lockstep.
      let delayMs: number;
      if (asked === undefined) {
        const nominal = Math.max(MIN_DELAY_MS, baseDelayMs * 2 ** (attempt - 1));
        if (nominal > left) return response;
        delayMs = nominal * (1 - Math.random() * 0.25);
      } else {
        const floor = Math.max(MIN_DELAY_MS, asked);
        if (floor > left) return response;
        delayMs = Math.min(floor + Math.random() * RETRY_AFTER_JITTER_MS, left);
      }
      options.onWait?.({ attempt, delayMs, retryAfter: response.headers.get("retry-after") });
      await response.body?.cancel().catch(() => {});
      await sleep(delayMs, init?.signal);
      waited += delayMs;
      response = await base(input, init);
      if (response.status !== 429) return response;
    }
  }) as typeof fetch;
}
