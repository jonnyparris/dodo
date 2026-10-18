/**
 * Agent session tools (schedule_prompt, list_schedules, cancel_schedule,
 * request_user_input) against a real CodingAgent, plus the completion
 * webhook ("doorbell") that MCP callers pass as send_prompt callbackUrl.
 */
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { buildSessionTools, checkScheduleSpec, toScheduleSpec } from "../src/tools/session-tools";
import { checkCallbackUrl, postCompletionWebhook } from "../src/completion-webhook";

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
const send = (path: string, body: unknown) =>
  call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function newSession(): Promise<string> {
  const res = await call("/session", { method: "POST" });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
}
const stubFor = (id: string) => getAgentByName(typedEnv.CODING_AGENT as never, id);

async function waitForPrompt(id: string, promptId: string, ms = 3000) {
  for (let i = 0; i < ms / 10; i++) {
    const { prompts } = await json<{ prompts: Array<{ id: string; status: string }> }>(await call(`/session/${id}/prompts`));
    const p = prompts.find((x) => x.id === promptId);
    if (p && !["queued", "running"].includes(p.status)) return p;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("prompt never finished");
}

type Exec = (args: unknown) => Promise<any>;
const exec = (tools: Record<string, unknown>, name: string): Exec =>
  (args) => (tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, { toolCallId: "t", messages: [] }) as Promise<any>;

afterEach(() => vi.restoreAllMocks());

describe("schedule_prompt / list_schedules / cancel_schedule", () => {
  it("creates a real cron job the UI lists, and cancels it", async () => {
    const id = await newSession();
    await send(`/session/${id}/message`, { content: "hello" }); // owner + metadata
    const stub = await stubFor(id);
    const created = await inDO(stub, async (instance) => {
      const tools = buildSessionTools(instance.sessionToolHost());
      const once = await exec(tools, "schedule_prompt")({ description: "check trains", prompt: "Check the 08:10 train", when: { inSeconds: 3600 } });
      const daily = await exec(tools, "schedule_prompt")({ description: "weekday digest", prompt: "Digest", when: { cron: "0 7 * * 1-5" } });
      const both = await exec(tools, "schedule_prompt")({ description: "x", prompt: "y", when: { inSeconds: 5, cron: "0 7 * * *" } });
      const past = await exec(tools, "schedule_prompt")({ description: "x", prompt: "y", when: { at: "2001-01-01T00:00:00Z" } });
      const listed = await exec(tools, "list_schedules")({});
      return { once, daily, both, past, listed };
    });
    expect(created.once).toMatchObject({ scheduled: true, type: "delayed" });
    expect(created.daily).toMatchObject({ scheduled: true, type: "cron" });
    expect(created.both.error).toMatch(/exactly one/);
    expect(created.past.error).toMatch(/in the past/);
    expect(created.listed.schedules.map((s: { description: string }) => s.description).sort()).toEqual(["check trains", "weekday digest"]);

    // Same jobs over HTTP (what the UI shows).
    const { jobs } = await json<{ jobs: Array<{ id: string; description: string }> }>(await call(`/session/${id}/cron`));
    expect(jobs.map((j) => j.id).sort()).toEqual([created.once.id, created.daily.id].sort());

    const cancelled = await inDO(stub, async (instance) => {
      const tools = buildSessionTools(instance.sessionToolHost());
      const ok = await exec(tools, "cancel_schedule")({ id: created.once.id });
      const unknown = await exec(tools, "cancel_schedule")({ id: "nope" });
      return { ok, unknown, left: instance.listCronJobs().map((j: { id: string }) => j.id) };
    });
    expect(cancelled.ok).toMatchObject({ cancelled: true });
    expect(cancelled.unknown.error).toMatch(/No schedule/);
    expect(cancelled.left).toEqual([created.daily.id]);
  });

  it("a one-off that already fired drops out of the list instead of showing id 'missing'", async () => {
    const id = await newSession();
    await send(`/session/${id}/message`, { content: "hello" });
    const stub = await stubFor(id);
    const left = await inDO(stub, async (instance) => {
      const tools = buildSessionTools(instance.sessionToolHost());
      const r = await exec(tools, "schedule_prompt")({ description: "once", prompt: "p", when: { inSeconds: 60 } });
      // What the SDK does after a one-off runs: the schedule row is gone.
      await instance.cancelSchedule(r.id);
      return instance.listCronJobs();
    });
    expect(left).toEqual([]);
  });
});

describe("request_user_input", () => {
  it("marks the session as needing input until the next prompt starts", async () => {
    const id = await newSession();
    await send(`/session/${id}/message`, { content: "hello" });
    const stub = await stubFor(id);
    const r = await inDO(stub, async (instance) =>
      exec(buildSessionTools(instance.sessionToolHost()), "request_user_input")({ kind: "login", reason: "Sign in to github.com, then reply done" }),
    );
    expect(r).toMatchObject({ ok: true, liveView: false });

    const before = await json<{ needsInput: { kind: string; reason: string; liveView: boolean } | null }>(await call(`/session/${id}/prompts`));
    expect(before.needsInput).toMatchObject({ kind: "login", reason: "Sign in to github.com, then reply done", liveView: false });

    const { promptId } = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "done" }));
    await waitForPrompt(id, promptId);
    const after = await json<{ needsInput: unknown }>(await call(`/session/${id}/prompts`));
    expect(after.needsInput).toBeNull();
  });
});

