/**
 * Anthropic subagent calls on AI Gateway go through createAI over the `AI`
 * binding (native Messages wire) because the unified `/compat` endpoint drops
 * cache_control markers. These tests pin the routing, the absence of gateway
 * keys, the log metadata and the cache breakpoints.
 */
import { generateText, jsonSchema, tool } from "ai";
import { generateStructured } from "../src/structured-output";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { bindingGatewayId, runWithLocalSignal } from "../src/cloudflare-ai";
import { fakeAIBinding } from "./helpers/fake-ai-binding";
import { addAnthropicCacheOptions, buildProviderForModel, pruneSubagentHistory } from "../src/subagent-runner";
import type { AppConfig, Env } from "../src/types";

const CC = { type: "ephemeral" };

const anthropicReply = (extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-4-5",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 4000 },
      ...extra,
    }),
    { headers: { "content-type": "application/json" } },
  );

describe("bindingGatewayId", () => {
  const env = { AI: {} as Ai, CLOUDFLARE_ACCOUNT_ID: "acc" };
  it("reads the gateway id from an AI Gateway /compat URL in the Worker's account", () => {
    expect(bindingGatewayId({ activeGateway: "ai-gateway", aiGatewayBaseURL: "https://gateway.ai.cloudflare.com/v1/acc/gw/compat/" }, env)).toBe("gw");
  });
  it("is undefined off AI Gateway, without a binding, for other URLs, or for another account", () => {
    expect(bindingGatewayId({ activeGateway: "opencode", aiGatewayBaseURL: "https://gateway.ai.cloudflare.com/v1/acc/gw/compat" }, env)).toBeUndefined();
    expect(bindingGatewayId({ activeGateway: "ai-gateway", aiGatewayBaseURL: "https://gateway.ai.cloudflare.com/v1/acc/gw/compat" }, { AI: undefined as unknown as Ai })).toBeUndefined();
    expect(bindingGatewayId({ activeGateway: "ai-gateway", aiGatewayBaseURL: "https://proxy.example/v1" }, env)).toBeUndefined();
    // A custom proxy that happens to end in /compat stays on the OpenAI-compatible path.
    expect(bindingGatewayId({ activeGateway: "ai-gateway", aiGatewayBaseURL: "https://proxy.example/v1/acc/gw/compat" }, env)).toBeUndefined();
    // The binding only reaches the Worker's own account; unknown account fails closed.
    expect(bindingGatewayId({ activeGateway: "ai-gateway", aiGatewayBaseURL: "https://gateway.ai.cloudflare.com/v1/acc/gw/compat" }, { AI: {} as Ai })).toBeUndefined();
    expect(bindingGatewayId({ activeGateway: "ai-gateway", aiGatewayBaseURL: "https://gateway.ai.cloudflare.com/v1/other/gw/compat" }, env)).toBeUndefined();
  });
});

