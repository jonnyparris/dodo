/**
 * Pure unit tests for RateLimiter class.
 * Extracted from rate-limits.test.ts to avoid importing the main worker module.
 * See: https://github.com/cloudflare/workers-sdk/issues/13191
 */
import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/rate-limit";

describe("RateLimiter unit tests", () => {
  it("allows the first N calls and denies N+1", () => {
    const limiter = new RateLimiter();
    const limit = 5;
    const windowMs = 60_000;

    for (let i = 0; i < limit; i++) {
      const result = limiter.check("test-key", limit, windowMs);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(limit - 1 - i);
    }

    const denied = limiter.check("test-key", limit, windowMs);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfter).toBeGreaterThan(0);
  });

  it("allows calls again after window expires", () => {
    const limiter = new RateLimiter();
    const limit = 2;
    const windowMs = 50;

    limiter.check("expire-key", limit, windowMs);
    limiter.check("expire-key", limit, windowMs);
    const denied = limiter.check("expire-key", limit, windowMs);
    expect(denied.allowed).toBe(false);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const result = limiter.check("expire-key", limit, windowMs);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(limit - 1);
        resolve();
      }, 60);
    });
  });

  it("cleanup removes expired entries", () => {
    const limiter = new RateLimiter();

    limiter.check("cleanup-key", 10, 1); // 1ms window

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        limiter.cleanup();
        const result = limiter.check("cleanup-key", 10, 60_000);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(9);
        resolve();
      }, 10);
    });
  });

  it("tracks separate keys independently", () => {
    const limiter = new RateLimiter();

    limiter.check("key-a", 1, 60_000);
    const deniedA = limiter.check("key-a", 1, 60_000);
    expect(deniedA.allowed).toBe(false);

    const resultB = limiter.check("key-b", 1, 60_000);
    expect(resultB.allowed).toBe(true);
  });
});
