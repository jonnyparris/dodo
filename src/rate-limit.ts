/**
 * Simple in-memory sliding window rate limiter.
 *
 * Lives on the Worker isolate (not in a DO), so limits are
 * approximate / per-isolate. Good enough for abuse prevention.
 */
export class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  check(key: string, limit: number, windowMs: number): { allowed: boolean; remaining: number; retryAfter?: number } {
    const now = Date.now();
    const entry = this.windows.get(key);
    if (!entry || now > entry.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: limit - 1 };
    }
    if (entry.count >= limit) {
      return { allowed: false, remaining: 0, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    }
    entry.count++;
    return { allowed: true, remaining: limit - entry.count };
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.windows) {
      if (now > entry.resetAt) this.windows.delete(key);
    }
  }
}

/**
 * Module-level isolate-local rate limiters.
 *
 * Centralised so both the HTTP routes (src/index.ts) and the MCP tools
 * (src/mcp.ts) charge the same per-user budgets. Previously each MCP
 * tool that dispatched prompts had no limiter at all, so an MCP-token
 * holder could drive unbounded LLM spend — a /audit-stubs finding.
 *
 * These are per-isolate, not global. Workers that spawn multiple
 * isolates (high concurrency) effectively get N × budget. For our scale
 * this is fine — the budget is intended as abuse prevention, not a
 * billing-grade quota.
 */

export const promptLimiter = new RateLimiter();
export const shareLimiter = new RateLimiter();
export const messageLimiter = new RateLimiter();
export const errorLimiter = new RateLimiter();

let requestCount = 0;
export function maybeCleanupRateLimiters(): void {
  if (++requestCount % 100 === 0) {
    promptLimiter.cleanup();
    shareLimiter.cleanup();
    messageLimiter.cleanup();
    errorLimiter.cleanup();
  }
}
