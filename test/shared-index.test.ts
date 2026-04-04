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

function getSharedIndexStub(): DurableObjectStub {
  const testEnv = env as Env;
  return testEnv.SHARED_INDEX.get(testEnv.SHARED_INDEX.idFromName("global"));
}

async function addAllowlistDirect(hostname: string): Promise<Response> {
  return getSharedIndexStub().fetch("https://shared-index/allowlist", {
    body: JSON.stringify({ hostname }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

async function removeAllowlistDirect(hostname: string): Promise<Response> {
  return getSharedIndexStub().fetch(`https://shared-index/allowlist/${encodeURIComponent(hostname)}`, { method: "DELETE" });
}

describe("SharedIndex DO", () => {
  // Warm up: absorb any DO invalidation from module changes between test files
  beforeAll(async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetchJson("/health");
      if (res.status === 200) break;
    }
    // Make a request that touches SharedIndex DO to reset it
    try { await fetchJson("/api/allowlist"); } catch { /* absorb invalidation */ }
    try { await fetchJson("/api/allowlist"); } catch { /* retry */ }
  });
  // Use unique hostnames to avoid collisions with dodo.test.ts (which adds "example.com")
  const TEST_HOST_A = "si-test-alpha.example.org";
  const TEST_HOST_B = "si-test-bravo.example.org";

  it("host allowlist: add → listed → check true → remove → check false (via direct DO)", async () => {
    // Add host A via direct DO access
    const addA = await addAllowlistDirect(TEST_HOST_A);
    expect(addA.status).toBe(201);
    const addedA = (await addA.json()) as { hostname: string; createdAt: string };
    expect(addedA.hostname).toBe(TEST_HOST_A);
    expect(addedA.createdAt).toBeTruthy();

    // Add host B
    const addB = await addAllowlistDirect(TEST_HOST_B);
    expect(addB.status).toBe(201);

    // List via API — both should appear (GET is not admin-gated)
    const listRes = await fetchJson("/api/allowlist");
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { hosts: Array<{ hostname: string }> };
    expect(list.hosts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hostname: TEST_HOST_A }),
        expect.objectContaining({ hostname: TEST_HOST_B }),
      ]),
    );

    // Check — host A should be allowed
    const checkA = await fetchJson(`/api/allowlist/check?hostname=${encodeURIComponent(TEST_HOST_A)}`);
    expect(checkA.status).toBe(200);
    const checkABody = (await checkA.json()) as { allowed: boolean; hostname: string };
    expect(checkABody.allowed).toBe(true);
    expect(checkABody.hostname).toBe(TEST_HOST_A);

    // Remove host A via direct DO access
    const removeA = await removeAllowlistDirect(TEST_HOST_A);
    expect(removeA.status).toBe(200);
    const removeABody = (await removeA.json()) as { deleted: boolean; hostname: string };
    expect(removeABody.deleted).toBe(true);

    // Check — host A should no longer be allowed
    const checkA2 = await fetchJson(`/api/allowlist/check?hostname=${encodeURIComponent(TEST_HOST_A)}`);
    expect(checkA2.status).toBe(200);
    const checkA2Body = (await checkA2.json()) as { allowed: boolean };
    expect(checkA2Body.allowed).toBe(false);

    // Host B should still be allowed
    const checkB = await fetchJson(`/api/allowlist/check?hostname=${encodeURIComponent(TEST_HOST_B)}`);
    const checkBBody = (await checkB.json()) as { allowed: boolean };
    expect(checkBBody.allowed).toBe(true);

    // Cleanup: remove host B
    await removeAllowlistDirect(TEST_HOST_B);
  });

  it("allowlist write routes return 403 for non-admin", async () => {
    const postRes = await fetchJson("/api/allowlist", {
      body: JSON.stringify({ hostname: "admin-only.example.org" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(postRes.status).toBe(403);

    const deleteRes = await fetchJson("/api/allowlist/admin-only.example.org", { method: "DELETE" });
    expect(deleteRes.status).toBe(403);
  });

  it("host allowlist normalizes hostnames to lowercase", async () => {
    const host = "SI-TEST-UPPERCASE.Example.Org";
    const normalized = "si-test-uppercase.example.org";

    const addRes = await addAllowlistDirect(host);
    expect(addRes.status).toBe(201);
    const added = (await addRes.json()) as { hostname: string };
    expect(added.hostname).toBe(normalized);

    // Check with original casing — should still be found (server normalizes)
    const checkRes = await fetchJson(`/api/allowlist/check?hostname=${encodeURIComponent(host)}`);
    const checkBody = (await checkRes.json()) as { allowed: boolean };
    expect(checkBody.allowed).toBe(true);

    // Cleanup
    await removeAllowlistDirect(normalized);
  });

  it("models endpoint returns an array", async () => {
    const res = await fetchJson("/api/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: unknown[] };
    expect(Array.isArray(body.models)).toBe(true);
  });

  it("admin user list route returns 403 for non-admin", async () => {
    // dev@dodo.local != admin@test.local → 403
    const res = await fetchJson("/api/admin/users");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Admin");
  });

  it("admin add user route returns 403 for non-admin", async () => {
    const res = await fetchJson("/api/admin/users", {
      body: JSON.stringify({ email: "newuser@test.local" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(res.status).toBe(403);
  });

  it("admin delete user route returns 403 for non-admin", async () => {
    const res = await fetchJson("/api/admin/users/someone@test.local", { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  it("admin block user route returns 403 for non-admin", async () => {
    const res = await fetchJson("/api/admin/users/someone@test.local/block", { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("admin unblock user route returns 403 for non-admin", async () => {
    const res = await fetchJson("/api/admin/users/someone@test.local/block", { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  it("allowlist check returns false for unknown hostname", async () => {
    const res = await fetchJson("/api/allowlist/check?hostname=never-added-host.example.net");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { allowed: boolean };
    expect(body.allowed).toBe(false);
  });

  it("allowlist check returns false for empty hostname", async () => {
    const res = await fetchJson("/api/allowlist/check?hostname=");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { allowed: boolean };
    expect(body.allowed).toBe(false);
  });
});
