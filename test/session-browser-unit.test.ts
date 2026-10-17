/**
 * browser_execute on the agents SDK Browser (src/browser/session-browser.ts):
 * result-shape compat with pi-durable >= 1.1, screenshot hand-off, gating,
 * and the Live View route.
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

vi.mock("../src/agentic", async () => await import("./helpers/agentic-mock"));
vi.mock("../src/pi/models", async () => await import("./helpers/pi-models-mock"));

const fakeRun = vi.fn();
vi.mock("agents/browser/pi", () => ({
  browserTool: (opts: { name?: string }) => ({
    name: opts.name ?? "browser",
    description: "drive the browser",
    parameters: { type: "object", properties: { code: { type: "string" } } },
    executionMode: "sequential",
    replay: "unsafe",
    execute: (...a: unknown[]) => fakeRun(...a),
  }),
}));

const { createBrowserExecuteTool, BROWSER_TOOL_NAME } = await import("../src/browser/session-browser");
const api = { callId: "call-1", conversationId: "c1" } as never;

describe("createBrowserExecuteTool", () => {
  it("maps the SDK's `content` result to pi-durable's `output` and hands screenshots over", async () => {
    fakeRun.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"status":"completed"}' }, { type: "image", data: "AAAA", mimeType: "image/jpeg" }],
      details: { executionId: "e1", status: "completed" },
    });
    const shots: unknown[] = [];
    const tool = createBrowserExecuteTool({
      ctx: {} as DurableObjectState,
      browser: {} as never,
      loader: {} as WorkerLoader,
      onScreenshot: async (callId, image) => void shots.push({ callId, ...image }),
    });
    expect(tool.name).toBe(BROWSER_TOOL_NAME);
    expect(tool.replay).toBe("unsafe");
    const r = await tool.execute({ code: "async () => 1" } as never, api, {} as never);
    expect(r.output).toEqual([{ type: "text", text: '{"status":"completed"}' }, { type: "image", data: "AAAA", mimeType: "image/jpeg" }]);
    expect(r.details).toEqual({ executionId: "e1", status: "completed" });
    expect(r.isError).toBeUndefined();
    expect(shots).toEqual([{ callId: "call-1", mediaType: "image/jpeg", data: "AAAA" }]);
  });

  it("passes isError through and survives a failing screenshot upload", async () => {
    fakeRun.mockResolvedValueOnce({ output: [{ type: "image", data: "BB", mimeType: "image/png" }], isError: true });
    const tool = createBrowserExecuteTool({
      ctx: {} as DurableObjectState, browser: {} as never, loader: {} as WorkerLoader,
      onScreenshot: async () => { throw new Error("R2 down"); },
    });
    const r = await tool.execute({ code: "x" } as never, api, {} as never);
    expect(r.isError).toBe(true);
    expect(r.output).toHaveLength(1);
  });
});

describe("CodingAgent browser wiring", () => {
  const typedEnv = env as unknown as Env;
  const inDO = runInDurableObject as unknown as <T>(stub: unknown, fn: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
  const setMeta = (state: DurableObjectState, key: string, value: string) =>
    state.storage.sql.exec("INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, 1)", key, value);

  it("offers browser_execute only to admin-owned sessions with the browser on", async () => {
    const stub = await getAgentByName(typedEnv.CODING_AGENT as never, crypto.randomUUID());
    await inDO(stub, async (instance, state) => {
      expect(instance.browser).toBeDefined();
      setMeta(state, "owner_email", typedEnv.ADMIN_EMAIL!);
      setMeta(state, "browser_enabled", "true");
      expect(instance.piNativeTools().map((t: { name: string }) => t.name)).toEqual(["browser_execute"]);
      setMeta(state, "browser_enabled", "false");
      expect(instance.piNativeTools()).toEqual([]);
      setMeta(state, "browser_enabled", "true");
      setMeta(state, "owner_email", "someone@else.test");
      expect(instance.piNativeTools()).toEqual([]);
    });
  });

  it("screenshots land in message_attachments under the tool call", async () => {
    const stub = await getAgentByName(typedEnv.CODING_AGENT as never, crypto.randomUUID());
    await inDO(stub, async (instance, state) => {
      const sid = crypto.randomUUID();
      setMeta(state, "session_id", sid);
      setMeta(state, "owner_email", typedEnv.ADMIN_EMAIL!);
      setMeta(state, "browser_enabled", "true");
      fakeRun.mockResolvedValueOnce({ content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] });
      const [tool] = instance.piNativeTools();
      await tool.execute({ code: "x" }, { callId: "call-9", conversationId: "c" }, {});
      const rows = Array.from(state.storage.sql.exec("SELECT tool_call_id, media_type, source FROM message_attachments"));
      expect(rows).toEqual([{ tool_call_id: "call-9", media_type: "image/png", source: "tool" }]);
      expect(instance._toolAttachments.get("call-9")).toHaveLength(1);
    });
  });

  it("GET /browser/live is 404 until a browser runs", async () => {
    const stub = (await getAgentByName(typedEnv.CODING_AGENT as never, crypto.randomUUID())) as unknown as { fetch: (r: Request) => Promise<Response> };
    const res = await stub.fetch(new Request("https://dodo.example/browser/live"));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/No browser running/);
  });
});
