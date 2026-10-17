// pi is the default engine: the HTTP surface end to end on pi, the paths that
// used to read Think directly (sync /message, fork, snapshot, /generate
// persistence, session details, /debug/compaction), and legacy sessions that
// must stay on Think.

import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { resetMockAgentic } from "./helpers/agentic-mock";

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

  it("a session with Think history and no pinned engine stays on Think", async () => {
    const id = await newSession();
    // Loose signature: CodingAgent's full type makes runInDurableObject's inference blow up (TS2589).
    const inDO = runInDurableObject as unknown as (stub: unknown, fn: (instance: any, state: DurableObjectState) => Promise<void>) => Promise<void>;
    await inDO(await agent(id), async (instance, state) => {
      // Simulate a pre-engine-switch session: Think history, no agent_engine metadata.
      const sid = instance.getCurrentSessionId() ?? instance.createSession("default").id;
      instance.sessions.append(sid, { id: "legacy-1", role: "user", parts: [{ type: "text", text: "from before pi" }] });
      state.storage.sql.exec("DELETE FROM metadata WHERE key = 'agent_engine'");
    });
    expect(await json(await call(`/session/${id}/engine`))).toEqual({ engine: "think" });
    expect((await messages(id)).map((m) => m.content)).toContain("from before pi");
  });
});
