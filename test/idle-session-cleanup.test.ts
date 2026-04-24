import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env } from "../src/types";
import { resetMockAgentic } from "./helpers/agentic-mock";

vi.mock("../src/executor", () => ({ runSandboxedCode: vi.fn() }));
vi.mock("../src/agentic", async () => await import("./helpers/agentic-mock"));
vi.mock("../src/notify", () => ({ sendNotification: vi.fn(), sendRunNotification: vi.fn() }));

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
  const result = await runInDurableObject<string | null, import("../src/user-control").UserControl>(
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
    const alarmAt = await runInDurableObject<number | null, import("../src/user-control").UserControl>(
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
});
