// pi is the default engine: the HTTP surface end to end on pi, the paths that
// used to read Think directly (sync /message, fork, snapshot, /generate
// persistence, session details, /debug/compaction), and legacy sessions that
// must stay on Think.

import { createExecutionContext, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { releaseMockSlowPrompt, resetMockAgentic } from "./helpers/agentic-mock";

vi.mock("../src/agentic", async () => await import("./helpers/agentic-mock"));
vi.mock("../src/pi/models", async () => await import("./helpers/pi-models-mock"));

import worker from "../src/index";
import { seenContexts } from "./helpers/pi-models-mock";

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
      const sid = instance.getCurrentSessionId() ?? instance.createSession("default").id;
      // Two old turns, compacted into a summary (Think shows it as a system message).
      instance.sessions.append(sid, { id: "old-u", role: "user", parts: [{ type: "text", text: "my dog is called Biscuit" }] });
      instance.sessions.append(sid, { id: "old-a", role: "assistant", parts: [{ type: "text", text: "Noted." }] });
      instance.sessions.addCompaction(sid, "The user's dog is called Biscuit.", "old-u", "old-a");
      instance.sessions.append(sid, { id: "legacy-u", role: "user", parts: [{ type: "text", text: "the password is swordfish" }] });
      instance.sessions.append(sid, {
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
    expect(await runDurableObjectAlarm(await agent(id))).toBe(true);
    for (let i = 0; i < 200; i++) {
      const { prompts } = await json<{ prompts: Array<{ content: string; status: string }> }>(await call(`/session/${id}/prompts`));
      if (prompts.some((p) => p.content.includes("cron says hi") && p.status === "completed")) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("cron prompt never ran");
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
      const sid = instance.getCurrentSessionId() ?? instance.createSession("default").id;
      instance.sessions.append(sid, { id: "t-u", role: "user", parts: [{ type: "text", text: "screenshot the page" }] });
      instance.sessions.append(sid, { id: "t-a", role: "assistant", parts: [{ type: "text", text: "Here it is." }] });
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
