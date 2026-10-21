/**
 * Anthropic subagent calls on AI Gateway go to the native Messages endpoint
 * because the unified `/compat` endpoint drops cache_control markers.
 * These tests pin the routing, the auth headers and the cache breakpoints.
 */
import { generateText, jsonSchema, tool } from "ai";
import { generateStructured } from "../src/structured-output";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  addAnthropicMessagesCacheMarkers,
  anthropicNativeBaseURL,
  buildProviderForModel,
  pruneSubagentHistory,
} from "../src/subagent-runner";
import type { AppConfig, Env } from "../src/types";

const CC = { type: "ephemeral" };

describe("addAnthropicMessagesCacheMarkers", () => {
  it("marks system, last tool and the last block of the last message", () => {
    const out = addAnthropicMessagesCacheMarkers({
      model: "claude-haiku-4-5",
      system: "You are a search assistant.",
      tools: [{ name: "grep" }, { name: "read" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "find X" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "grep", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "hits" }] },
      ],
    });
    expect(out.system).toEqual([{ type: "text", text: "You are a search assistant.", cache_control: CC }]);
    const tools = out.tools as Array<Record<string, unknown>>;
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toEqual(CC);
    const msgs = out.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(msgs[0].content[0].cache_control).toBeUndefined();
    expect(msgs[2].content[0].cache_control).toEqual(CC);
  });

  it("wraps string message content and skips thinking blocks", () => {
    const out = addAnthropicMessagesCacheMarkers({
      messages: [
        { role: "user", content: "hi" },
      ],
    });
    expect((out.messages as Array<{ content: unknown }>)[0].content).toEqual([{ type: "text", text: "hi", cache_control: CC }]);

    const out2 = addAnthropicMessagesCacheMarkers({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "a" }, { type: "thinking", thinking: "t" }] },
      ],
    });
    const blocks = (out2.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
    expect(blocks[0].cache_control).toEqual(CC);
    expect(blocks[1].cache_control).toBeUndefined();
  });

  it("keeps the last-message breakpoint on pruned history, whose prefix is stable between cut moves", () => {
    const history = (steps: number) => [
      { role: "user" as const, content: "find X" },
      ...Array.from({ length: steps }, (_, i) => [
        { role: "assistant" as const, content: `step ${i}` },
        { role: "user" as const, content: `result ${i}` },
      ]).flat(),
    ];
    // window 2: 4 and 5 groups both drop 2, so step 5 extends step 4's prompt.
    const step4 = pruneSubagentHistory(history(4), 2);
    const step5 = pruneSubagentHistory(history(5), 2);
    expect(step4.length).toBeLessThan(history(4).length);
    expect(step5.slice(0, step4.length)).toEqual(step4);
    const out = addAnthropicMessagesCacheMarkers({ system: "SYS", messages: step4 });
    const last = (out.messages as Array<{ content: Array<Record<string, unknown>> }>).at(-1);
    expect(last?.content.at(-1)?.cache_control).toEqual(CC);
  });

  it("counts markers nested in tool_result content toward the 4-breakpoint limit", () => {
    const marked = { type: "text", text: "x", cache_control: CC };
    const out = addAnthropicMessagesCacheMarkers({
      system: "SYS",
      tools: [{ name: "grep" }],
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [marked, marked] }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: [marked] }] },
      ],
    });
    // 3 existing + system = 4; tools and the last message stay unmarked.
    expect((out.system as Array<Record<string, unknown>>)[0].cache_control).toEqual(CC);
    expect((out.tools as Array<Record<string, unknown>>)[0].cache_control).toBeUndefined();
  });

  it("never exceeds 4 breakpoints and leaves existing markers alone", () => {
    const marked = { type: "text", text: "x", cache_control: CC };
    const out = addAnthropicMessagesCacheMarkers({
      system: [marked, marked, marked],
      tools: [{ name: "a" }],
      messages: [{ role: "user", content: "hi" }],
    });
    const tools = out.tools as Array<Record<string, unknown>>;
    expect(tools[0].cache_control).toEqual(CC); // 4th and last slot
    expect((out.messages as Array<{ content: unknown }>)[0].content).toBe("hi");
  });
});

describe("anthropicNativeBaseURL", () => {
  it("maps an AI Gateway /compat URL to the native anthropic endpoint", () => {
    expect(
      anthropicNativeBaseURL({ activeGateway: "ai-gateway", aiGatewayBaseURL: "https://gateway.ai.cloudflare.com/v1/acc/gw/compat/" }),
    ).toBe("https://gateway.ai.cloudflare.com/v1/acc/gw/anthropic/v1");
  });
  it("is undefined off AI Gateway or for non-/compat URLs", () => {
    expect(anthropicNativeBaseURL({ activeGateway: "opencode", aiGatewayBaseURL: "https://x/v1/a/g/compat" })).toBeUndefined();
    expect(anthropicNativeBaseURL({ activeGateway: "ai-gateway", aiGatewayBaseURL: "https://proxy.example/v1" })).toBeUndefined();
    // A custom proxy that happens to end in /compat stays on the OpenAI-compatible path.
    expect(anthropicNativeBaseURL({ activeGateway: "ai-gateway", aiGatewayBaseURL: "https://proxy.example/compat" })).toBeUndefined();
  });
});

