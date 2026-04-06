import { beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env } from "../src/types";

// Mock modules that depend on unavailable packages in the test runtime
vi.mock("../src/executor", () => ({
  runSandboxedCode: vi.fn().mockResolvedValue({ logs: [], result: null }),
}));
vi.mock("../src/agentic", async () => await import("./helpers/agentic-mock"));
vi.mock("../src/notify", () => ({
  sendNotification: vi.fn(),
}));

import { RateLimiter } from "../src/rate-limit";

import worker from "../src/index";

const BASE_URL = "https://dodo.example";

async function fetchJson(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, init), env as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("RateLimiter unit tests", () => {
  // Warm up
  beforeAll(async () => {
    for (let i = 0; i < 5; i++) {
      try {
        await fetchJson("/health");
        break;
      } catch {
        await new Promise(r => setTimeout(r, 10));
      }
    }
  });

  it("allows the first N calls and denies N+1", () => {
    const limiter = new RateLimiter();
    const limit = 5;
    const windowMs = 60_000;

    for (let i = 0; i < limit; i++) {
      const result = limiter.check("test-key", limit, windowMs);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(limit - 1 - i);
    }

    // N+1 should be denied
    const denied = limiter.check("test-key", limit, windowMs);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfter).toBeGreaterThan(0);
  });

  it("allows calls again after window expires", () => {
    const limiter = new RateLimiter();
    const limit = 2;
    const windowMs = 50; // 50ms window

    // Exhaust the limit
    limiter.check("expire-key", limit, windowMs);
    limiter.check("expire-key", limit, windowMs);
    const denied = limiter.check("expire-key", limit, windowMs);
    expect(denied.allowed).toBe(false);

    // Wait for window to expire and try again
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

    // Create an entry with a very short window
    limiter.check("cleanup-key", 10, 1); // 1ms window

    // Wait for it to expire
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        limiter.cleanup();
        // After cleanup, a new check should start fresh (remaining = limit - 1)
        const result = limiter.check("cleanup-key", 10, 60_000);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(9); // fresh window
        resolve();
      }, 10);
    });
  });

  it("tracks separate keys independently", () => {
    const limiter = new RateLimiter();

    // Exhaust key A
    limiter.check("key-a", 1, 60_000);
    const deniedA = limiter.check("key-a", 1, 60_000);
    expect(deniedA.allowed).toBe(false);

    // Key B should still be allowed
    const resultB = limiter.check("key-b", 1, 60_000);
    expect(resultB.allowed).toBe(true);
  });
});

describe("Rate limiting integration", () => {
  // Warm up
  beforeAll(async () => {
    for (let i = 0; i < 5; i++) {
      try {
        await fetchJson("/health");
        break;
      } catch {
        await new Promise(r => setTimeout(r, 10));
      }
    }
  });

  it("share creation rate limit returns 429 with Retry-After header", async () => {
    // Create a session first (retry on DO invalidation)
    let sessionRes: Response | undefined;
    for (let i = 0; i < 5; i++) {
      sessionRes = await fetchJson("/session", { method: "POST" });
      if (sessionRes.status === 201) break;
    }
    expect(sessionRes!.status).toBe(201);
    const { id: sessionId } = (await sessionRes!.json()) as { id: string };

    // Create 20 shares (the limit)
    for (let i = 0; i < 20; i++) {
      const res = await fetchJson(`/session/${sessionId}/share`, {
        body: JSON.stringify({ permission: "readonly", label: `share-${i}` }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(res.status).toBe(201);
    }

    // The 21st should be rate limited
    const limited = await fetchJson(`/session/${sessionId}/share`, {
      body: JSON.stringify({ permission: "readonly", label: "one-too-many" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { error: string };
    expect(body.error).toContain("Too many requests");
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});
