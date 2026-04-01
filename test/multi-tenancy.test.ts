import { beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env } from "../src/types";

// Mock modules that depend on unavailable packages in the test runtime
const { streamAgenticChatMock } = vi.hoisted(() => ({
  streamAgenticChatMock: vi.fn(),
}));

vi.mock("../src/executor", () => ({
  runSandboxedCode: vi.fn().mockResolvedValue({ logs: [], result: null }),
}));
vi.mock("../src/agentic", () => ({
  runAgenticChat: vi.fn().mockResolvedValue({ gateway: "opencode", model: "test", steps: 0, text: "", toolCalls: [] }),
  streamAgenticChat: streamAgenticChatMock.mockImplementation(
    async (input: { messages: Array<{ content: string; role: string }>; onTextDelta?: (d: string) => void }) => {
      const lastMessage = input.messages.at(-1)?.content ?? "";
      const text = `mt:${lastMessage}`;
      if (input.onTextDelta) {
        for (const ch of text) input.onTextDelta(ch);
      }
      return { gateway: "opencode", model: "test", steps: 1, text, tokenInput: 10, tokenOutput: 5, toolCalls: [] };
    },
  ),
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

describe("Multi-tenancy integration", () => {
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

  // ─── 1. Session Ownership ───

  it("session ownership: created session is attributed to dev@dodo.local", async () => {
    const sessionId = await createSession();

    // Session list should include it with ownerEmail
    const listRes = await fetchJson("/session");
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { sessions: Array<{ id: string; ownerEmail: string; createdBy: string }> };
    const session = list.sessions.find((s) => s.id === sessionId);
    expect(session).toBeDefined();
    expect(session!.ownerEmail).toBe("dev@dodo.local");
    expect(session!.createdBy).toBe("dev@dodo.local");
  });

  it("session ownership: identity endpoint confirms dev@dodo.local is not admin", async () => {
    const res = await fetchJson("/api/identity");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string; isAdmin: boolean };
    expect(body.email).toBe("dev@dodo.local");
    expect(body.isAdmin).toBe(false);
  });

  // ─── 2. Message Attribution ───

  it("message attribution: messages record authorEmail from the user", async () => {
    const sessionId = await createSession();

    // Send a message
    const msgRes = await fetchJson(`/session/${sessionId}/message`, {
      body: JSON.stringify({ content: "mt-attribution-check" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(msgRes.status).toBe(200);

    // Fetch messages and check authorEmail
    const msgsRes = await fetchJson(`/session/${sessionId}/messages`);
    expect(msgsRes.status).toBe(200);
    const { messages } = (await msgsRes.json()) as {
      messages: Array<{ role: string; content: string; authorEmail?: string | null }>;
    };
    expect(messages.length).toBeGreaterThanOrEqual(2);

    // User message should have authorEmail set
    const userMsg = messages.find((m) => m.role === "user" && m.content === "mt-attribution-check");
    expect(userMsg).toBeDefined();
    expect(userMsg!.authorEmail).toBe("dev@dodo.local");

    // Assistant message should not have a user authorEmail
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.authorEmail).not.toBe("dev@dodo.local");
  });

  // ─── 3. Secrets Round-Trip ───

  it("secrets round-trip: init passkey → set secret → verify exists → delete → verify gone", async () => {
    // Check passkey status
    const statusRes = await fetchJson("/api/passkey/status");
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as { initialized: boolean };

    // Initialize passkey if needed
    if (!statusBody.initialized) {
      const initRes = await fetchJson("/api/passkey/init", {
        body: JSON.stringify({ passkey: "mt-test-passkey-9876" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(initRes.status).toBe(200);
      const initBody = (await initRes.json()) as { initialized: boolean };
      expect(initBody.initialized).toBe(true);
    }

    // Use a unique secret key to avoid collisions
    const secretKey = "MT_INTEGRATION_SECRET";

    // Set secret
    const setRes = await fetchJson(`/api/secrets/${secretKey}`, {
      body: JSON.stringify({ value: "mt-secret-value-42" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    expect(setRes.status).toBe(200);
    const setBody = (await setRes.json()) as { key: string; updated: boolean };
    expect(setBody.key).toBe(secretKey);
    expect(setBody.updated).toBe(true);

    // Verify it exists
    const testRes = await fetchJson(`/api/secrets/${secretKey}/test`);
    expect(testRes.status).toBe(200);
    const testBody = (await testRes.json()) as { key: string; exists: boolean };
    expect(testBody.exists).toBe(true);

    // List secrets — should contain our key
    const listRes = await fetchJson("/api/secrets");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { keys: string[] };
    expect(listBody.keys).toContain(secretKey);

    // Delete secret
    const delRes = await fetchJson(`/api/secrets/${secretKey}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { deleted: boolean; key: string };
    expect(delBody.deleted).toBe(true);

    // Verify it's gone
    const testAfterRes = await fetchJson(`/api/secrets/${secretKey}/test`);
    expect(testAfterRes.status).toBe(200);
    const testAfterBody = (await testAfterRes.json()) as { exists: boolean };
    expect(testAfterBody.exists).toBe(false);
  });

  // ─── 4. Config Isolation ───

  it("config isolation: user config changes persist across requests", async () => {
    // Set a unique model name
    const uniqueModel = "mt-isolation-model-" + Date.now();
    const updateRes = await fetchJson("/api/config", {
      body: JSON.stringify({ model: uniqueModel, activeGateway: "ai-gateway" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as { model: string; activeGateway: string };
    expect(updated.model).toBe(uniqueModel);
    expect(updated.activeGateway).toBe("ai-gateway");

    // Read back in a separate request — should persist
    const readRes = await fetchJson("/api/config");
    expect(readRes.status).toBe(200);
    const readBack = (await readRes.json()) as { model: string; activeGateway: string };
    expect(readBack.model).toBe(uniqueModel);
    expect(readBack.activeGateway).toBe("ai-gateway");

    // Restore defaults so we don't break other tests
    await fetchJson("/api/config", {
      body: JSON.stringify({ activeGateway: "opencode", model: "claude-test" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
  });

  // ─── 5. Owner Email Propagation ───

  it("owner email propagation: session state includes ownerEmail after first interaction", async () => {
    const sessionId = await createSession();

    // Send a message to initialize the CodingAgent DO metadata (sessionId + ownerEmail)
    const msgRes = await fetchJson(`/session/${sessionId}/message`, {
      body: JSON.stringify({ content: "mt-owner-propagation-check" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(msgRes.status).toBe(200);

    // Fetch session state (GET /session/:id) — ownerEmail should be propagated
    const stateRes = await fetchJson(`/session/${sessionId}`);
    expect(stateRes.status).toBe(200);
    const state = (await stateRes.json()) as {
      sessionId: string;
      ownerEmail?: string;
      status: string;
      totalTokenInput: number;
      totalTokenOutput: number;
    };
    expect(state.sessionId).toBe(sessionId);
    expect(state.ownerEmail).toBe("dev@dodo.local");
    expect(state.status).toBe("idle");
    expect(typeof state.totalTokenInput).toBe("number");
    expect(typeof state.totalTokenOutput).toBe("number");
  });

  // ─── 6. Admin Route Protection ───

  it("admin route protection: GET /api/admin/users returns 403 for non-admin", async () => {
    const res = await fetchJson("/api/admin/users");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Admin");
  });

  it("admin route protection: POST /api/admin/users returns 403 for non-admin", async () => {
    const res = await fetchJson("/api/admin/users", {
      body: JSON.stringify({ email: "mt-test-user@example.com" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(res.status).toBe(403);
  });

  it("admin route protection: DELETE /api/admin/users/:email returns 403 for non-admin", async () => {
    const res = await fetchJson("/api/admin/users/mt-test-user@example.com", { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  it("admin route protection: POST block returns 403 for non-admin", async () => {
    const res = await fetchJson("/api/admin/users/mt-test-user@example.com/block", { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("admin route protection: DELETE block returns 403 for non-admin", async () => {
    const res = await fetchJson("/api/admin/users/mt-test-user@example.com/block", { method: "DELETE" });
    expect(res.status).toBe(403);
  });
});
