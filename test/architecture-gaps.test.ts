import { beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import type { Env } from "../src/types";

// Mock modules that depend on unavailable packages in the test runtime
vi.mock("../src/executor", () => ({
  runSandboxedCode: vi.fn().mockResolvedValue({ logs: [], result: null }),
}));
vi.mock("../src/agentic", () => ({
  runAgenticChat: vi.fn().mockResolvedValue({ gateway: "opencode", model: "test", steps: 0, text: "", toolCalls: [] }),
  streamAgenticChat: vi.fn().mockResolvedValue({ gateway: "opencode", model: "test", steps: 0, text: "", tokenInput: 0, tokenOutput: 0, toolCalls: [] }),
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

describe("Architecture gaps", () => {
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

  // ─── Gap 1: AppControl deprecation — CodingAgent throws without owner_email ───

  it("CodingAgent throws when owner_email is missing (no AppControl fallback)", async () => {
    const testEnv = env as Env;
    const sessionId = crypto.randomUUID();

    // Get a CodingAgent DO directly, without going through the router
    // (the router always sets x-owner-email, so we bypass it)
    const { getAgentByName } = await import("agents");
    const agent = await getAgentByName(testEnv.CODING_AGENT as never, sessionId);

    // Send a request without x-owner-email header — the session has no owner_email set
    // The /snapshot endpoint triggers readAppConfig() internally via handleImportSnapshot
    // But the simplest test: just call GET / (readSessionDetails doesn't throw) then
    // try to trigger handleMessage which calls syncSessionIndex

    // First, set up the session metadata with session_id but NOT owner_email
    const initRes = await agent.fetch(new Request("https://coding-agent/file?path=/test.txt", {
      method: "PUT",
      headers: {
        "x-dodo-session-id": sessionId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content: "test" }),
    }));
    // File write should succeed (doesn't need owner_email for config/sync)
    expect(initRes.status).toBe(200);

    // Now try to delete the session — this calls syncSessionIndex which needs owner_email
    const deleteRes = await agent.fetch(new Request("https://coding-agent/", {
      method: "DELETE",
    }));
    // Should return 400 with a clear error about missing owner_email
    expect(deleteRes.status).toBe(400);
    const body = (await deleteRes.json()) as { error: string };
    expect(body.error).toContain("owner_email");
    expect(body.error).toContain("migration");
  });

  // ─── Gap 2: Server key rotation endpoint ───

  it("server key rotation: init passkey → set secret → rotate → verify secret still decryptable", async () => {
    // The passkey envelope may already be initialized by another test file
    // (user-control.test.ts or multi-tenancy.test.ts) with one of these passphrases.
    // Since isolatedStorage: false, state persists across test files.
    const KNOWN_PASSKEYS = ["test-passkey-4321", "mt-test-passkey-9876", "test-passkey-1234", "onboarding-test-passkey", "arch-gap-passkey-1234"];

    // Retry passkey status (absorb DO invalidation)
    let statusBody = { initialized: false };
    for (let attempt = 0; attempt < 3; attempt++) {
      const statusRes = await fetchJson("/api/passkey/status");
      if (statusRes.ok) {
        statusBody = (await statusRes.json()) as { initialized: boolean };
        break;
      }
      await new Promise(r => setTimeout(r, 10));
    }

    if (!statusBody.initialized) {
      const initRes = await fetchJson("/api/passkey/init", {
        body: JSON.stringify({ passkey: KNOWN_PASSKEYS[2] }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(initRes.status).toBe(200);
    }

    // Set a secret
    const secretKey = "ARCH_GAP_ROTATION_SECRET";
    const setRes = await fetchJson(`/api/secrets/${secretKey}`, {
      body: JSON.stringify({ value: "rotation-test-value-xyz" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    expect(setRes.status).toBe(200);

    // Verify the secret exists
    const testRes = await fetchJson(`/api/secrets/${secretKey}/test`);
    const testBody = (await testRes.json()) as { exists: boolean };
    expect(testBody.exists).toBe(true);

    // Try each known passkey until one works for rotation
    let rotated = false;
    for (const passkey of KNOWN_PASSKEYS) {
      const rotateRes = await fetchJson("/api/passkey/rotate-server-key", {
        body: JSON.stringify({ passkey }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (rotateRes.status === 200) {
        const rotateBody = (await rotateRes.json()) as { rotated: boolean };
        expect(rotateBody.rotated).toBe(true);
        rotated = true;
        break;
      }
    }
    expect(rotated).toBe(true);

    // After rotation, the secret should still be accessible (same master key)
    const verifyRes = await fetchJson(`/api/secrets/${secretKey}/test`);
    const verifyBody = (await verifyRes.json()) as { exists: boolean };
    expect(verifyBody.exists).toBe(true);

    // Clean up
    await fetchJson(`/api/secrets/${secretKey}`, { method: "DELETE" });
  });

  it("server key rotation: rejects with invalid passkey", async () => {
    const rotateRes = await fetchJson("/api/passkey/rotate-server-key", {
      body: JSON.stringify({ passkey: "completely-wrong-passkey" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    // Should fail because wrong passkey can't unwrap the DEK
    expect(rotateRes.status).toBe(400);
    const body = (await rotateRes.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  // ─── Gap 3: Admin cross-user session listing ───

  it("admin sessions endpoint returns sessions with ownerEmail (via SharedIndex direct access)", async () => {
    // Create a session so there's at least one
    const sessionId = await createSession();

    // Since dev@dodo.local is not admin, we can't test the admin endpoint directly.
    // Instead, verify the underlying mechanism: SharedIndex returns users,
    // and each user's UserControl has sessions.

    const testEnv = env as Env;

    // 1. Get users from SharedIndex
    let usersRes: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const stub = testEnv.SHARED_INDEX.get(testEnv.SHARED_INDEX.idFromName("global"));
        usersRes = await stub.fetch("https://shared-index/users");
        break;
      } catch {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 10));
          continue;
        }
        throw new Error("Failed to fetch users from SharedIndex");
      }
    }
    expect(usersRes!.status).toBe(200);
    const { users } = (await usersRes!.json()) as { users: Array<{ email: string }> };
    expect(users.length).toBeGreaterThanOrEqual(1);

    // 2. For the dev user, query their UserControl for sessions
    const devUser = users.find((u) => u.email === "dev@dodo.local") ?? users.find((u) => u.email === "admin@test.local");
    // The dev user might not be in the user registry (only admin@test.local is seeded)
    // But sessions are created via the router which uses dev@dodo.local
    // Let's query the dev user's UserControl directly
    const ucStub = testEnv.USER_CONTROL.get(testEnv.USER_CONTROL.idFromName("dev@dodo.local"));
    const sessionsRes = await ucStub.fetch("https://user-control/sessions");
    expect(sessionsRes.status).toBe(200);
    const { sessions } = (await sessionsRes.json()) as { sessions: Array<{ id: string; ownerEmail: string }> };

    // The session we just created should be present with ownerEmail
    const found = sessions.find((s) => s.id === sessionId);
    expect(found).toBeDefined();
    expect(found!.ownerEmail).toBe("dev@dodo.local");
  });
});