describe("addAnthropicCacheOptions", () => {
  const cache = { anthropic: { cacheControl: CC } };
  it("marks the system message, the last tool and the last message", () => {
    const out = addAnthropicCacheOptions({
      prompt: [
        { role: "system", content: "SYS" },
        { role: "user", content: [{ type: "text", text: "find X" }] },
        { role: "user", content: [{ type: "text", text: "more" }] },
      ],
      tools: [
        { type: "function", name: "a", inputSchema: {} },
        { type: "function", name: "b", inputSchema: {} },
      ],
    } as never);
    expect(out.prompt[0].providerOptions).toEqual(cache);
    expect(out.prompt[1].providerOptions).toBeUndefined();
    expect(out.prompt[2].providerOptions).toEqual(cache);
    const tools = out.tools as Array<{ providerOptions?: unknown }>;
    expect(tools[0].providerOptions).toBeUndefined();
    expect(tools[1].providerOptions).toEqual(cache);
  });

  it("marks the last cacheable part when the last message ends in reasoning", () => {
    const out = addAnthropicCacheOptions({
      prompt: [{ role: "assistant", content: [{ type: "text", text: "a" }, { type: "reasoning", text: "t" }] }],
    } as never);
    const msg = out.prompt[0] as { providerOptions?: unknown; content: Array<{ providerOptions?: unknown }> };
    expect(msg.providerOptions).toBeUndefined();
    expect(msg.content[0].providerOptions).toEqual(cache);
    expect(msg.content[1].providerOptions).toBeUndefined();
  });

  it("pruned history keeps a stable prefix between cut moves, so the last-message breakpoint is read next step", () => {
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
  });

  it("counts existing breakpoints toward Anthropic's limit of 4 and keeps them", () => {
    const marked = { type: "text", text: "x", providerOptions: cache };
    const out = addAnthropicCacheOptions({
      prompt: [
        { role: "system", content: "SYS" },
        { role: "user", content: [marked, marked, marked] },
        { role: "user", content: [{ type: "text", text: "last" }] },
      ],
      tools: [{ type: "function", name: "a", inputSchema: {} }],
    } as never);
    // 3 existing + system = 4; tools and the last message stay unmarked.
    expect(out.prompt[0].providerOptions).toEqual(cache);
    expect((out.tools as Array<{ providerOptions?: unknown }>)[0].providerOptions).toBeUndefined();
    expect(out.prompt[2].providerOptions).toBeUndefined();
  });
});

