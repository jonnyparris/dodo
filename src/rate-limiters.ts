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

import { RateLimiter } from "./rate-limit";

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
