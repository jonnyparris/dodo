import { beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env } from "../src/types";

// Mock modules that depend on unavailable packages in the test runtime
vi.mock("../src/executor", () => ({
  runSandboxedCode: vi.fn().mockResolvedValue({ logs: [], result: null }),
}));
vi.mock("../src/agentic", () => ({
  buildProvider: vi.fn().mockReturnValue({ chatModel: vi.fn().mockReturnValue({}) }),
  buildToolsForThink: vi.fn().mockReturnValue({}),
}));
vi.mock("../src/notify", () => ({
  sendNotification: vi.fn(),
}));

import worker from "../src/index";

const BASE_URL = "https://dodo.example";

async function fetchJson(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, init), env as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("Admin dashboard APIs", () => {
  // Warm up: absorb any DO invalidation from module changes between test files
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

  // Note: in dev mode (ALLOW_UNAUTHENTICATED_DEV=true), the identity is dev@dodo.local.
  // ADMIN_EMAIL is set to admin@test.local in vitest.config.ts, so dev@dodo.local is NOT admin.

  it("GET /api/admin/stats returns 403 for non-admin", async () => {
    const res = await fetchJson("/api/admin/stats");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Admin");
  });

  it("GET /api/admin/users/detailed returns 403 for non-admin", async () => {
    const res = await fetchJson("/api/admin/users/detailed");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Admin");
  });

  it("GET /api/admin/sessions returns 403 for non-admin", async () => {
    const res = await fetchJson("/api/admin/sessions");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Admin");
  });

  it("admin stats returns numeric values when accessed via SharedIndex directly", async () => {
    // Test the SharedIndex DO directly since we can't easily become admin in tests
    // Retry on DO invalidation (stub.fetch throws instead of returning 500)
    let res: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const testEnv = env as Env;
        const stub = testEnv.SHARED_INDEX.get(testEnv.SHARED_INDEX.idFromName("global"));
        res = await stub.fetch("https://shared-index/stats");
        break;
      } catch {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 10));
          continue;
        }
        throw new Error("Failed to fetch SharedIndex stats after retries");
      }
    }
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      userCount: number;
      sessionCount: number;
      totalShares: number;
      totalPermissions: number;
    };
    expect(typeof body.userCount).toBe("number");
    expect(typeof body.sessionCount).toBe("number");
    expect(typeof body.totalShares).toBe("number");
    expect(typeof body.totalPermissions).toBe("number");
    expect(body.userCount).toBeGreaterThanOrEqual(1); // admin is seeded
  });

  it("admin users/detailed returns user list via SharedIndex directly", async () => {
    let res: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const testEnv = env as Env;
        const stub = testEnv.SHARED_INDEX.get(testEnv.SHARED_INDEX.idFromName("global"));
        res = await stub.fetch("https://shared-index/users/detailed");
        break;
      } catch {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 10));
          continue;
        }
        throw new Error("Failed to fetch SharedIndex users/detailed after retries");
      }
    }
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      users: Array<{ email: string; displayName: string | null; role: string; lastSeenAt: string }>;
    };
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.users.length).toBeGreaterThanOrEqual(1);
    expect(body.users[0]).toHaveProperty("email");
    expect(body.users[0]).toHaveProperty("lastSeenAt");
  });

  it("session count increments when creating a session", async () => {
    // Get initial count (retry on DO invalidation)
    let before: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const testEnv = env as Env;
        const stub = testEnv.SHARED_INDEX.get(testEnv.SHARED_INDEX.idFromName("global"));
        before = await stub.fetch("https://shared-index/stats");
        break;
      } catch {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 10));
          continue;
        }
        throw new Error("Failed to fetch SharedIndex stats after retries");
      }
    }
    const beforeStats = (await before!.json()) as { sessionCount: number };

    // Create a session via the worker (retry on DO invalidation)
    let createRes: Response | undefined;
    for (let i = 0; i < 5; i++) {
      createRes = await fetchJson("/session", { method: "POST" });
      if (createRes.status === 201) break;
      await new Promise(r => setTimeout(r, 10));
    }
    expect(createRes!.status).toBe(201);

    // Check count increased (retry on DO invalidation)
    let after: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const testEnv = env as Env;
        const stub = testEnv.SHARED_INDEX.get(testEnv.SHARED_INDEX.idFromName("global"));
        after = await stub.fetch("https://shared-index/stats");
        break;
      } catch {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 10));
          continue;
        }
        throw new Error("Failed to fetch SharedIndex stats after retries");
      }
    }
    const afterStats = (await after!.json()) as { sessionCount: number };
    expect(afterStats.sessionCount).toBe(beforeStats.sessionCount + 1);
  });
});
