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

import worker from "../src/index";

const BASE_URL = "https://dodo.example";

async function fetchJson(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, init), env as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function getSharedIndexStub(): DurableObjectStub {
  const testEnv = env as Env;
  return testEnv.SHARED_INDEX.get(testEnv.SHARED_INDEX.idFromName("global"));
}

async function fetchSharedIndex(path: string, init?: RequestInit): Promise<Response> {
  let res: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const stub = getSharedIndexStub();
      res = await stub.fetch(`https://shared-index${path}`, init);
      break;
    } catch {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }
      throw new Error(`Failed to fetch SharedIndex ${path} after retries`);
    }
  }
  return res!;
}

describe("Browser automation gating (Phase 6)", () => {
  const TEST_USER = "browser-test@example.com";

  // Warm up and create test user
  beforeAll(async () => {
    for (let i = 0; i < 5; i++) {
      try {
        await fetchJson("/health");
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    // Ensure test user exists in SharedIndex
    await fetchSharedIndex("/users", {
      body: JSON.stringify({ email: TEST_USER, displayName: "Browser Test", role: "user" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  });

  it("browser_enabled defaults to false for new users", async () => {
    const res = await fetchSharedIndex(`/users/${encodeURIComponent(TEST_USER)}/browser`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { browserEnabled: boolean; email: string };
    expect(body.browserEnabled).toBe(false);
    expect(body.email).toBe(TEST_USER);
  });

  it("enable browser via SharedIndex endpoint", async () => {
    const res = await fetchSharedIndex(`/users/${encodeURIComponent(TEST_USER)}/browser`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { browserEnabled: boolean; email: string };
    expect(body.browserEnabled).toBe(true);
    expect(body.email).toBe(TEST_USER);
  });

  it("browser flag persists after enable", async () => {
    const res = await fetchSharedIndex(`/users/${encodeURIComponent(TEST_USER)}/browser`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { browserEnabled: boolean };
    expect(body.browserEnabled).toBe(true);
  });

  it("disable browser via SharedIndex endpoint", async () => {
    const res = await fetchSharedIndex(`/users/${encodeURIComponent(TEST_USER)}/browser`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { browserEnabled: boolean; email: string };
    expect(body.browserEnabled).toBe(false);
    expect(body.email).toBe(TEST_USER);
  });

  it("browser flag persists after disable", async () => {
    const res = await fetchSharedIndex(`/users/${encodeURIComponent(TEST_USER)}/browser`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { browserEnabled: boolean };
    expect(body.browserEnabled).toBe(false);
  });

  it("browser status returns 404 for unknown user", async () => {
    const res = await fetchSharedIndex("/users/nonexistent@example.com/browser");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("User not found");
  });

  it("browserEnabled appears in user list", async () => {
    // Enable browser first
    await fetchSharedIndex(`/users/${encodeURIComponent(TEST_USER)}/browser`, { method: "POST" });

    const res = await fetchSharedIndex("/users");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: Array<{ email: string; browserEnabled: boolean }> };
    const user = body.users.find((u) => u.email === TEST_USER);
    expect(user).toBeDefined();
    expect(user!.browserEnabled).toBe(true);

    // Cleanup
    await fetchSharedIndex(`/users/${encodeURIComponent(TEST_USER)}/browser`, { method: "DELETE" });
  });

  // ─── Admin route guard tests ───

  it("POST /api/admin/users/:email/browser returns 403 for non-admin", async () => {
    // dev@dodo.local is not admin (admin is admin@test.local)
    const res = await fetchJson(`/api/admin/users/${encodeURIComponent(TEST_USER)}/browser`, { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Admin");
  });

  it("DELETE /api/admin/users/:email/browser returns 403 for non-admin", async () => {
    const res = await fetchJson(`/api/admin/users/${encodeURIComponent(TEST_USER)}/browser`, { method: "DELETE" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Admin");
  });
});

// ─── Per-session browser toggle ───

describe("Per-session browser toggle", () => {
  async function createSession(): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetchJson("/session", { method: "POST" });
      if (response.status === 201) {
        return ((await response.json()) as { id: string }).id;
      }
      if (response.status === 500 && attempt < 2) {
        await new Promise(r => setTimeout(r, 10));
        continue;
      }
      throw new Error(`Failed to create session: ${response.status}`);
    }
    throw new Error("Failed to create session after retries");
  }

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

  it("browser defaults to disabled for new sessions", async () => {
    const sessionId = await createSession();
    const res = await fetchJson(`/session/${sessionId}/browser`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { browserEnabled: boolean; sessionId: string };
    expect(body.browserEnabled).toBe(false);
    expect(body.sessionId).toBe(sessionId);
  });

  it("enable browser via PUT /session/:id/browser", async () => {
    const sessionId = await createSession();

    const enableRes = await fetchJson(`/session/${sessionId}/browser`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(enableRes.status).toBe(200);
    const enableBody = (await enableRes.json()) as { browserEnabled: boolean };
    expect(enableBody.browserEnabled).toBe(true);

    // Verify it persists
    const getRes = await fetchJson(`/session/${sessionId}/browser`);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { browserEnabled: boolean };
    expect(getBody.browserEnabled).toBe(true);
  });

  it("disable browser via PUT /session/:id/browser", async () => {
    const sessionId = await createSession();

    // Enable first
    await fetchJson(`/session/${sessionId}/browser`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });

    // Disable
    const disableRes = await fetchJson(`/session/${sessionId}/browser`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disableRes.status).toBe(200);
    const body = (await disableRes.json()) as { browserEnabled: boolean };
    expect(body.browserEnabled).toBe(false);
  });
});
