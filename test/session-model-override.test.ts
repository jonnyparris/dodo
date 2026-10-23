/**
 * Per-session model override: `model` / `exploreModel` / `taskModel` on
 * POST /session/:id/prompt pin one session to other models without touching
 * the owner's config, and the pin reaches explore/task facets.
 */
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { createModelOverrideStore, modelOverridePatch, withModelOverride } from "../src/session-model-override";
import { aigMetadataHeader } from "../src/subagent-runner";
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

async function newSession(): Promise<string> {
  const res = await call("/session", { method: "POST" });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
}

async function waitForStatus(id: string, promptId: string, want: string, ms = 5000) {
  for (let i = 0; i < ms / 10; i++) {
    const { prompts } = await json<{ prompts: Array<{ id: string; status: string }> }>(await call(`/session/${id}/prompts`));
    if (prompts.find((x) => x.id === promptId)?.status === want) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`prompt never reached ${want}`);
}

async function waitForPrompt(id: string, promptId: string, ms = 3000) {
  for (let i = 0; i < ms / 10; i++) {
    const { prompts } = await json<{ prompts: Array<{ id: string; status: string }> }>(await call(`/session/${id}/prompts`));
    const p = prompts.find((x) => x.id === promptId);
    if (p && !["queued", "running"].includes(p.status)) return p;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("prompt never finished");
}

type Session = { model: string; nextModel?: string; exploreModel?: string; taskModel?: string; modelOverride?: Record<string, string> };

describe("per-session model override", () => {
  it("pins the session (and its subagents) to other models without changing the owner's config", async () => {
    const before = await json<{ model: string; exploreModel?: string }>(await call("/api/config"));
    const id = await newSession();

    const first = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, {
      content: "first",
      model: "@cf/test/main-b",
      exploreModel: "@cf/test/explore-b",
      taskModel: "@cf/test/task-b",
    }));
    await waitForPrompt(id, first.promptId);

    let s = await json<Session>(await call(`/session/${id}`));
    expect(s.model).toBe("@cf/test/main-b");
    expect(s.exploreModel).toBe("@cf/test/explore-b");
    expect(s.taskModel).toBe("@cf/test/task-b");
    expect(s.modelOverride).toEqual({ model: "@cf/test/main-b", exploreModel: "@cf/test/explore-b", taskModel: "@cf/test/task-b" });

    // The owner's saved config is untouched.
    const after = await json<{ model: string; exploreModel?: string }>(await call("/api/config"));
    expect(after.model).toBe(before.model);
    expect(after.exploreModel).toBe(before.exploreModel);

    // Kept for later prompts, even though every route re-sends the owner's model as x-dodo-model.
    const second = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "second" }));
    await waitForPrompt(id, second.promptId);
    s = await json<Session>(await call(`/session/${id}`));
    expect(s.model).toBe("@cf/test/main-b");

    // Facets get the session's models, not the owner's live config.
    const stub = await getAgentByName(typedEnv.CODING_AGENT as never, id);
    const facetConfig = await inDO<{ model: string; exploreModel?: string; taskModel?: string }>(stub, (agent) => agent.facetParentConfig());
    expect(facetConfig.model).toBe("@cf/test/main-b");
    expect(facetConfig.exploreModel).toBe("@cf/test/explore-b");
    expect(facetConfig.taskModel).toBe("@cf/test/task-b");

    // "" clears one field; the others stay.
    const third = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "third", model: "" }));
    await waitForPrompt(id, third.promptId);
    s = await json<Session>(await call(`/session/${id}`));
    expect(s.model).toBe(before.model);
    expect(s.modelOverride).toEqual({ exploreModel: "@cf/test/explore-b", taskModel: "@cf/test/task-b" });
  });

  it("follows the owner's config when no override is set", async () => {
    const config = await json<{ model: string }>(await call("/api/config"));
    const id = await newSession();
    const p = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "hi" }));
    await waitForPrompt(id, p.promptId);
    const s = await json<Session>(await call(`/session/${id}`));
    expect(s.model).toBe(config.model);
    expect(s.modelOverride).toBeUndefined();
  });

  it("rejects bad model ids and overrides from anyone but the owner", async () => {
    const id = await newSession();
    const bad = await send(`/session/${id}/prompt`, { content: "x", model: "bad model\nid" });
    expect(bad.status).toBe(400);

    // Prime owner metadata, then talk to the DO as a guest author.
    const ok = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "owner" }));
    await waitForPrompt(id, ok.promptId);
    const stub = await getAgentByName(typedEnv.CODING_AGENT as never, id);
    const owner = await inDO<string>(stub, async (agent) => agent.readMetadata("owner_email"));
    const guest = await (stub as unknown as { fetch(r: Request): Promise<Response> }).fetch(new Request("https://coding-agent/prompt", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dodo-session-id": id,
        "x-owner-email": owner,
        "x-author-email": "guest@example.com",
      },
      body: JSON.stringify({ content: "switch", model: "@cf/test/pricey" }),
    }));
    expect(guest.status).toBe(403);
    const s = await json<Session>(await call(`/session/${id}`));
    expect(s.modelOverride).toBeUndefined();
  });
});

