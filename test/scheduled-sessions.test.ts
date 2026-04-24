import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env, ScheduledSessionRecord } from "../src/types";
import { resetMockAgentic } from "./helpers/agentic-mock";

const { runSandboxedCodeMock, sendNotificationMock } = vi.hoisted(() => ({
  runSandboxedCodeMock: vi.fn(),
  sendNotificationMock: vi.fn(),
}));

vi.mock("../src/executor", () => ({ runSandboxedCode: runSandboxedCodeMock }));
vi.mock("../src/agentic", async () => await import("./helpers/agentic-mock"));
vi.mock("../src/notify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/notify")>();
  return { ...actual, sendNotification: sendNotificationMock };
});

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

async function createScheduled(body: Record<string, unknown>): Promise<Response> {
  return fetchJson("/api/scheduled-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Fetch the UserControl DO for the dev-mode user so we can drive its alarm directly. */
function getUserControlStub(): DurableObjectStub<import("../src/user-control").UserControl> {
  const typedEnv = env as Env;
  // DEV_EMAIL is "dev@dodo.local" (see src/auth.ts DEV_EMAIL constant).
  return typedEnv.USER_CONTROL.get(typedEnv.USER_CONTROL.idFromName("dev@dodo.local"));
}

async function clearScheduledSessions(): Promise<void> {
  const stub = getUserControlStub();
  await runInDurableObject(stub, async (_, state) => {
    state.storage.sql.exec("DELETE FROM scheduled_sessions");
    // Also purge sessions table so cross-test leakage doesn't confuse
    // "find the newly forked session" assertions.
    state.storage.sql.exec("DELETE FROM sessions");
    await state.storage.deleteAlarm();
  });
}

beforeEach(async () => {
  resetMockAgentic();
  sendNotificationMock.mockReset();
  runSandboxedCodeMock.mockReset();
  await clearScheduledSessions();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Scheduled new-session lifecycle", () => {
  it("rejects scheduled date in the past", async () => {
    const res = await createScheduled({
      description: "past",
      prompt: "hello",
      type: "scheduled",
      date: new Date(Date.now() - 60_000).toISOString(),
      source: "fresh",
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/future/);
  });

  it("rejects scheduled date more than 90 days in the future", async () => {
    const farFuture = new Date(Date.now() + 91 * 86400 * 1000).toISOString();
    const res = await createScheduled({
      description: "too-far",
      prompt: "x",
      type: "scheduled",
      date: farFuture,
      source: "fresh",
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/90 days/);
  });

  it("rejects delay longer than 90 days", async () => {
    const res = await createScheduled({
      description: "too-far",
      prompt: "x",
      type: "delayed",
      delayInSeconds: 91 * 86400,
      source: "fresh",
    });
    expect(res.status).toBe(400);
  });

  it("rejects interval below the 300s minimum", async () => {
    const res = await createScheduled({
      description: "too-fast",
      prompt: "hello",
      type: "interval",
      intervalSeconds: 60,
      source: "fresh",
    });
    expect(res.status).toBe(400);
  });

  it("rejects cron that fires faster than every 5 minutes", async () => {
    const res = await createScheduled({
      description: "per-minute",
      prompt: "hello",
      type: "cron",
      cron: "* * * * *",
      source: "fresh",
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/too frequently/);
  });

  it("accepts a valid cron schedule", async () => {
    const res = await createScheduled({
      description: "every-5",
      prompt: "do it",
      type: "cron",
      cron: "*/5 * * * *",
      source: "fresh",
    });
    expect(res.status).toBe(201);
    const body = await res.json() as ScheduledSessionRecord;
    expect(body.scheduleType).toBe("cron");
    expect(body.cronExpression).toBe("*/5 * * * *");
    expect(body.nextRunAt).not.toBeNull();
    expect(body.sourceType).toBe("fresh");
  });

  it("rejects fork without sourceSessionId", async () => {
    const res = await createScheduled({
      description: "fork-no-source",
      prompt: "x",
      type: "delayed",
      delayInSeconds: 60,
      source: "fork",
    });
    // Fails Zod validation (sourceSessionId required in the fork branch).
    expect(res.status).toBe(400);
  });

  it("rejects fork pointing at a session that does not exist", async () => {
    const res = await createScheduled({
      description: "fork-missing",
      prompt: "x",
      type: "delayed",
      delayInSeconds: 60,
      source: "fork",
      sourceSessionId: "00000000-0000-0000-0000-000000000000",
    });
    // resolveSessionPermission returns null → 403
    expect(res.status).toBe(403);
  });

  it("creates + lists + deletes a delayed fresh schedule", async () => {
    const createRes = await createScheduled({
      description: "follow up",
      prompt: "check",
      type: "delayed",
      delayInSeconds: 600,
      source: "fresh",
      title: "scheduled follow-up",
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as ScheduledSessionRecord;
    expect(created.sourceType).toBe("fresh");
    expect(created.scheduleType).toBe("delayed");
    expect(created.title).toBe("scheduled follow-up");
    expect(created.nextRunAt).not.toBeNull();

    const listRes = await fetchJson("/api/scheduled-sessions");
    const { scheduledSessions } = await listRes.json() as { scheduledSessions: ScheduledSessionRecord[] };
    expect(scheduledSessions.some((s) => s.id === created.id)).toBe(true);

    const getRes = await fetchJson(`/api/scheduled-sessions/${created.id}`);
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json() as ScheduledSessionRecord;
    expect(fetched.id).toBe(created.id);
    expect(fetched.description).toBe("follow up");

    const delRes = await fetchJson(`/api/scheduled-sessions/${created.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);

    const after = await fetchJson(`/api/scheduled-sessions/${created.id}`);
    expect(after.status).toBe(404);
  });

  it("enforces the per-user cap", async () => {
    // MAX_SCHEDULES_PER_USER = 50. We don't want to create 50 every time
    // this suite runs; patch the DO's internal limit by filling through the
    // API. Cheaper: just assert cap message when we hit it.
    const MANY = 51;
    let firstFailure: Response | null = null;
    for (let i = 0; i < MANY; i++) {
      const res = await createScheduled({
        description: `cap-${i}`,
        prompt: "x",
        type: "delayed",
        delayInSeconds: 3600,
        source: "fresh",
      });
      if (res.status !== 201) {
        firstFailure = res;
        break;
      }
    }
    expect(firstFailure).not.toBeNull();
    expect(firstFailure!.status).toBe(400);
    const body = await firstFailure!.json() as { error: string };
    expect(body.error).toMatch(/maximum of 50/);
  });
});

describe("Scheduled new-session alarm firing", () => {
  it("fires a due delayed+fresh schedule, creates a session, and deletes the row", async () => {
    // Create a schedule that is already due by setting delayInSeconds = 1
    // then running the alarm via the miniflare helper. The alarm handler
    // only fires rows where next_run_epoch <= now.
    const createRes = await createScheduled({
      description: "fire now",
      prompt: "hello",
      type: "delayed",
      delayInSeconds: 1,
      source: "fresh",
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as ScheduledSessionRecord;

    // Force next_run_epoch into the past so the alarm will fire it, and
    // arm the DO alarm far in the future so miniflare won't auto-fire it
    // before we explicitly run it.
    const stub = getUserControlStub();
    await runInDurableObject(stub, async (_, state) => {
      state.storage.sql.exec(
        "UPDATE scheduled_sessions SET next_run_epoch = 1 WHERE id = ?",
        created.id,
      );
      state.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    });

    const alarmRan = await runDurableObjectAlarm(stub);
    expect(alarmRan).toBe(true);

    // One-shot row should be deleted
    const after = await fetchJson(`/api/scheduled-sessions/${created.id}`);
    expect(after.status).toBe(404);

    // A new session should have been registered for the owner
    const sessionList = await fetchJson("/session");
    const { sessions } = await sessionList.json() as { sessions: Array<{ id: string; createdBy?: string }> };
    const scheduledSession = sessions.find((s) => s.createdBy === "scheduled-session");
    expect(scheduledSession).toBeDefined();
  });

  it("forks an existing session when source='fork'", async () => {
    const sourceId = await createSession();
    // Seed the source with a file so we can assert the fork copied it
    const putRes = await fetchJson(`/session/${sourceId}/file?path=/seed.txt`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "from source" }),
    });
    expect(putRes.status).toBeLessThan(300);
    const sourceFile = await fetchJson(`/session/${sourceId}/file?path=/seed.txt`);
    expect(sourceFile.status).toBe(200);

    const createRes = await createScheduled({
      description: "fork fire",
      prompt: "inspect the seed",
      type: "delayed",
      delayInSeconds: 1,
      source: "fork",
      sourceSessionId: sourceId,
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as ScheduledSessionRecord;
    expect(created.sourceType).toBe("fork");
    expect(created.sourceSessionId).toBe(sourceId);

    // Fire the alarm
    const stub = getUserControlStub();
    await runInDurableObject(stub, async (_, state) => {
      state.storage.sql.exec(
        "UPDATE scheduled_sessions SET next_run_epoch = 1 WHERE id = ?",
        created.id,
      );
      state.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // Row deleted (one-shot)
    const checkRes = await fetchJson(`/api/scheduled-sessions/${created.id}`);
    expect(checkRes.status).toBe(404);

    // A new session should exist with the source's seed.txt file copied.
    const listRes = await fetchJson("/session");
    const { sessions } = await listRes.json() as { sessions: Array<{ id: string; createdBy?: string }> };
    const forked = sessions.find((s) => s.id !== sourceId && s.createdBy === "scheduled-session");
    expect(forked).toBeDefined();

    const fileRes = await fetchJson(`/session/${forked!.id}/file?path=/seed.txt`);
    expect(fileRes.status).toBe(200);
    const fileBody = await fileRes.json() as { content?: string };
    expect(fileBody.content).toBe("from source");
  });

  it("recurring interval schedule cycles through multiple fires", async () => {
    // Audit finding #21: the original test fired once and stopped. A
    // regression where interval schedules fire once then get stuck
    // wouldn't have been caught. This test fires twice and confirms
    // runCount increments, lastSessionId changes, and nextRunAt keeps
    // advancing.
    const createRes = await createScheduled({
      description: "every 5 min",
      prompt: "poll",
      type: "interval",
      intervalSeconds: 300,
      source: "fresh",
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as ScheduledSessionRecord;

    const stub = getUserControlStub();

    // Fire #1
    await runInDurableObject(stub, async (_, state) => {
      state.storage.sql.exec(
        "UPDATE scheduled_sessions SET next_run_epoch = 1 WHERE id = ?",
        created.id,
      );
      state.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const afterFire1 = await (await fetchJson(`/api/scheduled-sessions/${created.id}`)).json() as ScheduledSessionRecord;
    expect(afterFire1.runCount).toBe(1);
    expect(afterFire1.lastSessionId).not.toBeNull();
    expect(afterFire1.nextRunAt).not.toBeNull();
    const firstLastSessionId = afterFire1.lastSessionId;

    // Force it due again and fire #2
    await runInDurableObject(stub, async (_, state) => {
      state.storage.sql.exec(
        "UPDATE scheduled_sessions SET next_run_epoch = 1 WHERE id = ?",
        created.id,
      );
      state.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const afterFire2 = await (await fetchJson(`/api/scheduled-sessions/${created.id}`)).json() as ScheduledSessionRecord;
    expect(afterFire2.runCount).toBe(2);
    expect(afterFire2.lastSessionId).not.toBeNull();
    expect(afterFire2.lastSessionId).not.toBe(firstLastSessionId);
    expect(afterFire2.failureCount).toBe(0);
  });

  it("processes ALARM_BATCH_SIZE rows per alarm, chains for overdue remainder", async () => {
    // Audit finding #20: batching had no test coverage. Create 12 due
    // schedules (> ALARM_BATCH_SIZE=10), fire once, and confirm exactly
    // 10 are processed while 2 remain. Then fire again and confirm the
    // remaining 2 are picked up.
    const stub = getUserControlStub();
    const schedIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await createScheduled({
        description: `batch-${i}`,
        prompt: "reply ok",
        type: "delayed",
        delayInSeconds: 3600, // far-future create; we'll force due below
        source: "fresh",
      });
      expect(res.status).toBe(201);
      schedIds.push((await res.json() as ScheduledSessionRecord).id);
    }

    // Mark all 12 as due so the alarm picks them all up in one pass.
    await runInDurableObject(stub, async (_, state) => {
      state.storage.sql.exec("UPDATE scheduled_sessions SET next_run_epoch = 1");
      state.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // After fire #1: exactly 10 one-shot rows should be gone, 2 remain.
    const remaining1: string[] = [];
    for (const id of schedIds) {
      const res = await fetchJson(`/api/scheduled-sessions/${id}`);
      if (res.status === 200) remaining1.push(id);
    }
    expect(remaining1).toHaveLength(2);

    // The alarm should have re-armed to fire again soon. Force it due
    // once more and fire — both remaining rows should clear.
    await runInDurableObject(stub, async (_, state) => {
      state.storage.sql.exec("UPDATE scheduled_sessions SET next_run_epoch = 1");
      state.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const remaining2: string[] = [];
    for (const id of schedIds) {
      const res = await fetchJson(`/api/scheduled-sessions/${id}`);
      if (res.status === 200) remaining2.push(id);
    }
    expect(remaining2).toHaveLength(0);
  });

  it("stalls after MAX_FAILURES consecutive failures", async () => {
    // Schedule a fork from a source we'll delete before firing so each
    // attempt fails with source_session_missing.
    const sourceId = await createSession();
    const createRes = await createScheduled({
      description: "doomed",
      prompt: "x",
      type: "interval",
      intervalSeconds: 300,
      source: "fork",
      sourceSessionId: sourceId,
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as ScheduledSessionRecord;

    // Remove the source session from UserControl so subsequent fires fail.
    await fetchJson(`/session/${sourceId}`, { method: "DELETE" });

    const stub = getUserControlStub();

    // Fire 5 times. Each time we force next_run_epoch into the past so
    // the alarm picks it up.
    for (let i = 0; i < 5; i++) {
      await runInDurableObject(stub, async (_, state) => {
        state.storage.sql.exec(
          "UPDATE scheduled_sessions SET next_run_epoch = 1 WHERE id = ? AND stalled_at IS NULL",
          created.id,
        );
        state.storage.setAlarm(Date.now() + 60 * 60 * 1000);
      });
      await runDurableObjectAlarm(stub);
    }

    const afterRes = await fetchJson(`/api/scheduled-sessions/${created.id}`);
    expect(afterRes.status).toBe(200);
    const after = await afterRes.json() as ScheduledSessionRecord;
    expect(after.failureCount).toBeGreaterThanOrEqual(5);
    expect(after.stalledAt).not.toBeNull();
    expect(after.nextRunAt).toBeNull();

    // Retry clears the stall and arms a fresh nextRunAt
    const retryRes = await fetchJson(`/api/scheduled-sessions/${created.id}/retry`, { method: "POST" });
    expect(retryRes.status).toBe(200);
    const retried = await retryRes.json() as ScheduledSessionRecord;
    expect(retried.stalledAt).toBeNull();
    expect(retried.failureCount).toBe(0);
    expect(retried.nextRunAt).not.toBeNull();
  });
});
