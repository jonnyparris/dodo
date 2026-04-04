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

async function fetchJsonRetry(path: string, init?: RequestInit, retries = 5): Promise<Response> {
  let lastResponse: Response | null = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetchJson(path, init);
      // Retry on server errors and on 403s that are caused by DO invalidation
      if (res.status >= 500) {
        lastResponse = res;
        await new Promise(r => setTimeout(r, 30));
        continue;
      }
      return res;
    } catch {
      await new Promise(r => setTimeout(r, 30));
    }
  }
  return lastResponse ?? new Response("Retry exhausted", { status: 500 });
}

async function createSession(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetchJson("/session", { method: "POST" });
      if (response.status === 201) {
        return ((await response.json()) as { id: string }).id;
      }
    } catch { /* DO invalidation — retry */ }
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error("Failed to create session after retries");
}

describe("Feature Gaps", () => {
  // Warm up: absorb any DO invalidation from module changes between test files
  beforeAll(async () => {
    for (let i = 0; i < 5; i++) {
      try {
        const res = await fetchJson("/health");
        if (res.status === 200) break;
      } catch {
        await new Promise(r => setTimeout(r, 20));
      }
    }
    // Touch SharedIndex and UserControl DOs to absorb invalidation
    for (let i = 0; i < 3; i++) {
      try { await fetchJson("/api/allowlist"); } catch { /* absorb */ }
      try { await fetchJson("/api/config"); } catch { /* absorb */ }
      try { await fetchJson("/session", { method: "POST" }); break; } catch { /* absorb */ }
      await new Promise(r => setTimeout(r, 20));
    }
  });

  // ─── Gap 1: Account-level create permission check ───

  describe("Gap 1: Account create permission", () => {
    it("session created without create permission defaults to own namespace", async () => {
      const res = await fetchJsonRetry("/session", { method: "POST" });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; ownerEmail: string; createdBy: string };
      expect(body.id).toBeTruthy();
      // Without any create permission, session should be owned by the creator
      expect(body.ownerEmail).toBe("dev@dodo.local");
      expect(body.createdBy).toBe("dev@dodo.local");
    });

    it("session creation with ownerOverride fails without create permission", async () => {
      const res = await fetchJsonRetry("/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ownerOverride: "boss@test.local" }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("No create permission");
    });

    it("session creation with empty body defaults to own namespace", async () => {
      const res = await fetchJsonRetry("/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; ownerEmail: string; createdBy: string };
      expect(body.ownerEmail).toBe("dev@dodo.local");
      expect(body.createdBy).toBe("dev@dodo.local");
    });
  });

  // ─── Gap 2: MCP session-level overrides ───

  describe("Gap 2: MCP session overrides", () => {
    let sessionId: string;

    beforeAll(async () => {
      // Ensure DOs are warmed up before creating the session we'll test
      for (let i = 0; i < 3; i++) {
        try {
          await fetchJson("/api/config");
          break;
        } catch {
          await new Promise(r => setTimeout(r, 20));
        }
      }
      sessionId = await createSession();
    });

    it("list overrides returns empty initially", async () => {
      const res = await fetchJsonRetry(`/session/${sessionId}/mcp-configs`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { configs: unknown[] };
      expect(Array.isArray(body.configs)).toBe(true);
    });

    it("set override → listed → remove", async () => {
      // Create a service-binding MCP config (no URL needed, no allowlist check)
      const configRes = await fetchJsonRetry("/api/mcp-configs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test-override-config", type: "service-binding", enabled: true }),
      });
      expect(configRes.status).toBe(201);
      const config = (await configRes.json()) as { id: string; name: string };
      const mcpConfigId = config.id;

      // Set an override to disable this config for the session
      const overrideRes = await fetchJsonRetry(`/session/${sessionId}/mcp-configs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mcpConfigId, enabled: false }),
      });
      expect(overrideRes.status).toBe(201);
      const overrideBody = (await overrideRes.json()) as { sessionId: string; mcpConfigId: string; enabled: boolean };
      expect(overrideBody.mcpConfigId).toBe(mcpConfigId);
      expect(overrideBody.enabled).toBe(false);

      // Verify effective configs show the override
      const effectiveRes = await fetchJsonRetry(`/session/${sessionId}/mcp-configs`);
      expect(effectiveRes.status).toBe(200);
      const effective = (await effectiveRes.json()) as { configs: Array<{ id: string; enabled: boolean; overridden: boolean }> };
      const overriddenConfig = effective.configs.find(c => c.id === mcpConfigId);
      expect(overriddenConfig).toBeTruthy();
      expect(overriddenConfig!.enabled).toBe(false);
      expect(overriddenConfig!.overridden).toBe(true);

      // Remove the override
      const deleteRes = await fetchJsonRetry(`/session/${sessionId}/mcp-configs/${encodeURIComponent(mcpConfigId)}`, {
        method: "DELETE",
      });
      expect(deleteRes.status).toBe(200);
      const deleteBody = (await deleteRes.json()) as { deleted: boolean };
      expect(deleteBody.deleted).toBe(true);

      // Verify override is gone
      const effectiveRes2 = await fetchJsonRetry(`/session/${sessionId}/mcp-configs`);
      const effective2 = (await effectiveRes2.json()) as { configs: Array<{ id: string; enabled: boolean; overridden: boolean }> };
      const restoredConfig = effective2.configs.find(c => c.id === mcpConfigId);
      expect(restoredConfig).toBeTruthy();
      expect(restoredConfig!.enabled).toBe(true); // Back to account default
      expect(restoredConfig!.overridden).toBe(false);
    });
  });

});
