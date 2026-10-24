/**
 * Sync POST /session/:id/message runs through SessionLifecycle: it holds the
 * active prompt id for the whole run, so an async /prompt queues behind it
 * (instead of starting on top and having its status overwritten), image
 * generation gets 409, abort reaches it, and a run cut off by a restart is
 * failed rather than left holding the session.
 */
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { releaseMockSlowPrompt, resetMockAgentic } from "./helpers/agentic-mock";

vi.mock("../src/agentic", async () => await import("./helpers/agentic-mock"));
vi.mock("../src/pi/models", async () => await import("./helpers/pi-models-mock"));

import worker from "../src/index";

const BASE = "https://dodo.example";
const typedEnv = env as unknown as Env;
const inDO = runInDurableObject as unknown as <T>(stub: unknown, fn: (instance: any) => Promise<T>) => Promise<T>;

async function call(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), typedEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const json = async <T>(res: Response) => (await res.json()) as T;
const send = (path: string, body: unknown, method = "POST") =>
  call(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

type Prompt = { id: string; status: string; error?: string | null };
const prompts = async (id: string) => (await json<{ prompts: Prompt[] }>(await call(`/session/${id}/prompts`))).prompts;

async function newSession(): Promise<string> {
  const res = await call("/session", { method: "POST" });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
}

async function waitFor(check: () => Promise<boolean>, what: string, ms = 5000) {
  for (let i = 0; i < ms / 10; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("sync /message through the session lifecycle", () => {
  it("holds the active prompt: async prompts queue behind it and drain after; image generation gets 409", async () => {
    resetMockAgentic();
    const id = await newSession();
    const stub = await getAgentByName(typedEnv.CODING_AGENT as never, id);
    const active = () => inDO<string | null>(stub, async (agent) => agent.control.readActivePromptId());
    try {
      const pending = send(`/session/${id}/message`, { content: "slow async prompt" });
      await waitFor(async () => (await active()) !== null, "the sync run to start");
      const syncId = (await active())!;
      expect((await prompts(id)).find((p) => p.id === syncId)?.status).toBe("running");
      expect((await json<{ status: string }>(await call(`/session/${id}`))).status).toBe("running");

      // An async prompt queues instead of starting on top.
      const queued = await json<{ position?: number; promptId: string }>(await send(`/session/${id}/prompt`, { content: "after the sync run" }));
      expect(queued.position).toBe(1);
      expect(await active()).toBe(syncId);
      // Image generation and a second sync message are rejected.
      expect((await send(`/session/${id}/message`, { content: "/generate a cat" })).status).toBe(409);
      expect((await send(`/session/${id}/message`, { content: "second" })).status).toBe(409);
      expect(await active()).toBe(syncId);

      releaseMockSlowPrompt();
      const res = await pending;
      expect(res.status).toBe(200);
      expect((await json<{ promptId: string }>(res)).promptId).toBe(syncId);
      expect((await prompts(id)).find((p) => p.id === syncId)?.status).toBe("completed");

      // finish() dequeued the async prompt; it runs to completion and the session ends idle.
      await waitFor(async () => (await prompts(id)).some((p) => p.status === "completed" && p.id !== syncId), "the queued prompt to run");
      await waitFor(async () => (await active()) === null, "the session to go idle");
      expect((await json<{ status: string }>(await call(`/session/${id}`))).status).toBe("idle");
    } finally {
      releaseMockSlowPrompt();
    }
  });

  it("abort stops a sync run: the prompt is aborted, the caller gets 409, the session goes idle", async () => {
    resetMockAgentic();
    const id = await newSession();
    const stub = await getAgentByName(typedEnv.CODING_AGENT as never, id);
    const active = () => inDO<string | null>(stub, async (agent) => agent.control.readActivePromptId());
    try {
      const pending = send(`/session/${id}/message`, { content: "slow async prompt" });
      await waitFor(async () => (await active()) !== null, "the sync run to start");
      const syncId = (await active())!;

      const abort = await call(`/session/${id}/abort`, { method: "POST" });
      expect(abort.status).toBe(200);
      expect((await json<{ promptId: string }>(abort)).promptId).toBe(syncId);

      const res = await pending;
      expect(res.status).toBe(409);
      expect((await json<{ aborted?: boolean }>(res)).aborted).toBe(true);
      expect((await prompts(id)).find((p) => p.id === syncId)?.status).toBe("aborted");
      expect(await active()).toBeNull();
      expect(await inDO<string>(stub, async (agent) => agent.control.readStatus())).toBe("idle");
    } finally {
      releaseMockSlowPrompt();
    }
  });

  it("an abort while start() is still syncing the index stops the run before the model is called", async () => {
    resetMockAgentic();
    const id = await newSession();
    const stub = await getAgentByName(typedEnv.CODING_AGENT as never, id);
    // Abort from inside start()'s "running" index sync, after the active prompt is set.
    await inDO(stub, async (agent) => {
      const orig = agent.syncSessionIndex.bind(agent);
      agent.__indexPatches = [];
      let aborted = false;
      agent.syncSessionIndex = async (patch: { status: string }) => {
        agent.__indexPatches.push(patch.status);
        if (patch.status === "running" && !aborted) {
          aborted = true;
          await agent.handleAbort();
        }
        return orig(patch);
      };
    });
    const res = await send(`/session/${id}/message`, { content: "hello there" });
    expect(res.status).toBe(409);
    const body = await json<{ aborted?: boolean; promptId: string }>(res);
    expect(body.aborted).toBe(true);
    expect((await prompts(id)).find((p) => p.id === body.promptId)?.status).toBe("aborted");
    expect(await inDO(stub, async (agent) => agent.control.readActivePromptId())).toBeNull();
    // The model never ran: no messages in the transcript.
    const { messages } = await json<{ messages: unknown[] }>(await call(`/session/${id}/messages`));
    expect(messages).toHaveLength(0);
    // The index ends idle: the run's own idle sync comes after start()'s "running" one.
    const patches = await inDO<string[]>(stub, async (agent) => agent.__indexPatches);
    expect(patches.at(-1)).toBe("idle");
    expect(patches.lastIndexOf("idle")).toBeGreaterThan(patches.indexOf("running"));
  });

  it("a finish that throws after a completed run still returns the answer and releases the session", async () => {
    resetMockAgentic();
    const id = await newSession();
    const stub = await getAgentByName(typedEnv.CODING_AGENT as never, id);
    await inDO(stub, async (agent) => {
      const lifecycle = agent.sessionLifecycle;
      const orig = lifecycle.finish;
      lifecycle.finish = async (...args: unknown[]) => {
        lifecycle.finish = orig;
        throw new Error("finish exploded");
      };
    });
    const res = await send(`/session/${id}/message`, { content: "hello there" });
    expect(res.status).toBe(200);
    const body = await json<{ promptId: string; message: { content?: string } }>(res);
    expect(body.message).toBeTruthy();
    expect((await prompts(id)).find((p) => p.id === body.promptId)?.status).toBe("completed");
    expect(await inDO(stub, async (agent) => agent.control.readActivePromptId())).toBeNull();
    expect(await inDO<string>(stub, async (agent) => agent.control.readStatus())).toBe("idle");
  });

  it("a restart fails an inline prompt nobody will finish, and drains the queue; fiber-backed prompts are left alone", async () => {
    resetMockAgentic();
    const id = await newSession();
    const stub = await getAgentByName(typedEnv.CODING_AGENT as never, id);
    // Prime the session (owner, config) with a normal prompt.
    const first = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "hello" }));
    await waitFor(async () => (await prompts(id)).find((p) => p.id === first.promptId)?.status === "completed", "the first prompt");

    // A fiber-backed active prompt: untouched.
    await inDO(stub, async (agent) => {
      agent.control.beginPrompt("fiber-backed", "t");
      agent.ctx.storage.sql.exec("INSERT INTO prompts (id, session_id, content, status, fiber_id, created_at, updated_at) VALUES ('fiber-backed', ?, 'x', 'running', 'fib_1', 0, 0)", id);
      await agent.failInterruptedInlinePrompt();
    });
    expect(await inDO(stub, async (agent) => agent.control.readActivePromptId())).toBe("fiber-backed");
    await inDO(stub, async (agent) => {
      agent.ctx.storage.sql.exec("UPDATE prompts SET status = 'completed' WHERE id = 'fiber-backed'");
      agent.control.endPrompt();
    });

    // Fiber started but its id not yet on the prompt row: also left to fiber recovery.
    await inDO(stub, async (agent) => {
      agent.control.beginPrompt("fiber-no-id", "t");
      agent.ctx.storage.sql.exec("INSERT INTO prompts (id, session_id, content, status, created_at, updated_at) VALUES ('fiber-no-id', ?, 'x', 'queued', 0, 0)", id);
      agent.ctx.storage.sql.exec("INSERT INTO cf_agents_fibers (fiber_id, name, status, metadata_json, created_at) VALUES ('fib_2', 'runFiberPrompt', 'interrupted', ?, 0)", JSON.stringify({ promptId: "fiber-no-id" }));
      await agent.failInterruptedInlinePrompt();
    });
    expect(await inDO(stub, async (agent) => agent.control.readActivePromptId())).toBe("fiber-no-id");
    await inDO(stub, async (agent) => {
      agent.ctx.storage.sql.exec("DELETE FROM cf_agents_fibers WHERE fiber_id = 'fib_2'");
      agent.ctx.storage.sql.exec("UPDATE prompts SET status = 'completed' WHERE id = 'fiber-no-id'");
      agent.control.endPrompt();
    });

    // An inline run left behind by the old instance, with a prompt queued behind it.
    await inDO(stub, async (agent) => {
      agent.control.beginPrompt("inline-orphan", "t");
      agent.ctx.storage.sql.exec("INSERT INTO prompts (id, session_id, content, status, created_at, updated_at) VALUES ('inline-orphan', ?, 'x', 'running', 0, 0)", id);
      // A terminal fiber for it won't finish it either.
      agent.ctx.storage.sql.exec("INSERT INTO cf_agents_fibers (fiber_id, name, status, metadata_json, created_at) VALUES ('fib_3', 'runFiberPrompt', 'completed', ?, 0)", JSON.stringify({ promptId: "inline-orphan" }));
      // A live fiber row with malformed metadata doesn't break the lookup.
      agent.ctx.storage.sql.exec("INSERT INTO cf_agents_fibers (fiber_id, name, status, metadata_json, created_at) VALUES ('fib_4', 'other', 'interrupted', 'not json', 0)");
    });
    const queued = await json<{ position?: number }>(await send(`/session/${id}/prompt`, { content: "queued behind the orphan" }));
    expect(queued.position).toBe(1);
    await inDO(stub, async (agent) => agent.failInterruptedInlinePrompt());

    const orphan = (await prompts(id)).find((p) => p.id === "inline-orphan");
    expect(orphan?.status).toBe("failed");
    expect(orphan?.error).toMatch(/restarted/);
    await inDO(stub, async (agent) => agent.ctx.storage.sql.exec("DELETE FROM cf_agents_fibers WHERE fiber_id IN ('fib_3', 'fib_4')"));
    await waitFor(async () => (await prompts(id)).filter((p) => p.status === "completed").length >= 3, "the queued prompt to drain");
    await waitFor(async () => (await inDO(stub, async (agent) => agent.control.readActivePromptId())) === null, "the session to go idle");
  });
});