describe("buildProviderForModel routing", () => {
  afterEach(() => vi.unstubAllGlobals());

  const env = { AI_GATEWAY_KEY: "aig-key", OPENCODE_GATEWAY_TOKEN: "oc" } as unknown as Env;
  const config = {
    activeGateway: "ai-gateway",
    aiGatewayBaseURL: "https://gateway.ai.cloudflare.com/v1/acc/gw/compat",
    opencodeBaseURL: "https://opencode.example/v1",
  } as unknown as AppConfig;

  function captureFetch(response: unknown) {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
    });
    return calls;
  }

  const tools = { grep: tool({ description: "g", inputSchema: jsonSchema({ type: "object", properties: {} }) }) };

  it("sends anthropic/* on AI Gateway to the native endpoint with cache markers and no x-api-key", async () => {
    const calls = captureFetch({
      id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-4-5",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 4000 },
    });
    const provider = buildProviderForModel("anthropic/claude-haiku-4-5", config, env, "sess-1");
    await generateText({ model: provider.chatModel("anthropic/claude-haiku-4-5"), system: "SYS", prompt: "hi", tools });

    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.url).toBe("https://gateway.ai.cloudflare.com/v1/acc/gw/anthropic/v1/messages");
    expect(c.headers.get("cf-aig-authorization")).toBe("Bearer aig-key");
    expect(c.headers.has("x-api-key")).toBe(false);
    expect(JSON.parse(c.headers.get("cf-aig-metadata") ?? "{}")).toEqual({ dodo_session: "sess-1", dodo_role: "subagent" });
    expect(c.body.model).toBe("claude-haiku-4-5");
    expect((c.body.system as Array<Record<string, unknown>>).at(-1)?.cache_control).toEqual(CC);
    expect((c.body.tools as Array<Record<string, unknown>>).at(-1)?.cache_control).toEqual(CC);
    const last = (c.body.messages as Array<{ content: Array<Record<string, unknown>> }>).at(-1);
    expect(last?.content.at(-1)?.cache_control).toEqual(CC);
  });

  it("keeps non-Anthropic models and the OpenCode gateway on the OpenAI-compatible path", async () => {
    const completion = {
      id: "1", object: "chat.completion", created: 1, model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    let calls = captureFetch(completion);
    await generateText({ model: buildProviderForModel("@cf/moonshotai/kimi-k2.6", config, env).chatModel("@cf/moonshotai/kimi-k2.6"), prompt: "hi" });
    expect(calls[0].url).toBe("https://gateway.ai.cloudflare.com/v1/acc/gw/compat/chat/completions");

    calls = captureFetch(completion);
    const oc = { ...config, activeGateway: "opencode" } as AppConfig;
    await generateText({ model: buildProviderForModel("anthropic/claude-haiku-4-5", oc, env).chatModel("anthropic/claude-haiku-4-5"), prompt: "hi" });
    expect(calls[0].url).toBe("https://opencode.example/v1/chat/completions");
  });

  it("runs the structured coercion pass through the native endpoint", async () => {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(url), headers: new Headers(init?.headers), body });
      // @ai-sdk/anthropic either asks for native JSON output or forces a `json` tool.
      const tools = (body.tools as Array<{ name: string }> | undefined) ?? [];
      const content = tools.some((t) => t.name === "json")
        ? [{ type: "tool_use", id: "t1", name: "json", input: { answer: "42" } }]
        : [{ type: "text", text: JSON.stringify({ answer: "42" }) }];
      return new Response(
        JSON.stringify({
          id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-4-5", content,
          stop_reason: content[0].type === "tool_use" ? "tool_use" : "end_turn",
          usage: { input_tokens: 5, output_tokens: 3 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const provider = buildProviderForModel("anthropic/claude-haiku-4-5", config, env, "sess-1");
    const out = await generateStructured<{ answer: string }>({
      modelId: "anthropic/claude-haiku-4-5",
      model: provider.chatModel("anthropic/claude-haiku-4-5"),
      schema: z.object({ answer: z.string() }),
      prompt: "distill",
      maxRetries: 0,
    });
    expect(out).toMatchObject({ ok: true, data: { answer: "42" } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://gateway.ai.cloudflare.com/v1/acc/gw/anthropic/v1/messages");
    expect(calls[0].headers.has("x-api-key")).toBe(false);
    expect(calls[0].headers.get("cf-aig-authorization")).toBe("Bearer aig-key");
  });
});