describe("buildProviderForModel routing", () => {
  afterEach(() => vi.unstubAllGlobals());

  const config = {
    activeGateway: "ai-gateway",
    aiGatewayBaseURL: "https://gateway.ai.cloudflare.com/v1/acc/gw/compat",
    opencodeBaseURL: "https://opencode.example/v1",
  } as unknown as AppConfig;
  const envWith = (AI: Ai) => ({ AI, AI_GATEWAY_KEY: "aig-key", OPENCODE_GATEWAY_TOKEN: "oc", CLOUDFLARE_ACCOUNT_ID: "acc" }) as unknown as Env;

  function captureFetch(response: unknown) {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
    });
    return calls;
  }

  const tools = { grep: tool({ description: "g", inputSchema: jsonSchema({ type: "object", properties: {} }) }) };

  it("sends anthropic/* on AI Gateway through the AI binding with cache markers and no gateway key", async () => {
    const fetchCalls = captureFetch({});
    const { binding, calls } = fakeAIBinding(() => anthropicReply());
    const provider = buildProviderForModel("anthropic/claude-haiku-4-5", config, envWith(binding), "sess-1");
    const res = await generateText({ model: provider.chatModel("anthropic/claude-haiku-4-5"), system: "SYS", prompt: "hi", tools });

    expect(res.text).toBe("ok");
    expect(fetchCalls).toHaveLength(0);
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.gatewayId).toBe("gw");
    expect(c.request.provider).toBe("anthropic");
    expect(c.request.endpoint).toBe("v1/messages");
    const headerNames = Object.keys(c.request.headers).map((h) => h.toLowerCase());
    expect(headerNames).not.toContain("x-api-key");
    expect(headerNames).not.toContain("cf-aig-authorization");
    expect(JSON.stringify(c)).not.toContain("aig-key");
    expect((c.options.gateway as { metadata?: unknown }).metadata).toEqual({ dodo_session: "sess-1", dodo_role: "subagent" });
    const body = c.request.query;
    expect(body.model).toBe("claude-haiku-4-5");
    expect((body.system as Array<Record<string, unknown>>).at(-1)?.cache_control).toEqual(CC);
    expect((body.tools as Array<Record<string, unknown>>).at(-1)?.cache_control).toEqual(CC);
    const last = (body.messages as Array<{ content: Array<Record<string, unknown>> }>).at(-1);
    expect(last?.content.at(-1)?.cache_control).toEqual(CC);
  });

  it("keeps non-Anthropic models, the OpenCode gateway, and a binding-less env on the OpenAI-compatible path", async () => {
    const completion = {
      id: "1", object: "chat.completion", created: 1, model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const { binding, calls: bindingCalls } = fakeAIBinding(() => anthropicReply());
    // COMPAT_VIA_BINDING=0: /compat over HTTP with the key (by default it goes over the binding, see compat-binding-unit.test.ts).
    const httpEnv = { ...envWith(binding), COMPAT_VIA_BINDING: "0" } as Env;
    let calls = captureFetch(completion);
    await generateText({ model: buildProviderForModel("@cf/moonshotai/kimi-k2.6", config, httpEnv).chatModel("@cf/moonshotai/kimi-k2.6"), prompt: "hi" });
    expect(calls[0].url).toBe("https://gateway.ai.cloudflare.com/v1/acc/gw/compat/chat/completions");
    expect(calls[0].headers.get("cf-aig-authorization")).toBe("Bearer aig-key");

    calls = captureFetch(completion);
    const oc = { ...config, activeGateway: "opencode" } as AppConfig;
    await generateText({ model: buildProviderForModel("anthropic/claude-haiku-4-5", oc, envWith(binding)).chatModel("anthropic/claude-haiku-4-5"), prompt: "hi" });
    expect(calls[0].url).toBe("https://opencode.example/v1/chat/completions");

    calls = captureFetch(completion);
    await generateText({ model: buildProviderForModel("anthropic/claude-haiku-4-5", config, envWith(undefined as unknown as Ai)).chatModel("anthropic/claude-haiku-4-5"), prompt: "hi" });
    expect(calls[0].url).toBe("https://gateway.ai.cloudflare.com/v1/acc/gw/compat/chat/completions");
    expect(bindingCalls).toHaveLength(0);
  });

  it("runs the structured coercion pass through the binding", async () => {
    const { binding, calls } = fakeAIBinding((body) => {
      // @ai-sdk/anthropic either asks for native JSON output or forces a `json` tool.
      const forced = ((body.tools as Array<{ name: string }> | undefined) ?? []).some((t) => t.name === "json");
      const content = forced
        ? [{ type: "tool_use", id: "t1", name: "json", input: { answer: "42" } }]
        : [{ type: "text", text: JSON.stringify({ answer: "42" }) }];
      return anthropicReply({ content, stop_reason: forced ? "tool_use" : "end_turn", usage: { input_tokens: 5, output_tokens: 3 } });
    });
    const provider = buildProviderForModel("anthropic/claude-haiku-4-5", config, envWith(binding), "sess-1");
    const out = await generateStructured<{ answer: string }>({
      modelId: "anthropic/claude-haiku-4-5",
      model: provider.chatModel("anthropic/claude-haiku-4-5"),
      schema: z.object({ answer: z.string() }),
      prompt: "distill",
      maxRetries: 0,
    });
    expect(out).toMatchObject({ ok: true, data: { answer: "42" } });
    expect(calls).toHaveLength(1);
    expect(calls[0].request.provider).toBe("anthropic");
  });
});

describe("runWithLocalSignal", () => {
  it("rejects as AbortError when run() aborts the signal synchronously, and cancels the late body", async () => {
    const controller = new AbortController();
    let cancelled = false;
    let resolveLate!: (r: Response) => void;
    const run = () => {
      controller.abort("stop");
      return new Promise<Response>((r) => (resolveLate = r));
    };
    await expect(runWithLocalSignal(run, {}, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    resolveLate(new Response(new ReadableStream({ cancel: () => void (cancelled = true) })));
    await new Promise((r) => setTimeout(r, 0));
    expect(cancelled).toBe(true);
  });

  it("never passes the signal to the binding call", async () => {
    let seen: Record<string, unknown> | undefined;
    const run = async (_req: unknown, options?: Record<string, unknown>) => {
      seen = options;
      return new Response("ok");
    };
    const res = await runWithLocalSignal(run, {}, { signal: new AbortController().signal, gateway: { id: "gw" } });
    expect(await res.text()).toBe("ok");
    expect(seen).toEqual({ gateway: { id: "gw" } });
  });
});
