// pi is the default engine: the HTTP surface end to end on pi, the paths that
// used to read Think directly (sync /message, fork, snapshot, /generate
// persistence, session details, /debug/compaction), and legacy sessions that
// must stay on Think.

import { createExecutionContext, evictDurableObject, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { releaseMockSlowPrompt, resetMockAgentic } from "./helpers/agentic-mock";
import { ThinkHistoryWriter } from "./helpers/think-history";

vi.mock("../src/agentic", async () => await import("./helpers/agentic-mock"));
vi.mock("../src/pi/models", async () => await import("./helpers/pi-models-mock"));

import worker from "../src/index";
import { mockStuckPromptEntered, releaseMockStuckPrompt, seenContexts } from "./helpers/pi-models-mock";

const BASE = "https://dodo.example";
const typedEnv = env as unknown as Env;

async function call(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), typedEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const json = async <T>(res: Response) => (await res.json()) as T;
const send = (path: string, body: unknown, method = "POST") =>
  call(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function newSession(): Promise<string> {
  const res = await call("/session", { method: "POST" });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
}
type Msg = { id: string; role: string; content: string; attachments?: Array<{ mediaType: string; url: string }> };
const messages = async (id: string) => (await json<{ messages: Msg[] }>(await call(`/session/${id}/messages`))).messages;

/** Straight to the session's DO, for internal routes (snapshot import). */
async function agent(id: string) {
  return (await getAgentByName(typedEnv.CODING_AGENT as never, id)) as unknown as DurableObjectStub;
}
const internal = async (id: string, path: string, body: unknown) =>
  (await agent(id)).fetch(`https://coding-agent${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-dodo-session-id": id, "x-owner-email": "dev@dodo.local" },
    body: JSON.stringify(body),
  });

/** Give a session Think-era history, as sessions from before pi have. */
function seedThinkSession(instance: any, state: DurableObjectState): ThinkHistoryWriter {
  const w = new ThinkHistoryWriter(state.storage.sql);
  instance.setThinkSessionId(w.sessionId);
  return w;
}

/** Poll a prompt's status until it equals `want` (or ~2s pass); returns the last status seen. */
async function pollPromptStatus(id: string, promptId: string, want: string): Promise<string> {
  let status = "";
  for (let i = 0; i < 200 && status !== want; i++) {
    const { prompts } = await json<{ prompts: Array<{ id: string; status: string }> }>(await call(`/session/${id}/prompts`));
    status = prompts.find((p) => p.id === promptId)?.status ?? "";
    if (status !== want) await new Promise((r) => setTimeout(r, 10));
  }
  return status;
}

async function waitForPrompt(id: string, promptId: string, ms = 2000) {
  for (let i = 0; i < ms / 10; i++) {
    const { prompts } = await json<{ prompts: Array<{ id: string; status: string; error?: string }> }>(await call(`/session/${id}/prompts`));
    const p = prompts.find((x) => x.id === promptId);
    if (p && !["queued", "running"].includes(p.status)) return p;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("prompt never finished");
}

describe("pi is the default engine", () => {
  beforeEach(() => {
    resetMockAgentic();
    seenContexts.length = 0;
  });

  it("a new session runs on pi: sync /message, async /prompt, history, details", async () => {
    const id = await newSession();
    expect(await json(await call(`/session/${id}/engine`))).toEqual({ engine: "pi" });

    const sync = await send(`/session/${id}/message`, { content: "hello pi" });
    expect(sync.status).toBe(200);
    expect((await json<{ message: Msg }>(sync)).message.content).toBe("opencode:hello pi");

    const started = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "second turn" }));
    expect((await waitForPrompt(id, started.promptId)).status).toBe("completed");

    expect((await messages(id)).map((m) => [m.role, m.content])).toEqual([
      ["user", "hello pi"],
      ["assistant", "opencode:hello pi"],
      ["user", "second turn"],
      ["assistant", "opencode:second turn"],
    ]);
    // The second request carried the first turn as context.
    const last = seenContexts.at(-1)!;
    expect(JSON.stringify(last.messages)).toContain("hello pi");

    const details = await json<{ messageCount: number; compactionCount: number; contextUsagePercent: number }>(await call(`/session/${id}`));
    expect(details.compactionCount).toBe(0);
    expect(typeof details.contextUsagePercent).toBe("number");

    const debug = await json<{ engine: string; live: unknown }>(await call(`/session/${id}/debug/compaction`));
    expect(debug.engine).toBe("pi");
    expect(debug.live).toBeDefined();
  });

  it("a failing model call fails the prompt with the gateway's error", async () => {
    const id = await newSession();
    const started = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "This should fail" }));
    const t = Date.now();
    const p = await waitForPrompt(id, started.promptId, 55_000);
    expect(p.status).toBe("failed");
    expect(p.error).toBe("Gateway timeout");
    expect(Date.now() - t).toBeGreaterThan(5000); // pi retried before giving up
  });

  it("fork copies pi history into a new pi session that can keep going", async () => {
    const source = await newSession();
    await send(`/session/${source}/message`, { content: "remember the word kiwi" });
    const forked = await json<{ id: string }>(await call(`/session/${source}/fork`, { method: "POST" }));
    expect(await json(await call(`/session/${forked.id}/engine`))).toEqual({ engine: "pi" });
    expect((await messages(forked.id)).map((m) => m.content)).toEqual(["remember the word kiwi", "opencode:remember the word kiwi"]);

    await send(`/session/${forked.id}/message`, { content: "what was the word?" });
    expect(JSON.stringify(seenContexts.at(-1)!.messages)).toContain("kiwi");
  });

  it("imports a Think-era snapshot into pi: history shows, and the model sees it", async () => {
    const id = await newSession();
    const snapshot = {
      version: 2,
      title: "old think session",
      files: [],
      messages: [
        { uiMessage: { id: "u1", role: "user", parts: [{ type: "text", text: "the code is 4417" }] }, metadata: { authorEmail: "a@b.c" } },
        {
          uiMessage: { id: "a1", role: "assistant", parts: [{ type: "text", text: "noted" }, { type: "file", mediaType: "image/png", url: "data:image/png;base64,AAAA" }] },
          metadata: { model: "claude-test", provider: "opencode", tokenInput: 5, tokenOutput: 1 },
        },
      ],
    };
    const res = await internal(id, "/snapshot/import", snapshot);
    expect(res.status).toBe(200);
    const list = await messages(id);
    expect(list.map((m) => [m.id, m.role, m.content])).toEqual([
      ["u1", "user", "the code is 4417"],
      ["a1", "assistant", "noted"],
    ]);
    expect(list[1]!.attachments?.[0]?.mediaType).toBe("image/png");

    await send(`/session/${id}/message`, { content: "what is the code?" });
    expect(JSON.stringify(seenContexts.at(-1)!.messages)).toContain("4417");

    // Export round-trips the same messages.
    const exported = await json<{ messages: Array<{ uiMessage: { id: string } }> }>(
      await (await agent(id)).fetch("https://coding-agent/snapshot", { headers: { "x-dodo-session-id": id } }),
    );
    expect(exported.messages.map((m) => m.uiMessage.id).slice(0, 2)).toEqual(["u1", "a1"]);
  });

  it("a Think-era session moves to pi on its next prompt, history and context intact", async () => {
    const id = await newSession();
    // Loose signature: CodingAgent's full type makes runInDurableObject's inference blow up (TS2589).
    const inDO = runInDurableObject as unknown as (stub: unknown, fn: (instance: any, state: DurableObjectState) => Promise<void>) => Promise<void>;
    await inDO(await agent(id), async (instance, state) => {
      // A pre-pi session: Think history, no agent_engine metadata.
      const sid = seedThinkSession(instance, state);
      // Two old turns, compacted into a summary (Think shows it as a system message).
      sid.append({ id: "old-u", role: "user", parts: [{ type: "text", text: "my dog is called Biscuit" }] });
      sid.append({ id: "old-a", role: "assistant", parts: [{ type: "text", text: "Noted." }] });
      sid.compact("The user's dog is called Biscuit.", "old-u", "old-a");
      sid.append({ id: "legacy-u", role: "user", parts: [{ type: "text", text: "the password is swordfish" }] });
      sid.append({
        id: "legacy-a",
        role: "assistant",
        parts: [
          { type: "text", text: "Got it." },
          { type: "tool-browser", toolCallId: "t1", state: "output-available", input: {}, output: { type: "content", value: [{ type: "text", text: "shot" }, { type: "image-data", mediaType: "image/jpeg", data: "BBBB" }] } },
          { type: "file", mediaType: "image/png", url: "data:image/png;base64,AAAA" },
        ],
      });
      state.storage.sql.exec(
        "INSERT INTO message_metadata (message_id, author_email, model, provider, token_input, token_output, created_at) VALUES ('legacy-a', NULL, 'claude-test', 'opencode', 10, 2, 1700000000)",
      );
      state.storage.sql.exec("DELETE FROM metadata WHERE key = 'agent_engine'");
    });
    expect(await json(await call(`/session/${id}/engine`))).toEqual({ engine: "think" });
    const before = await messages(id);
    expect(before.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(before[0]!.content).toContain("The user's dog is called Biscuit.");

    const res = await send(`/session/${id}/message`, { content: "what is the password?" });
    expect(res.status).toBe(200);
    expect(await json(await call(`/session/${id}/engine`))).toEqual({ engine: "pi" });
    const seen = JSON.stringify(seenContexts.at(-1)!.messages);
    expect(seen).toContain("swordfish");
    expect(seen).toContain("Biscuit"); // the summary reaches the model

    const after = await messages(id);
    // Same rows the Think view showed: ids, roles, text.
    expect(after.slice(0, 3).map((m) => [m.id, m.role, m.content])).toEqual(before.map((m) => [m.id, m.role, m.content]));
    expect(after.slice(3).map((m) => m.content)).toEqual(["what is the password?", "opencode:what is the password?"]);
    // Both the file part and the tool-output screenshot carry over.
    expect(after[2]!.attachments?.map((a) => a.mediaType).sort()).toEqual(["image/jpeg", "image/png"]);

    // A second prompt doesn't re-import anything.
    await send(`/session/${id}/message`, { content: "again" });
    expect((await messages(id)).filter((m) => m.id === "legacy-u")).toHaveLength(1);
  });

  // CodingAgent used to override alarm() (a no-op "mcp-hygiene" timer that
  // re-armed itself for +24h), so Agent.alarm() never ran: session cron jobs
  // never fired and an evicted prompt only recovered when a client called in.
  it("the DO alarm runs Agents SDK schedules: a session cron job fires", async () => {
    const id = await newSession();
    const res = await send(`/session/${id}/cron`, { type: "delayed", delayInSeconds: 1, description: "probe", prompt: "cron says hi" });
    expect(res.status).toBeLessThan(300);
    await new Promise((r) => setTimeout(r, 1100));
    // Newer miniflare fires due alarms itself; run it by hand in case it hasn't.
    await runDurableObjectAlarm(await agent(id));
    for (let i = 0; i < 200; i++) {
      const { prompts } = await json<{ prompts: Array<{ content: string; status: string }> }>(await call(`/session/${id}/prompts`));
      if (prompts.some((p) => p.content.includes("cron says hi") && p.status === "completed")) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("cron prompt never ran");
  });

  it("sessions with agents 0.8.7 fiber rows (experimental/forever schema) still wake and run prompts", async () => {
    const id = await newSession();
    const inDO = runInDurableObject as unknown as <T>(stub: unknown, fn: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
    await inDO(await agent(id), async (_i, state) => {
      // Replace the new table with the exact 0.8.7 one: a finished fiber and
      // one cut off mid-prompt by the deploy.
      state.storage.sql.exec("DROP TABLE cf_agents_fibers");
      state.storage.sql.exec(`CREATE TABLE cf_agents_fibers (
        id TEXT PRIMARY KEY NOT NULL, callback TEXT NOT NULL, payload TEXT, snapshot TEXT,
        status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed', 'interrupted', 'cancelled')),
        retry_count INTEGER NOT NULL DEFAULT 0, max_retries INTEGER NOT NULL DEFAULT 3, result TEXT, error TEXT,
        started_at INTEGER, updated_at INTEGER, completed_at INTEGER, created_at INTEGER NOT NULL)`);
      state.storage.sql.exec("INSERT INTO cf_agents_fibers (id, callback, payload, status, created_at) VALUES ('old-done', 'runFiberPrompt', '{}', 'completed', 1)");
      state.storage.sql.exec("INSERT INTO cf_agents_fibers (id, callback, payload, status, created_at) VALUES ('old-run', 'runFiberPrompt', '{}', 'running', 2)");
      state.storage.sql.exec("INSERT INTO prompts (id, session_id, content, status, created_at, updated_at, fiber_id) VALUES ('p-old', 's', 'mid-deploy prompt', 'running', 2, 2, 'old-run')");
      state.storage.sql.exec("INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES ('active_prompt_id', 'p-old', 1), ('status', 'running', 1)");
      // agents 0.8.7 kept its schema version (2) as a cf_agents_state row.
      state.storage.kv.delete("cf_agents:schema_version");
      state.storage.sql.exec("INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES ('cf_schema_version', '2')");
    });
    await evictDurableObject(await agent(id));
    // The prompt the deploy cut off is failed with a clear reason, not stuck "running".
    const before = await json<{ prompts: Array<{ id: string; status: string; error?: string }> }>(await call(`/session/${id}/prompts`));
    const old = before.prompts.find((p) => p.id === "p-old");
    expect(old?.status).toBe("failed");
    expect(old?.error).toMatch(/upgrade/i);
    // And the session works: a new prompt runs to completion on the new fibers.
    const { promptId } = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "after upgrade" }));
    expect((await waitForPrompt(id, promptId)).status).toBe("completed");
    await inDO(await agent(id), async (_i, state) => {
      const cols = Array.from(state.storage.sql.exec("SELECT name FROM pragma_table_info('cf_agents_fibers')")).map((r) => r.name);
      expect(cols).toContain("fiber_id");
    });
  });

  it("crons written by agents 0.8.7 (cf_agents_schedules) survive the upgrade and still fire", async () => {
    const id = await newSession();
    const inDO = runInDurableObject as unknown as <T>(stub: unknown, fn: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
    const due = Math.floor(Date.now() / 1000) + 2;
    const future = Math.floor(Date.now() / 1000) + 86_400;
    await inDO(await agent(id), async (_i, state) => {
      // The exact 0.8.7 schema and row shapes (epoch seconds).
      state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS cf_agents_schedules (
        id TEXT PRIMARY KEY NOT NULL DEFAULT (randomblob(9)), callback TEXT, payload TEXT,
        type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron', 'interval')),
        time INTEGER, delayInSeconds INTEGER, cron TEXT, intervalSeconds INTEGER, running INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()), execution_started_at INTEGER, retry_options TEXT)`);
      state.storage.sql.exec("INSERT INTO cf_agents_schedules (id, callback, payload, type, time, delayInSeconds) VALUES ('legacy-1', 'runCronPrompt', ?, 'delayed', ?, 2)",
        JSON.stringify({ description: "legacy", prompt: "legacy cron hi" }), due);
      state.storage.sql.exec("INSERT INTO cf_agents_schedules (id, callback, payload, type, time, cron) VALUES ('legacy-2', 'runCronPrompt', ?, 'cron', ?, '0 9 * * *')",
        JSON.stringify({ description: "daily", prompt: "daily hi" }), future);
      for (const [sid, d, p] of [["legacy-1", "legacy", "legacy cron hi"], ["legacy-2", "daily", "daily hi"]]) {
        state.storage.sql.exec("INSERT INTO cron_jobs (schedule_id, description, prompt, created_at) VALUES (?, ?, ?, 1)", sid, d, p);
      }
    });
    // A 0.8.7 object has no schedule schema version yet.
    await inDO(await agent(id), async (_i, state) => { await state.storage.delete("cf_agents:schedules_schema_version"); });
    // Evict: the next wake runs Lifecycle startup, which migrates the table.
    await evictDurableObject(await agent(id));
    const { jobs } = await json<{ jobs: Array<{ id: string; nextRunAt: string | null; scheduleType: string }> }>(await call(`/session/${id}/cron`));
    const byId = Object.fromEntries(jobs.map((j) => [j.id, j]));
    expect(Object.keys(byId).sort()).toEqual(["legacy-1", "legacy-2"]);
    expect(byId["legacy-2"]!.scheduleType).toBe("cron");
    // nextRunAt must still be a sane date (ms vs s mixups land in 1970 or year 50000+).
    expect(Math.abs(Date.parse(byId["legacy-2"]!.nextRunAt!) - future * 1000)).toBeLessThan(60_000);
    await inDO(await agent(id), async (_i, state) => {
      expect(Array.from(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'cf_agents_schedules'"))).toEqual([]);
    });
    await new Promise((r) => setTimeout(r, 2100));
    await runDurableObjectAlarm(await agent(id));
    for (let i = 0; i < 300; i++) {
      const { prompts } = await json<{ prompts: Array<{ content: string; status: string }> }>(await call(`/session/${id}/prompts`));
      if (prompts.some((p) => p.content.includes("legacy cron hi") && p.status === "completed")) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("legacy cron never ran");
  });

  it("a one-off cron job due while a prompt runs is queued, then runs", async () => {
    const id = await newSession();
    const { promptId } = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "slow async prompt" }));
    await send(`/session/${id}/cron`, { type: "delayed", delayInSeconds: 1, description: "probe", prompt: "queued cron hi" });
    await new Promise((r) => setTimeout(r, 1100));
    await runDurableObjectAlarm(await agent(id));
    const queue = await json<{ queue?: unknown[]; items?: unknown[] }>(await call(`/session/${id}/queue`)).catch(() => null);
    releaseMockSlowPrompt();
    expect((await waitForPrompt(id, promptId)).status).toBe("completed");
    for (let i = 0; i < 300; i++) {
      const { prompts } = await json<{ prompts: Array<{ content: string; status: string }> }>(await call(`/session/${id}/prompts`));
      if (prompts.some((p) => p.content.includes("queued cron hi") && p.status === "completed")) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`queued cron never ran (queue: ${JSON.stringify(queue)})`);
  });

  it("an async prompt reads 'running' once its fiber starts, not 'queued' for the whole turn", async () => {
    const id = await newSession();
    const { promptId } = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "slow async prompt" }));
    try {
      expect(await pollPromptStatus(id, promptId, "running")).toBe("running");
    } finally {
      releaseMockSlowPrompt();
    }
    expect((await waitForPrompt(id, promptId)).status).toBe("completed");
  });

  it("aborting a prompt that already reads 'running' still ends 'aborted'", async () => {
    const id = await newSession();
    const { promptId } = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "slow async prompt" }));
    try {
      expect(await pollPromptStatus(id, promptId, "running")).toBe("running");
      expect((await call(`/session/${id}/abort`, { method: "POST" })).status).toBe(200);
      expect((await waitForPrompt(id, promptId)).status).toBe("aborted");
    } finally {
      releaseMockSlowPrompt();
    }
    // Let the cancelled fiber unwind; a late write must not flip the row back.
    await new Promise((r) => setTimeout(r, 200));
    expect((await waitForPrompt(id, promptId)).status).toBe("aborted");
  });

  it("a turn that hangs before its first model request fails with the step it hung in, and the session takes the next prompt", async () => {
    const id = await newSession();
    const inDO = runInDurableObject as unknown as (stub: unknown, fn: (instance: any) => Promise<void>) => Promise<void>;
    let restore: (() => void) | undefined;
    let releaseHung: (() => void) | undefined;
    await inDO(await agent(id), async (instance) => {
      instance.turnStallLimitsOverride = { idleMs: 300, longMs: 300 };
      // Stub a setup step (not connectMcpServers: the first request's owner
      // check calls that synchronously). Never settles and ignores the
      // abort: what an unbounded fetch does.
      const original = instance.warmTurnContext;
      instance.warmTurnContext = () => new Promise<void>((resolve) => {
        releaseHung = resolve;
      });
      restore = () => {
        instance.warmTurnContext = original;
        instance.turnStallLimitsOverride = null;
      };
    });
    const { promptId } = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "hello" }));
    const failed = await waitForPrompt(id, promptId, 5000);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("Turn stalled");
    expect(failed.error).toContain("warm_context");
    const session = await json<{ status: string; activePromptId?: string | null }>(await call(`/session/${id}`));
    expect(session.status).toBe("idle");

    // The hung step finishing late must not carry on with the dead turn.
    await inDO(await agent(id), async () => releaseHung?.());
    await new Promise((r) => setTimeout(r, 300));
    expect((await messages(id)).filter((m) => m.role === "user")).toEqual([]);

    await inDO(await agent(id), async () => restore?.());
    const next = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "after the stall" }));
    expect((await waitForPrompt(id, next.promptId, 5000)).status).toBe("completed");
  });

  it("a pi run that never settles after an abort is let go after the grace period", async () => {
    const id = await newSession();
    const inDO = runInDurableObject as unknown as <T>(stub: unknown, fn: (instance: any) => Promise<T>) => Promise<T>;
    const runs: Array<{ promptId: string; status?: string; reason?: string; ms?: number }> = [];
    await inDO(await agent(id), async (instance) => {
      instance.piAbortGraceMsOverride = 300;
      const engine = instance.piEngine();
      const run = engine.run.bind(engine);
      engine.run = async (input: { promptId: string; signal?: AbortSignal }) => {
        const record: (typeof runs)[number] = { promptId: input.promptId };
        runs.push(record);
        let abortedAt = 0;
        input.signal?.addEventListener("abort", () => { abortedAt = Date.now(); }, { once: true });
        const result = await run(input as never);
        Object.assign(record, { status: result.status, reason: result.reason, ms: abortedAt ? Date.now() - abortedAt : undefined });
        return result;
      };
    });
    // The model request ignores the abort: pi's run can't settle.
    const { promptId } = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "stuck model prompt" }));
    try {
      for (let i = 0; i < 300 && !mockStuckPromptEntered(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(mockStuckPromptEntered()).toBe(true);
      expect(runs.map((r) => r.promptId)).toEqual([promptId]);
      expect((await call(`/session/${id}/abort`, { method: "POST" })).status).toBe(200);
      expect((await waitForPrompt(id, promptId)).status).toBe("aborted");
      // run() returns on its own after the grace period, not when the model does.
      for (let i = 0; i < 300 && runs[0]?.status === undefined; i++) await new Promise((r) => setTimeout(r, 10));
      expect(runs[0]).toMatchObject({ promptId, status: "unanswered", reason: "abort_timeout" });
      expect(runs[0]?.ms).toBeLessThan(2_000);
    } finally {
      releaseMockStuckPrompt();
    }
    // Known gap: while the orphan is still stuck, pi queues the next
    // submission behind it (checked by hand, also with close + reopen). Once
    // it ends, the session works again.
    const next = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "after the stuck abort" }));
    expect((await waitForPrompt(id, next.promptId, 5000)).status).toBe("completed");
    await inDO(await agent(id), async (instance) => { instance.piAbortGraceMsOverride = null; });
  });

  it("turn progress keeps the session's updated_at fresh, so the opt-in watchdog measures silence, not turn length", async () => {
    const id = await newSession();
    const inDO = runInDurableObject as unknown as <T>(stub: unknown, fn: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
    const { promptId } = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "slow async prompt" }));
    const old = new Date(Date.now() - 3_600_000).toISOString();
    try {
      expect(await pollPromptStatus(id, promptId, "running")).toBe("running");
      await inDO(await agent(id), async (instance, state) => {
        state.storage.sql.exec("UPDATE metadata SET value = ? WHERE key = 'updated_at'", old);
        instance._lastActivityTouch = 0;
      });
    } finally {
      releaseMockSlowPrompt();
    }
    expect((await waitForPrompt(id, promptId)).status).toBe("completed");
    const updatedAt = await inDO(await agent(id), async (_i, state) =>
      String(Array.from(state.storage.sql.exec("SELECT value FROM metadata WHERE key = 'updated_at'"))[0]?.value),
    );
    expect(Date.parse(updatedAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("while an async prompt runs, the alarm stays a 30s heartbeat (so an evicted run wakes and recovers)", async () => {
    const id = await newSession();
    const inDO = runInDurableObject as unknown as <T>(stub: unknown, fn: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
    const alarmIn = async () => inDO(await agent(id), async (_i, state) => ((await state.storage.getAlarm()) ?? Infinity) - Date.now());
    const { promptId } = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "slow async prompt" }));
    for (let i = 0; i < 100 && (await alarmIn()) > 30_000; i++) await new Promise((r) => setTimeout(r, 10));
    expect(await alarmIn()).toBeLessThanOrEqual(30_000);
    await runDurableObjectAlarm(await agent(id));
    expect(await alarmIn()).toBeLessThanOrEqual(30_000);
    releaseMockSlowPrompt();
    expect((await waitForPrompt(id, promptId)).status).toBe("completed");
  });

  it("forking a Think-era session keeps attachment rows (browser screenshots) with their source", async () => {
    const id = await newSession();
    const inDO = runInDurableObject as unknown as (stub: unknown, fn: (instance: any, state: DurableObjectState) => Promise<void>) => Promise<void>;
    await inDO(await agent(id), async (instance, state) => {
      const sid = seedThinkSession(instance, state);
      sid.append({ id: "t-u", role: "user", parts: [{ type: "text", text: "screenshot the page" }] });
      sid.append({ id: "t-a", role: "assistant", parts: [{ type: "text", text: "Here it is." }] });
      state.storage.sql.exec(
        "INSERT INTO message_attachments (message_id, media_type, url, size, source, name, created_at) VALUES ('t-a', 'image/jpeg', 'data:image/jpeg;base64,CCCC', 4, 'tool', NULL, 1700000000)",
      );
      state.storage.sql.exec("DELETE FROM metadata WHERE key = 'agent_engine'");
    });
    const src = await messages(id);
    expect(src[1]!.attachments?.map((a) => a.mediaType)).toEqual(["image/jpeg"]);

    const forked = await json<{ id: string }>(await call(`/session/${id}/fork`, { method: "POST" }));
    expect(await json(await call(`/session/${forked.id}/engine`))).toEqual({ engine: "pi" });
    const dst = await messages(forked.id);
    expect(dst.map((m) => [m.id, m.role, m.content])).toEqual(src.map((m) => [m.id, m.role, m.content]));
    expect(dst[1]!.attachments).toEqual(src[1]!.attachments);
    // Fork the fork (pi → pi): still exactly one copy.
    const again = await json<{ id: string }>(await call(`/session/${forked.id}/fork`, { method: "POST" }));
    expect((await messages(again.id))[1]!.attachments).toEqual(src[1]!.attachments);
  });

  it("admin debug compact summarizes and the session keeps going", async () => {
    const id = await newSession();
    for (let i = 0; i < 6; i++) await send(`/session/${id}/message`, { content: `turn ${i} ${"lorem ipsum ".repeat(2500)}` });
    const asAdmin = { ...typedEnv, ADMIN_EMAIL: "dev@dodo.local" } as Env;
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${BASE}/session/${id}/debug/compact`, { method: "POST" }), asAdmin, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect((await json<{ compactionCount: number }>(res)).compactionCount).toBeGreaterThanOrEqual(1);
    const details = await json<{ compactionCount?: number }>(await call(`/session/${id}`));
    expect(details.compactionCount).toBeGreaterThanOrEqual(1);
    const after = await send(`/session/${id}/message`, { content: "still there?" });
    expect(after.status).toBe(200);
    expect(JSON.stringify(seenContexts.at(-1)!.messages)).toContain("still there?");
  });

  it("deleting a session deletes its pi history", async () => {
    const id = await newSession();
    await send(`/session/${id}/message`, { content: "secret: kumquat" });
    const inDO = runInDurableObject as unknown as <T>(stub: unknown, fn: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
    const piTables = async () =>
      inDO(await agent(id), async (_i, state) =>
        Array.from(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pi\\_%' ESCAPE '\\'")).length,
      );
    expect(await piTables()).toBeGreaterThan(0);
    expect((await call(`/session/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(await piTables()).toBe(0);
    const left = await inDO(await agent(id), async (instance) => JSON.stringify(await instance.piEngine().entries()));
    expect(left).not.toContain("kumquat");
  });

  it("only pi can be chosen", async () => {
    const id = await newSession();
    expect((await send(`/session/${id}/engine`, { engine: "think" }, "PUT")).status).toBe(400);
    expect((await send(`/session/${id}/engine`, { engine: "pi" }, "PUT")).status).toBe(200);
  });
});