describe("completion webhook", () => {
  it("rings callbackUrl with ids and status only when the prompt finishes, and keeps it for later prompts", async () => {
    const hits: Array<{ url: string; body: any }> = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://hooks.example/")) {
        hits.push({ url, body: JSON.parse(String(init?.body)) });
        return new Response("ok");
      }
      return realFetch(input as RequestInfo, init);
    });

    const id = await newSession();
    const bad = await send(`/session/${id}/prompt`, { content: "x", callbackUrl: "http://hooks.example/a" });
    expect(bad.status).toBe(400);

    const first = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "first", callbackUrl: "https://hooks.example/dodo/abc" }));
    await waitForPrompt(id, first.promptId);
    const second = await json<{ promptId: string }>(await send(`/session/${id}/prompt`, { content: "second" }));
    await waitForPrompt(id, second.promptId);
    for (let i = 0; i < 100 && hits.length < 2; i++) await new Promise((r) => setTimeout(r, 10));

    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      url: "https://hooks.example/dodo/abc",
      body: { event: "prompt.finished", sessionId: id, promptId: first.promptId, status: "completed", needsInput: false },
    });
    expect(hits[1]!.body.promptId).toBe(second.promptId);
    // A doorbell, not a delivery: no output in the body.
    expect(JSON.stringify(hits)).not.toMatch(/first|second/);
  });
});

describe("pure helpers", () => {
  it("toScheduleSpec / checkScheduleSpec", () => {
    expect(toScheduleSpec({ everySeconds: 300 })).toEqual({ type: "interval", intervalSeconds: 300 });
    expect(toScheduleSpec({ at: "2030-01-01T08:00:00+01:00" })).toEqual({ type: "scheduled", date: "2030-01-01T07:00:00.000Z" });
    expect(checkScheduleSpec({ type: "interval", intervalSeconds: 10 })).toMatch(/≥ 60/);
    expect(checkScheduleSpec({ type: "cron", cron: "* * * * *" })).toMatch(/every minute/);
    expect(checkScheduleSpec({ type: "cron", cron: "0 8 * *" })).toMatch(/5 fields/);
    expect(checkScheduleSpec({ type: "cron", cron: "*/15 * * * *" })).toBeNull();
  });

  it("checkCallbackUrl only takes public https URLs", () => {
    expect(checkCallbackUrl("https://signal-agent.example.workers.dev/dodo-doorbell/s/t")).toBeNull();
    expect(checkCallbackUrl("")).toBeNull();
    expect(checkCallbackUrl("http://x.example/")).toMatch(/https/);
    expect(checkCallbackUrl("https://localhost/")).toMatch(/public/);
    expect(checkCallbackUrl("https://10.0.0.1/")).toMatch(/public/);
    expect(checkCallbackUrl("https://u:p@x.example/")).toMatch(/credentials/);
  });

  it("postCompletionWebhook retries a 5xx once, not a 4xx", async () => {
    const statuses = [503, 200];
    const f = vi.fn(async () => new Response("", { status: statuses.shift()! }));
    await postCompletionWebhook("https://h.example/", "{}", f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(2);
    const g = vi.fn(async () => new Response("", { status: 404 }));
    await expect(postCompletionWebhook("https://h.example/", "{}", g as unknown as typeof fetch)).rejects.toThrow(/404/);
    expect(g).toHaveBeenCalledTimes(1);
  });
});