describe("PUT /session/:id/model-override", () => {
  it("sets and clears the override without a prompt, and the next prompt uses it", async () => {
    const config = await json<{ model: string }>(await call("/api/config"));
    const id = await newSession();

    const set = await send(`/session/${id}/model-override`, { model: "@cf/test/put-b" }, "PUT");
    expect(set.status).toBe(200);
    expect(await json(set)).toEqual({ modelOverride: { model: "@cf/test/put-b" } });
    expect((await json<Session>(await call(`/session/${id}`))).modelOverride).toEqual({ model: "@cf/test/put-b" });

    const p = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "hi" }));
    await waitForPrompt(id, p.promptId);
    expect((await json<Session>(await call(`/session/${id}`))).model).toBe("@cf/test/put-b");

    const cleared = await send(`/session/${id}/model-override`, { model: "" }, "PUT");
    expect(await json(cleared)).toEqual({ modelOverride: {} });
    const p2 = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "again" }));
    await waitForPrompt(id, p2.promptId);
    expect((await json<Session>(await call(`/session/${id}`))).model).toBe(config.model);
  });

  it("session details show the models the next prompt runs on, from the PUT onwards", async () => {
    type Details = Session & { contextWindow: number; contextBudget: number };
    const before = await json<{ model: string; exploreModel?: string; taskModel?: string }>(await call("/api/config"));
    const owner = { model: "anthropic/claude-haiku-4-5", exploreModel: "@cf/test/owner-explore", taskModel: "@cf/test/owner-task" };
    await send("/api/config", owner, "PUT");
    try {
      // Fresh session, no prompt: the owner's model, not the Worker default.
      const id = await newSession();
      let s = await json<Details>(await call(`/session/${id}`));
      expect(s.model).toBe(owner.model);
      expect(s.contextWindow).toBe(200_000);

      // Fresh session, override set with PUT: shows straight away.
      await send(`/session/${id}/model-override`, { model: "anthropic/claude-sonnet-4-6", exploreModel: "@cf/test/explore-b" }, "PUT");
      s = await json<Details>(await call(`/session/${id}`));
      expect(s.model).toBe("anthropic/claude-sonnet-4-6");
      expect(s.exploreModel).toBe("@cf/test/explore-b");
      expect(s.taskModel).toBe(owner.taskModel);
      expect(s.contextWindow).toBe(1_000_000);
      expect(s.contextBudget).toBe(800_000);

      // After a prompt ran on the override, clearing it goes back to the
      // owner's models at once, not the cleared override the config held.
      const p = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "hi" }));
      await waitForPrompt(id, p.promptId);
      expect((await json<Details>(await call(`/session/${id}`))).model).toBe("anthropic/claude-sonnet-4-6");
      await send(`/session/${id}/model-override`, { model: "", exploreModel: "" }, "PUT");
      s = await json<Details>(await call(`/session/${id}`));
      expect(s.modelOverride).toBeUndefined();
      expect(s.model).toBe(owner.model);
      expect(s.exploreModel).toBe(owner.exploreModel);
      expect(s.contextWindow).toBe(200_000);

      // The session config itself moved too (pi and goal auto-continue turns read it).
      const stub = await getAgentByName(typedEnv.CODING_AGENT as never, id);
      const cfg = await inDO<{ model: string; exploreModel?: string }>(stub, async (agent) => agent.getConfig());
      expect(cfg.model).toBe(owner.model);
      expect(cfg.exploreModel).toBe(owner.exploreModel);
    } finally {
      await send("/api/config", { model: before.model, exploreModel: before.exploreModel ?? "", taskModel: before.taskModel ?? "" }, "PUT");
    }
  });

  it("mid-run: details keep the running model, the override shows as pending, and a cleared override is gone once idle", async () => {
    type Details = Session & { status: string; contextWindow: number };
    const before = await json<{ model: string }>(await call("/api/config"));
    const owner = "anthropic/claude-haiku-4-5";
    const pinned = "anthropic/claude-sonnet-4-6";
    await send("/api/config", { model: owner }, "PUT");
    resetMockAgentic();
    try {
      const id = await newSession();

      // Set the override while a prompt runs on the owner's model.
      const first = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "slow async prompt" }));
      await waitForStatus(id, first.promptId, "running");
      expect((await send(`/session/${id}/model-override`, { model: pinned }, "PUT")).status).toBe(200);
      let s = await json<Details>(await call(`/session/${id}`));
      expect(s.status).toBe("running");
      expect(s.model).toBe(owner);
      expect(s.contextWindow).toBe(200_000);
      expect(s.modelOverride?.model).toBe(pinned);
      expect(s.nextModel).toBe(pinned);
      releaseMockSlowPrompt();
      await waitForPrompt(id, first.promptId);
      s = await json<Details>(await call(`/session/${id}`));
      expect(s.model).toBe(pinned);
      expect(s.contextWindow).toBe(1_000_000);

      // Clear it while a prompt runs on the override.
      resetMockAgentic();
      const second = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "slow async prompt" }));
      await waitForStatus(id, second.promptId, "running");
      await send(`/session/${id}/model-override`, { model: "" }, "PUT");
      s = await json<Details>(await call(`/session/${id}`));
      expect(s.model).toBe(pinned);
      expect(s.modelOverride).toBeUndefined();
      expect(s.nextModel).toBe(owner);
      releaseMockSlowPrompt();
      await waitForPrompt(id, second.promptId);

      // Idle again: back on the owner's model without another prompt.
      for (let i = 0; i < 100 && s.model !== owner; i++) {
        await new Promise((r) => setTimeout(r, 10));
        s = await json<Details>(await call(`/session/${id}`));
      }
      expect(s.model).toBe(owner);
      expect(s.nextModel).toBe(owner);
      expect(s.contextWindow).toBe(200_000);
      const stub = await getAgentByName(typedEnv.CODING_AGENT as never, id);
      expect((await inDO<{ model: string }>(stub, async (agent) => agent.getConfig())).model).toBe(owner);
    } finally {
      releaseMockSlowPrompt();
      await send("/api/config", { model: before.model }, "PUT");
    }
  });

  it("mid-run: a facet spawn, git op or queued prompt doesn't move the running prompt's model to a new override", async () => {
    type Details = Session & { status: string; contextWindow: number };
    const before = await json<{ model: string }>(await call("/api/config"));
    const owner = "anthropic/claude-haiku-4-5";
    const pinned = "anthropic/claude-sonnet-4-6";
    await send("/api/config", { model: owner }, "PUT");
    resetMockAgentic();
    try {
      const id = await newSession();
      const stub = await getAgentByName(typedEnv.CODING_AGENT as never, id);
      const first = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "slow async prompt" }));
      await waitForStatus(id, first.promptId, "running");
      expect((await send(`/session/${id}/model-override`, { model: pinned, exploreModel: pinned }, "PUT")).status).toBe(200);

      // A facet spawn (facetParentConfig) and a git handler both run readAppConfig mid-run.
      const facet = await inDO<{ model: string; exploreModel?: string }>(stub, async (agent) => agent.facetParentConfig());
      expect(facet.exploreModel).toBe(pinned); // subagents started later still pick up the new override
      await inDO(stub, async (agent) => agent.readAppConfig());
      // A prompt queued behind the running one carries a model too (ensureThinkConfig).
      const queued = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "queued", model: pinned }));

      let s = await json<Details>(await call(`/session/${id}`));
      expect(s.status).toBe("running");
      expect(s.model).toBe(owner);
      expect(s.contextWindow).toBe(200_000);
      expect(s.exploreModel).not.toBe(pinned);
      expect(s.nextModel).toBe(pinned);
      expect((await inDO<{ model: string }>(stub, async (agent) => agent.getConfig())).model).toBe(owner);

      releaseMockSlowPrompt();
      await waitForPrompt(id, first.promptId);
      // The queued prompt gets a new prompt id when it leaves the queue.
      expect(queued.promptId).toBeTruthy();
      for (let i = 0; i < 500; i++) {
        const { prompts } = await json<{ prompts: Array<{ status: string }> }>(await call(`/session/${id}/prompts`));
        if (prompts.length === 2 && prompts.every((p) => p.status === "completed")) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      // Each answer is attributed to the model it ran on.
      const rows = await inDO<Array<{ model: string }>>(stub, async (agent) =>
        Array.from(agent.ctx.storage.sql.exec("SELECT model FROM message_metadata WHERE model IS NOT NULL ORDER BY created_at, rowid")) as Array<{ model: string }>);
      expect(rows.map((r) => r.model)).toEqual([owner, pinned]);
      s = await json<Details>(await call(`/session/${id}`));
      expect(s.model).toBe(pinned);
      expect(s.exploreModel).toBe(pinned);
    } finally {
      releaseMockSlowPrompt();
      await send("/api/config", { model: before.model }, "PUT");
    }
  });

  it("mid-run on the sync /message path: an override set during the run shows once it ends", async () => {
    type Details = Session & { status: string };
    const before = await json<{ model: string }>(await call("/api/config"));
    const owner = "anthropic/claude-haiku-4-5";
    const pinned = "anthropic/claude-sonnet-4-6";
    await send("/api/config", { model: owner }, "PUT");
    resetMockAgentic();
    try {
      const id = await newSession();
      const stub = await getAgentByName(typedEnv.CODING_AGENT as never, id);
      const pending = send(`/session/${id}/message`, { content: "slow async prompt" });
      const status = () => inDO<string>(stub, async (agent) => agent.control.readStatus());
      const configModel = () => inDO<string>(stub, async (agent) => agent.getConfig()?.model);
      for (let i = 0; i < 500 && (await status()) !== "running"; i++) await new Promise((r) => setTimeout(r, 10));
      // A GET mid-run (the web UI does one per SSE message) must not read the
      // sync run as idle: it has no active prompt id.
      expect((await json<Details>(await call(`/session/${id}`))).status).toBe("running");
      // A second sync message can't start a run on top (it would rebuild the config).
      expect((await send(`/session/${id}/message`, { content: "second" })).status).toBe(409);
      await send(`/session/${id}/model-override`, { model: pinned }, "PUT");
      expect(await inDO(stub, async (agent) => agent.readMetadata("config_refresh_pending"))).toBe("1");
      await inDO(stub, async (agent) => agent.readAppConfig()); // a git op / facet spawn mid-run
      expect(await configModel()).toBe(owner);
      releaseMockSlowPrompt();
      const res = await pending;
      expect(res.status).toBe(200);
      expect((await json<{ message: { model?: string } }>(res)).message.model).toBe(owner);
      for (let i = 0; i < 300 && (await configModel()) !== pinned; i++) await new Promise((r) => setTimeout(r, 10));
      expect(await configModel()).toBe(pinned);
      expect(await status()).toBe("idle");
      for (let i = 0; i < 100 && (await inDO(stub, async (agent) => agent.readMetadata("config_refresh_pending"))) !== null; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(await inDO(stub, async (agent) => agent.readMetadata("config_refresh_pending"))).toBeNull();
      expect((await json<Details>(await call(`/session/${id}`))).model).toBe(pinned);
    } finally {
      releaseMockSlowPrompt();
      await send("/api/config", { model: before.model }, "PUT");
    }
  });

  it("rejects bad bodies and guests", async () => {
    const id = await newSession();
    expect((await send(`/session/${id}/model-override`, { model: "bad id" }, "PUT")).status).toBe(400);
    expect((await send(`/session/${id}/model-override`, { content: "nope" }, "PUT")).status).toBe(400);

    const ok = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "owner" }));
    await waitForPrompt(id, ok.promptId);
    const stub = await getAgentByName(typedEnv.CODING_AGENT as never, id);
    const owner = await inDO<string>(stub, async (agent) => agent.readMetadata("owner_email"));
    const guest = await (stub as unknown as { fetch(r: Request): Promise<Response> }).fetch(new Request("https://coding-agent/model-override", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-dodo-session-id": id, "x-owner-email": owner, "x-author-email": "guest@example.com" },
      body: JSON.stringify({ model: "@cf/test/pricey" }),
    }));
    expect(guest.status).toBe(403);
  });
});

