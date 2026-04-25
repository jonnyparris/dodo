import { beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env, SeedRecord } from "../src/types";

// Stub modules that depend on packages not available in the worker test
// runtime — same pattern used by every other top-level test file.
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

function sharedIndex(): DurableObjectStub {
  const e = env as Env;
  return e.SHARED_INDEX.get(e.SHARED_INDEX.idFromName("global"));
}

function userControl(email: string): DurableObjectStub {
  const e = env as Env;
  return e.USER_CONTROL.get(e.USER_CONTROL.idFromName(email));
}

describe("Seed cache — SharedIndex registry", () => {
  beforeAll(async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetchJson("/health");
      if (res.status === 200) break;
    }
  });

  it("POST /seeds creates a row and returns it; second POST is idempotent", async () => {
    const body = {
      repoId: "dodo",
      baseBranch: "test-main-1",
      sessionId: "seed-session-1",
      ownerEmail: "admin@test.local",
      repoUrl: "https://github.com/jonnyparris/dodo",
      repoDir: "/dodo",
    };

    const first = await sharedIndex().fetch("https://shared-index/seeds", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(first.status).toBe(201);
    const firstPayload = (await first.json()) as { seed: SeedRecord; created: boolean };
    expect(firstPayload.created).toBe(true);
    expect(firstPayload.seed.sessionId).toBe("seed-session-1");

    // Idempotent insert: same key returns the existing row, doesn't
    // overwrite, doesn't error.
    const second = await sharedIndex().fetch("https://shared-index/seeds", {
      body: JSON.stringify({ ...body, sessionId: "would-be-new-id" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(second.status).toBe(200);
    const secondPayload = (await second.json()) as { seed: SeedRecord; created: boolean };
    expect(secondPayload.created).toBe(false);
    expect(secondPayload.seed.sessionId).toBe("seed-session-1");
  });

  it("GET /seeds/:repoId/:branch returns the seed; DELETE removes it", async () => {
    const body = {
      repoId: "dodo",
      baseBranch: "test-main-2",
      sessionId: "seed-session-2",
      ownerEmail: "admin@test.local",
      repoUrl: "https://github.com/jonnyparris/dodo",
      repoDir: "/dodo",
    };
    await sharedIndex().fetch("https://shared-index/seeds", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    const get = await sharedIndex().fetch("https://shared-index/seeds/dodo/test-main-2");
    expect(get.status).toBe(200);
    const { seed } = (await get.json()) as { seed: SeedRecord };
    expect(seed.sessionId).toBe("seed-session-2");
    expect(seed.repoUrl).toBe("https://github.com/jonnyparris/dodo");

    const del = await sharedIndex().fetch("https://shared-index/seeds/dodo/test-main-2", { method: "DELETE" });
    expect(del.status).toBe(200);

    const after = await sharedIndex().fetch("https://shared-index/seeds/dodo/test-main-2");
    expect(after.status).toBe(404);
  });

  it("POST /seeds/:repoId/:branch/touch updates updated_at", async () => {
    const body = {
      repoId: "dodo",
      baseBranch: "test-main-3",
      sessionId: "seed-session-3",
      ownerEmail: "admin@test.local",
      repoUrl: "https://github.com/jonnyparris/dodo",
      repoDir: "/dodo",
    };
    const created = await sharedIndex().fetch("https://shared-index/seeds", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const { seed: original } = (await created.json()) as { seed: SeedRecord };

    // Wait long enough that the integer-second timestamp can advance.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const touch = await sharedIndex().fetch("https://shared-index/seeds/dodo/test-main-3/touch", { method: "POST" });
    expect(touch.status).toBe(200);
    const { seed: touched } = (await touch.json()) as { seed: SeedRecord };
    expect(Date.parse(touched.updatedAt)).toBeGreaterThanOrEqual(Date.parse(original.updatedAt));
  });
});

describe("Seed cache — admin endpoints gated by adminGuard", () => {
  it("GET /api/admin/seeds returns 403 for non-admin", async () => {
    // Tests run as dev@dodo.local which is not the admin email.
    const res = await fetchJson("/api/admin/seeds");
    expect(res.status).toBe(403);
  });

  it("DELETE /api/admin/seeds/:repoId/:branch returns 403 for non-admin", async () => {
    const res = await fetchJson("/api/admin/seeds/dodo/main", { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  it("POST /api/admin/seeds/:repoId/:branch/refresh returns 403 for non-admin", async () => {
    const res = await fetchJson("/api/admin/seeds/dodo/main/refresh", { method: "POST" });
    expect(res.status).toBe(403);
  });
});

describe("Seed cache — sessions table 'seed' kind hides from list and skips idle sweep", () => {
  it("seed sessions are excluded from /sessions but visible in /seed-sessions", async () => {
    const owner = "seed-test-user-1@dodo.test";

    // Register one normal user session and one seed session under the
    // same owner. The user session should be visible in /sessions, the
    // seed should not.
    await userControl(owner).fetch("https://user-control/sessions", {
      body: JSON.stringify({ id: "user-session-aaa", title: "User work", ownerEmail: owner, createdBy: owner }),
      headers: { "content-type": "application/json", "x-owner-email": owner },
      method: "POST",
    });
    await userControl(owner).fetch("https://user-control/sessions", {
      body: JSON.stringify({ id: "seed-session-aaa", title: "[Seed:dodo@main]", ownerEmail: owner, createdBy: owner, kind: "seed" }),
      headers: { "content-type": "application/json", "x-owner-email": owner },
      method: "POST",
    });

    const list = await userControl(owner).fetch("https://user-control/sessions", {
      headers: { "x-owner-email": owner },
    });
    const { sessions } = (await list.json()) as { sessions: Array<{ id: string; kind?: string }> };
    const ids = sessions.map((s) => s.id);
    expect(ids).toContain("user-session-aaa");
    expect(ids).not.toContain("seed-session-aaa");

    const seedList = await userControl(owner).fetch("https://user-control/seed-sessions", {
      headers: { "x-owner-email": owner },
    });
    const { sessions: seedSessions } = (await seedList.json()) as { sessions: Array<{ id: string; kind: string }> };
    const seedIds = seedSessions.map((s) => s.id);
    expect(seedIds).toContain("seed-session-aaa");
    expect(seedSessions.every((s) => s.kind === "seed")).toBe(true);
  });

  it("?includeSeeds=1 includes seed sessions in /sessions", async () => {
    const owner = "seed-test-user-2@dodo.test";
    await userControl(owner).fetch("https://user-control/sessions", {
      body: JSON.stringify({ id: "seed-bbb", title: "[Seed:dodo@main]", ownerEmail: owner, createdBy: owner, kind: "seed" }),
      headers: { "content-type": "application/json", "x-owner-email": owner },
      method: "POST",
    });

    const list = await userControl(owner).fetch("https://user-control/sessions?includeSeeds=1", {
      headers: { "x-owner-email": owner },
    });
    const { sessions } = (await list.json()) as { sessions: Array<{ id: string; kind: string }> };
    const seed = sessions.find((s) => s.id === "seed-bbb");
    expect(seed).toBeDefined();
    expect(seed?.kind).toBe("seed");
  });
});
