/**
 * Anthropic subagent calls on AI Gateway go to the native Messages endpoint
 * because the unified `/compat` endpoint drops cache_control markers.
 * These tests pin the routing, the auth headers and the cache breakpoints.
 */
import { generateText, jsonSchema, tool } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("skips the last-message breakpoint once history is pruned (it would never be read)", () => {
    const history = [
      { role: "user" as const, content: "find X" },
      ...Array.from({ length: 6 }, (_, i) => [
        { role: "assistant" as const, content: `step ${i}` },
        { role: "user" as const, content: `result ${i}` },
      ]).flat(),
    ];
    const pruned = pruneSubagentHistory(history, 2);
    expect(pruned.length).toBeLessThan(history.length);
    const out = addAnthropicMessagesCacheMarkers({ system: "SYS", messages: pruned });
    expect((out.system as Array<Record<string, unknown>>)[0].cache_control).toEqual(CC);
    expect(JSON.stringify(out.messages)).not.toContain("cache_control");
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
    const provider = buildProviderForModel("anthropic/claude-haiku-4-5", config, env);
    await generateText({ model: provider.chatModel("anthropic/claude-haiku-4-5"), system: "SYS", prompt: "hi", tools });

    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.url).toBe("https://gateway.ai.cloudflare.com/v1/acc/gw/anthropic/v1/messages");
    expect(c.headers.get("cf-aig-authorization")).toBe("Bearer aig-key");
    expect(c.headers.has("x-api-key")).toBe(false);
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
});