describe("session-model-override helpers", () => {
  it("store sets, keeps and clears fields", () => {
    const rows = new Map<string, string>();
    const store = createModelOverrideStore({
      read: (k) => rows.get(k) ?? null,
      write: (k, v) => void rows.set(k, v),
      delete: (k) => void rows.delete(k),
    });
    store.apply({ model: " @cf/a/b ", taskModel: "anthropic/claude-haiku-4-5" });
    expect(store.read()).toEqual({ model: "@cf/a/b", taskModel: "anthropic/claude-haiku-4-5" });
    store.apply({ exploreModel: "@cf/c/d" });
    expect(store.read()).toEqual({ model: "@cf/a/b", exploreModel: "@cf/c/d", taskModel: "anthropic/claude-haiku-4-5" });
    store.apply({ model: "" });
    expect(store.read()).toEqual({ exploreModel: "@cf/c/d", taskModel: "anthropic/claude-haiku-4-5" });
  });

  it("modelOverridePatch only picks the fields that were sent", () => {
    expect(modelOverridePatch({ model: undefined, taskModel: "" })).toEqual({ taskModel: "" });
  });

  it("withModelOverride only replaces the overridden fields", () => {
    const base = { model: "m", exploreModel: "e", taskModel: "t", other: 1 };
    expect(withModelOverride(base, {})).toEqual(base);
    expect(withModelOverride(base, { exploreModel: "e2" })).toEqual({ ...base, exploreModel: "e2" });
  });

  it("aigMetadataHeader tags gateway logs with session and role", () => {
    expect(aigMetadataHeader(undefined, "main")).toEqual({});
    expect(JSON.parse(aigMetadataHeader("s1", "subagent")["cf-aig-metadata"]!)).toEqual({ dodo_session: "s1", dodo_role: "subagent" });
  });
});
