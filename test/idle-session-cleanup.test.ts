import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env } from "../src/types";
import { resetMockAgentic } from "./helpers/agentic-mock";

vi.mock("@cloudflare/codemode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cloudflare/codemode")>();
  return {
    ...actual,
    DynamicWorkerExecutor: vi.fn(function () {
      return { execute: vi.fn().mockResolvedValue({ logs: [], result: null }) };
    }) as unknown as typeof import("@cloudflare/codemode").DynamicWorkerExecutor,
  };
});
vi.mock("../src/agentic", async () => await import("./helpers/agentic-mock"));
vi.mock("../src/pi/models", async () => await import("./helpers/pi-models-mock"));
vi.mock("../src/notify", () => ({ dispatchNotification: vi.fn(), sendRunNotification: vi.fn() }));

import worker from "../src/index";

const BASE_URL = "https://dodo.example";

async function fetchJson(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, init), env as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function createSession(): Promise<string> {
  const response = await fetchJson("/session", { method: "POST" });
  if (response.status !== 201) throw new Error(`Failed to create session: ${response.status}`);
  return ((await response.json()) as { id: string }).id;
}

function getUserControlStub(): DurableObjectStub<import("../src/user-control").UserControl> {
  const typedEnv = env as Env;
  return typedEnv.USER_CONTROL.get(typedEnv.USER_CONTROL.idFromName("dev@dodo.local"));
}

async function resetUserState(): Promise<void> {
  const stub = getUserControlStub();
  await runInDurableObject(stub, async (_, state) => {
    state.storage.sql.exec("DELETE FROM scheduled_sessions");
    state.storage.sql.exec("DELETE FROM sessions");
    await state.storage.deleteAlarm();
  });
}

/** Backdate a session's updated_at so it looks "idle > 10 minutes". */
async function backdateSession(sessionId: string, secondsAgo: number): Promise<void> {
  const stub = getUserControlStub();
  await runInDurableObject(stub, async (_, state) => {
    state.storage.sql.exec(
      "UPDATE sessions SET updated_at = ? WHERE id = ?",
      Math.floor(Date.now() / 1000) - secondsAgo,
      sessionId,
    );
  });
}

async function getSessionStatus(sessionId: string): Promise<string | null> {
  const stub = getUserControlStub();
  const result = await runInDurableObject<import("../src/user-control").UserControl, string | null>(
    stub,
    async (_, state) => {
      const row = state.storage.sql.exec(
        "SELECT status FROM sessions WHERE id = ?",
        sessionId,
      ).toArray()[0] as { status?: string } | undefined;
      return row?.status ?? null;
    },
  );
  return result;
}

beforeEach(async () => {
  resetMockAgentic();
  await resetUserState();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Idle session auto-cleanup", () => {
  it("soft-deletes sessions idle > 10min with no prompts", async () => {
    const sessionId = await createSession();
    expect(await getSessionStatus(sessionId)).toBe("idle");

    // Backdate to 11 minutes ago (past the 10-min TTL)
    await backdateSession(sessionId, 11 * 60);

    // Park the alarm in the far future so miniflare doesn't auto-fire
    // it before our explicit runDurableObjectAlarm() drives it.
    const stub = getUserControlStub();
    await runInDurableObject(stub, async (_, state) => {
      state.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    });

    const alarmRan = await runDurableObjectAlarm(stub);
    expect(alarmRan).toBe(true);

    expect(await getSessionStatus(sessionId)).toBe("deleted");
  });

  it("leaves fresh sessions alone (idle < 10min)", async () => {
    const sessionId = await createSession();
    // Do NOT backdate — session is still fresh.

    const stub = getUserControlStub();
    await runInDurableObject(stub, async (_, state) => {
      state.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    });
    await runDurableObjectAlarm(stub);

    expect(await getSessionStatus(sessionId)).toBe("idle");
  });

  it("arms the alarm on session creation so the sweep will run", async () => {
    await createSession();
    const stub = getUserControlStub();
    const alarmAt = await runInDurableObject<import("../src/user-control").UserControl, number | null>(
      stub,
      async (_, state) => await state.storage.getAlarm(),
    );
    expect(alarmAt).not.toBeNull();
    expect(alarmAt!).toBeGreaterThan(Date.now());
  });

  it("preserves sessions that have prompts (even if idle >10min)", async () => {
    const sessionId = await createSession();
    await backdateSession(sessionId, 11 * 60);

    // Seed a prompt row directly into the CodingAgent DO so the
    // /prompts/count endpoint returns non-zero.
    const typedEnv = env as Env;
    const agentStub = typedEnv.CODING_AGENT.get(typedEnv.CODING_AGENT.idFromName(sessionId));
    // Touch the agent to ensure schema is initialised.
    await agentStub.fetch(new Request(`https://coding-agent/?sessionId=${encodeURIComponent(sessionId)}`));
    await runInDurableObject(agentStub, async (_, state) => {
      const now = Math.floor(Date.now() / 1000);
      state.storage.sql.exec(
        "INSERT INTO prompts (id, session_id, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        "test-prompt-1",
        sessionId,
        "hello",
        "completed",
        now,
        now,
      );
    });

    const stub = getUserControlStub();
    await runInDurableObject(stub, async (_, state) => {
      state.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    });
    await runDurableObjectAlarm(stub);

    expect(await getSessionStatus(sessionId)).toBe("idle");
  });
  async function runSweep(): Promise<void> {
    const stub = getUserControlStub();
    await runInDurableObject(stub, async (_, state) => {
      state.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    });
    await runDurableObjectAlarm(stub);
  }

  it("keeps a session that has been forked from, even with no prompts", async () => {
    const baseId = await createSession();
    const forkRes = await fetchJson(`/session/${baseId}/fork`, { method: "POST" });
    expect(forkRes.status).toBe(201);
    const forkId = ((await forkRes.json()) as { id: string }).id;

    await backdateSession(baseId, 11 * 60);
    await backdateSession(forkId, 11 * 60);
    await runSweep();

    // The base is a fork source and survives; the empty fork itself does not.
    expect(await getSessionStatus(baseId)).toBe("idle");
    expect(await getSessionStatus(forkId)).toBe("deleted");

    // And it can still be forked after the sweep.
    const again = await fetchJson(`/session/${baseId}/fork`, { method: "POST" });
    expect(again.status).toBe(201);
  });

  it("keeps the source session of a fork schedule", async () => {
    const baseId = await createSession();
    const schedRes = await fetchJson("/api/scheduled-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        description: "nightly from base",
        prompt: "run",
        type: "delayed",
        delayInSeconds: 3600,
        source: "fork",
        sourceSessionId: baseId,
      }),
    });
    expect(schedRes.status).toBe(201);

    await backdateSession(baseId, 11 * 60);
    await runSweep();

    expect(await getSessionStatus(baseId)).toBe("idle");
  });
  it("keeps the source after a one-shot fork schedule has fired and its row is gone", async () => {
    const baseId = await createSession();
    const schedRes = await fetchJson("/api/scheduled-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        description: "one-shot from base",
        prompt: "run",
        type: "delayed",
        delayInSeconds: 1,
        source: "fork",
        sourceSessionId: baseId,
      }),
    });
    expect(schedRes.status).toBe(201);
    const schedId = ((await schedRes.json()) as { id: string }).id;

    // Fire the schedule.
    const stub = getUserControlStub();
    await runInDurableObject(stub, async (_, state) => {
      state.storage.sql.exec("UPDATE scheduled_sessions SET next_run_epoch = 1 WHERE id = ?", schedId);
      state.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    });
    await runDurableObjectAlarm(stub);
    expect((await fetchJson(`/api/scheduled-sessions/${schedId}`)).status).toBe(404);

    await backdateSession(baseId, 11 * 60);
    await runSweep();

    expect(await getSessionStatus(baseId)).toBe("idle");
  });

  it("fork-source mark flags a live session and 404s for unknown or deleted ones", async () => {
    const stub = getUserControlStub();
    const liveId = await createSession();
    const ok = await stub.fetch(`https://user-control/sessions/${liveId}/fork-source`, { method: "POST" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ marked: true, sessionId: liveId });
    const flag = await runInDurableObject(stub, async (_, state) =>
      (state.storage.sql.exec("SELECT fork_source FROM sessions WHERE id = ?", liveId).toArray()[0] as { fork_source: number }).fork_source);
    expect(flag).toBe(1);

    const unknown = await stub.fetch("https://user-control/sessions/does-not-exist/fork-source", { method: "POST" });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "Session 'does-not-exist' not found" });

    const deadId = await createSession();
    await backdateSession(deadId, 11 * 60);
    await runSweep();
    const dead = await stub.fetch(`https://user-control/sessions/${deadId}/fork-source`, { method: "POST" });
    expect(dead.status).toBe(404);
  });
  async function seedPrompt(sessionId: string): Promise<void> {
    const typedEnv = env as Env;
    const agentStub = typedEnv.CODING_AGENT.get(typedEnv.CODING_AGENT.idFromName(sessionId));
    await agentStub.fetch(new Request(`https://coding-agent/?sessionId=${encodeURIComponent(sessionId)}`));
    await runInDurableObject(agentStub, async (_, state) => {
      const now = Math.floor(Date.now() / 1000);
      state.storage.sql.exec(
        "INSERT INTO prompts (id, session_id, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        `p-${sessionId}`, sessionId, "hello", "completed", now, now,
      );
    });
  }

  async function hasPromptsFlag(sessionId: string): Promise<number> {
    return await runInDurableObject(getUserControlStub(), async (_, state) =>
      (state.storage.sql.exec("SELECT has_prompts FROM sessions WHERE id = ?", sessionId).toArray()[0] as { has_prompts: number }).has_prompts);
  }

  it("marks a session as prompted once a prompt starts (status 'running')", async () => {
    const sessionId = await createSession();
    expect(await hasPromptsFlag(sessionId)).toBe(0);
    const stub = getUserControlStub();
    const res = await stub.fetch(`https://user-control/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "running" }),
    });
    expect(res.status).toBe(200);
    await stub.fetch(`https://user-control/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "idle" }),
    });
    expect(await hasPromptsFlag(sessionId)).toBe(1);

    // The flag alone keeps it: its CodingAgent holds no prompt rows here.
    await backdateSession(sessionId, 11 * 60);
    await runSweep();
    expect(await getSessionStatus(sessionId)).toBe("idle");
  });

  it("reaches newer empty sessions behind a full batch of old prompted ones", async () => {
    // Regression: the sweep took the 25 oldest idle sessions and skipped
    // prompted ones without remembering them, so 25+ old prompted
    // sessions blocked every newer empty session for good.
    const BATCH = 25;
    const prompted: string[] = [];
    for (let i = 0; i < BATCH + 1; i++) {
      const id = await createSession();
      await seedPrompt(id);
      await backdateSession(id, 3600 + (BATCH - i) * 60); // all older than the control
      prompted.push(id);
    }
    const control = await createSession();
    await backdateSession(control, 11 * 60);

    // First pass counts prompts on the oldest 25 and flags them.
    await runSweep();
    // Second pass skips the flagged ones in SQL and reaches the control.
    await runSweep();

    expect(await getSessionStatus(control)).toBe("deleted");
    for (const id of prompted) {
      expect(await getSessionStatus(id)).toBe("idle");
      expect(await hasPromptsFlag(id)).toBe(1);
    }
  }, 120_000);

  it("does not push an armed sweep later when sessions keep being created", async () => {
    await createSession();
    const stub = getUserControlStub();
    const soon = Date.now() + 30_000;
    await runInDurableObject(stub, async (_, state) => {
      state.storage.setAlarm(soon);
    });
    await createSession();
    const alarmAt = await runInDurableObject<import("../src/user-control").UserControl, number | null>(
      stub,
      async (_, state) => await state.storage.getAlarm(),
    );
    expect(alarmAt).toBe(soon);
  });

  async function readAlarm(): Promise<number | null> {
    return await runInDurableObject<import("../src/user-control").UserControl, number | null>(
      getUserControlStub(),
      async (_, state) => await state.storage.getAlarm(),
    );
  }

  it("pulls a far-off armed alarm in to the sweep interval", async () => {
    await createSession();
    const stub = getUserControlStub();
    await runInDurableObject(stub, async (_, state) => {
      state.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    });
    await createSession();
    const alarmAt = await readAlarm();
    expect(alarmAt).not.toBeNull();
    expect(alarmAt!).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);
  });

  it("clears the alarm when the only idle sessions are prompted", async () => {
    const sessionId = await createSession();
    await seedPrompt(sessionId);
    await backdateSession(sessionId, 11 * 60);
    await runSweep();
    expect(await hasPromptsFlag(sessionId)).toBe(1);
    expect(await readAlarm()).toBeNull();
  });

  it("keeps waking while an MCP token is waiting to sync", async () => {
    const stub = getUserControlStub();
    await runInDurableObject(stub, async (_, state) => {
      state.storage.sql.exec("DELETE FROM user_mcp_tokens");
      state.storage.sql.exec(
        "INSERT INTO user_mcp_tokens (token, email, label, created_at, last_used_at, synced_to_index) VALUES (?, ?, NULL, ?, NULL, 0)",
        "dodo_unsynced_test", "dev@dodo.local", Date.now(),
      );
    });
    // Make the SharedIndex replay fail so the row stays unsynced.
    const typedEnv = env as Env;
    const spy = vi.spyOn(typedEnv.SHARED_INDEX, "get").mockImplementation(() => ({
      fetch: async () => new Response("down", { status: 503 }),
    }) as never);
    try {
      await runSweep();
    } finally {
      spy.mockRestore();
    }
    const alarmAt = await readAlarm();
    const synced = await runInDurableObject(stub, async (_, state) => {
      const row = state.storage.sql.exec("SELECT synced_to_index FROM user_mcp_tokens WHERE token = ?", "dodo_unsynced_test").toArray()[0] as { synced_to_index: number };
      state.storage.sql.exec("DELETE FROM user_mcp_tokens WHERE token = ?", "dodo_unsynced_test");
      return row.synced_to_index;
    });
    expect(synced).toBe(0);
    expect(alarmAt).not.toBeNull();
  });

  it("refuses to fork a soft-deleted source", async () => {
    const baseId = await createSession();
    await backdateSession(baseId, 11 * 60);
    await runSweep();
    expect(await getSessionStatus(baseId)).toBe("deleted");

    const res = await fetchJson(`/session/${baseId}/fork`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
