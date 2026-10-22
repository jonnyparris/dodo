import { runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/types";
import { env } from "cloudflare:workers";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { tool, zodSchema } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { entriesToMessages, PiEngine, type PiEngineHost } from "../src/pi/engine";
import { buildToolsExtension, modelOutputToContent, REPLAY_SAFE_TOOLS } from "../src/pi/tools";
import { agentModelRef, CREATE_AI_PROVIDER_ID, createAIGatewayId, dodoModel, gatewayHeaders, modelCost, setDodoProvider } from "../src/pi/models";
import { fakeAIBinding } from "./helpers/fake-ai-binding";
import { calculateCost, createModels } from "@earendil-works/pi-ai/models";

function host(storage: DurableObjectStorage, faux: ReturnType<typeof fauxProvider>, events: Array<{ type: string; data: unknown }>): PiEngineHost {
  return {
    storage,
    configureModels: (models) => models.setProvider(faux.provider),
    modelRef: () => ({ provider: "faux", modelId: "faux-1" }),
    systemPrompt: () => "You are Dodo.",
    emit: (e) => events.push(e),
    log: () => {},
  };
}

const entry = (text: string) => ({ messageId: `u-${text}`, text, authorEmail: "a@b.c", createdAt: 1 });

describe("PiEngine", () => {
  it("runs Dodo AI SDK tools, bridges events, and lists messages", async () => {
    const stub = (env as unknown as Env).CODING_AGENT.get((env as unknown as Env).CODING_AGENT.idFromName("pi-engine-1"));
    await runInDurableObject(stub, async (_i, state) => {
      const faux = fauxProvider();
      faux.setResponses([
        fauxAssistantMessage([fauxText("Checking. "), fauxToolCall("git_status", { dir: "/repo" }, { id: "c1" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("Clean tree.")]),
      ]);
      const seen: unknown[] = [];
      const tools = {
        git_status: tool({
          description: "status",
          inputSchema: zodSchema(z.object({ dir: z.string().optional() })),
          execute: async (input) => {
            seen.push(input);
            return { clean: true };
          },
        }),
      };
      const events: Array<{ type: string; data: unknown }> = [];
      const engine = new PiEngine(host(state.storage, faux, events));
      const result = await engine.run({
        promptId: "p1",
        prepare: async () => ({ content: "status?", entry: entry("status?") }),
        tools: await buildToolsExtension(tools),
      });
      expect(result.status).toBe("done");
      expect(result.text).toBe("Clean tree.");
      expect(result.steps).toBe(2);
      expect(result.toolCalls).toEqual(["git_status"]);
      expect(seen).toEqual([{ dir: "/repo" }]);
      const types = events.map((e) => e.type);
      expect(types).toContain("tool_call");
      expect(types).toContain("tool_result");
      const toolResult = events.find((e) => e.type === "tool_result")?.data as { output: string };
      expect(toolResult.output).toBe('{"clean":true}');
      const streamed = events.filter((e) => e.type === "text_delta").map((e) => (e.data as { delta: string }).delta).join("");
      expect(streamed).toBe("Checking. Clean tree.");

      const messages = entriesToMessages(await engine.entries());
      expect(messages.map((m) => [m.role, m.content])).toEqual([
        ["user", "status?"],
        ["assistant", "Checking. \n\nClean tree."],
      ]);
      expect(messages[0]?.id).toBe("u-status?");
      expect(messages[1]?.id).toBe(result.assistantMessageId);
      await engine.close();
    });
  });

  it("tokenInput counts cache reads and writes (as the AI SDK did on Think)", async () => {
    const stub = (env as unknown as Env).CODING_AGENT.get((env as unknown as Env).CODING_AGENT.idFromName("pi-engine-usage"));
    await runInDurableObject(stub, async (_i, state) => {
      const faux = fauxProvider();
      faux.setResponses([fauxAssistantMessage([fauxText("one")]), fauxAssistantMessage([fauxText("two")])]);
      const engine = new PiEngine(host(state.storage, faux, []));
      const tools = await buildToolsExtension({});
      const first = await engine.run({ promptId: "u1", prepare: async () => ({ content: "hello", entry: entry("hello") }), tools });
      const second = await engine.run({ promptId: "u2", prepare: async () => ({ content: "again", entry: entry("again") }), tools });
      // Single-step turns: tokens in = the whole prompt, cached or not.
      expect(first.tokenInput).toBe(first.contextTokens);
      expect(second.tokenInput).toBe(second.contextTokens);
      expect(second.tokenInput).toBeGreaterThan(first.tokenInput);
      await engine.close();
    });
  });

  it("re-running the same prompt after a restart reattaches instead of resubmitting", async () => {
    const stub = (env as unknown as Env).CODING_AGENT.get((env as unknown as Env).CODING_AGENT.idFromName("pi-engine-2"));
    await runInDurableObject(stub, async (_i, state) => {
      const faux = fauxProvider();
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("git_push", {}, { id: "c1" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("after restart")]),
      ]);
      let pushes = 0;
      let entered: () => void = () => {};
      const enteredP = new Promise<void>((r) => { entered = r; });
      const tools = {
        git_push: tool({
          description: "push",
          inputSchema: zodSchema(z.object({})),
          execute: async (_input, { abortSignal }) => {
            pushes++;
            entered();
            await new Promise<void>((resolve) => abortSignal?.addEventListener("abort", () => resolve()));
            return "pushed";
          },
        }),
      };
      let prepared = 0;
      const prepare = async () => { prepared++; return { content: "push it", entry: entry("push it") }; };

      const first = new PiEngine(host(state.storage, faux, []));
      const running = first.run({ promptId: "p1", prepare, tools: await buildToolsExtension(tools) });
      await enteredP;
      await first.close(); // eviction
      await running.catch(() => {});

      const second = new PiEngine(host(state.storage, faux, []));
      const result = await second.run({ promptId: "p1", prepare, tools: await buildToolsExtension(tools) });
      expect(prepared).toBe(1); // user turn not re-prepared / re-emitted
      expect(result.recovered).toBe(true);
      expect(result.status).toBe("done");
      expect(result.text).toBe("after restart");
      // git_push is replay-unsafe: it is NOT rerun; the model got an `interrupted` result.
      expect(pushes).toBe(1);
      await second.close();
    });
  });

  it("abort settles the prompt as unanswered", async () => {
    const stub = (env as unknown as Env).CODING_AGENT.get((env as unknown as Env).CODING_AGENT.idFromName("pi-engine-3"));
    await runInDurableObject(stub, async (_i, state) => {
      const faux = fauxProvider();
      faux.setResponses([fauxAssistantMessage([fauxToolCall("slow", {}, { id: "c1" })], { stopReason: "toolUse" })]);
      let entered: () => void = () => {};
      const enteredP = new Promise<void>((r) => { entered = r; });
      const tools = {
        slow: tool({
          description: "slow",
          inputSchema: zodSchema(z.object({})),
          execute: async (_i, { abortSignal }) => {
            entered();
            await new Promise<void>((resolve) => abortSignal?.addEventListener("abort", () => resolve()));
            return "x";
          },
        }),
      };
      const engine = new PiEngine(host(state.storage, faux, []));
      const controller = new AbortController();
      const running = engine.run({
        promptId: "p1",
        prepare: async () => ({ content: "go", entry: entry("go") }),
        tools: await buildToolsExtension(tools),
        signal: controller.signal,
      });
      await enteredP;
      controller.abort();
      const result = await running;
      expect(result.status).toBe("unanswered");
      await engine.close();
    });
  });
});

describe("pi adapters", () => {
  it("maps AI SDK content output, including images", () => {
    const { content } = modelOutputToContent({
      type: "content",
      value: [{ type: "text", text: "shot" }, { type: "media", data: "data:image/png;base64,AAAA", mediaType: "image/png" }],
    });
    expect(content).toEqual([{ type: "text", text: "shot" }, { type: "image", data: "AAAA", mimeType: "image/png" }]);
  });

  it("only read-only tools replay", () => {
    expect(REPLAY_SAFE_TOOLS.has("read")).toBe(true);
    expect(REPLAY_SAFE_TOOLS.has("git_push")).toBe(false);
    expect(REPLAY_SAFE_TOOLS.has("write")).toBe(false);
  });

  it("maps gateway config to an openai-completions model with Anthropic cache markers", () => {
    const m = dodoModel("anthropic/claude-sonnet-4-6", { activeGateway: "ai-gateway", opencodeBaseURL: "", aiGatewayBaseURL: "https://gw/v1/" }, { AI_GATEWAY_KEY: "k" } as never);
    expect(m.baseUrl).toBe("https://gw/v1");
    expect(m.contextWindow).toBe(1_000_000);
    expect(m.api).toBe("openai-completions");
    // Cache prices come from pi-ai's catalog on the OpenAI-compatible path too
    // (were 0). Writes only apply if the gateway reports cache_write_tokens.
    expect(m.cost.cacheRead).toBeCloseTo(0.3);
    expect(m.cost.cacheWrite).toBeCloseTo(3.75);
    expect((m.compat as { cacheControlFormat?: string } | undefined)?.cacheControlFormat).toBe("anthropic");
    const h = gatewayHeaders({ activeGateway: "ai-gateway", opencodeBaseURL: "", aiGatewayBaseURL: "" }, { AI_GATEWAY_KEY: "k" } as never);
    expect(h["cf-aig-authorization"]).toBe("Bearer k");
    expect(h.Authorization).toBeNull();
    const w = dodoModel("@cf/moonshotai/kimi-k2.6", { activeGateway: "ai-gateway", opencodeBaseURL: "", aiGatewayBaseURL: "https://gw/v1" }, {} as never);
    expect(w.id).toBe("workers-ai/@cf/moonshotai/kimi-k2.6");
    expect((w.compat as { cacheControlFormat?: string } | undefined)?.cacheControlFormat).toBeUndefined();
  });

  it("prices cache reads and long-context tiers from pi-ai's vendor catalog", () => {
    const config = { activeGateway: "ai-gateway" as const, opencodeBaseURL: "", aiGatewayBaseURL: "https://gw/v1" };
    const gpt = dodoModel("openai/gpt-5.4", config, {} as never);
    expect(gpt.cost).toMatchObject({ input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 });
    expect(gpt.cost.tiers).toEqual([expect.objectContaining({ inputTokensAbove: 272_000, input: 5, output: 22.5 })]);
    expect(dodoModel("google/gemini-2.5-pro", config, {} as never).cost.tiers?.[0]?.inputTokensAbove).toBe(200_000);
    expect(modelCost("deepseek/deepseek-flash")).toMatchObject({ input: 0.3, output: 1.2, cacheRead: 0.006 });
    // Not in pi-ai's catalog: Dodo's prices, no cache price.
    expect(modelCost("@cf/zai-org/glm-5.3-flash")).toEqual({ input: 0.15, output: 0.5, cacheRead: 0, cacheWrite: 0 });
    // Callers get a copy, not pi-ai's shared catalog object.
    modelCost("openai/gpt-5.4").input = 999;
    expect(modelCost("openai/gpt-5.4").input).toBe(2.5);
  });

  it("charges the long-context tier past 272k input tokens on GPT-5.4", () => {
    const m = dodoModel("openai/gpt-5.4", { activeGateway: "ai-gateway", opencodeBaseURL: "", aiGatewayBaseURL: "https://gw/v1" }, {} as never);
    const usage = (input: number, cacheRead: number) => ({ input, output: 1000, cacheRead, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
    const short = calculateCost(m, usage(100_000, 100_000));
    expect(short.total).toBeCloseTo((100_000 * 2.5 + 1000 * 15 + 100_000 * 0.25) / 1e6);
    const long = calculateCost(m, usage(100_000, 200_000));
    expect(long.total).toBeCloseTo((100_000 * 5 + 1000 * 22.5 + 200_000 * 0.5) / 1e6);
  });

  it("sends catalogued Anthropic models on an AI Gateway /compat URL through createAI", () => {
    const config = { activeGateway: "ai-gateway" as const, opencodeBaseURL: "", aiGatewayBaseURL: "https://gateway.ai.cloudflare.com/v1/acct/gw/compat/" };
    const env = { AI: fakeAIBinding(() => new Response("")).binding, CLOUDFLARE_ACCOUNT_ID: "acct" } as never;
    expect(createAIGatewayId("anthropic/claude-sonnet-4-6", config, env)).toBe("gw");
    const m = dodoModel("anthropic/claude-sonnet-4-6", config, env);
    expect(m.api).toBe("anthropic-messages");
    expect(m.provider).toBe(CREATE_AI_PROVIDER_ID);
    expect(m.id).toBe("anthropic/claude-sonnet-4-6");
    expect(m.contextWindow).toBe(1_000_000);
    expect(m.cost.cacheRead).toBeCloseTo(0.3);
    expect(m.cost.cacheWrite).toBeCloseTo(3.75);
    expect(agentModelRef("anthropic/claude-sonnet-4-6", config, env)).toEqual({ provider: CREATE_AI_PROVIDER_ID, modelId: m.id });
    // Non-Anthropic models and the OpenCode gateway keep /compat.
    expect(dodoModel("@cf/moonshotai/kimi-k2.6", config, env).api).toBe("openai-completions");
    expect(dodoModel("anthropic/claude-sonnet-4-6", { ...config, activeGateway: "opencode", opencodeBaseURL: "https://oc/compat" }, env).api).toBe("openai-completions");
    // An Anthropic id pi-ai's gateway catalog doesn't list, no binding, or a
    // URL the binding can't reach: OpenAI-compatible path.
    expect(createAIGatewayId("anthropic/claude-not-a-model", config, env)).toBeUndefined();
    expect(dodoModel("anthropic/claude-sonnet-4-6", config, {} as never).api).toBe("openai-completions");
    expect(dodoModel("anthropic/claude-sonnet-4-6", { ...config, aiGatewayBaseURL: "https://proxy.example/compat" }, env).api).toBe("openai-completions");
    expect(agentModelRef("anthropic/claude-sonnet-4-6", config, {} as never).provider).toBe("dodo-gateway");
  });
});

describe("pi gateway wire: Anthropic through createAI on AI Gateway", () => {
  afterEach(() => vi.unstubAllGlobals());

  function sse(events: Array<Record<string, unknown>>, status = 200): Response {
    const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
  }
  const reply = () =>
    sse([
      { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ]);
  const config = { activeGateway: "ai-gateway" as const, opencodeBaseURL: "", aiGatewayBaseURL: "https://gateway.ai.cloudflare.com/v1/acct/gw/compat", sessionId: "sess-9" };

  it("calls the AI binding with no gateway key, the native model id, cache_control markers and session metadata, and reports cache usage", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response("unexpected", { status: 500 });
    });
    const { binding, calls } = fakeAIBinding(() => reply());
    const env = { AI: binding, AI_GATEWAY_KEY: "gw-key", CLOUDFLARE_ACCOUNT_ID: "acct" } as never;
    const models = createModels();
    setDodoProvider(models, ["anthropic/claude-sonnet-4-6"], config, env);
    const ref = agentModelRef("anthropic/claude-sonnet-4-6", config, env);
    const model = models.getModel(ref.provider, ref.modelId)!;
    const res = await models.complete(model, {
      systemPrompt: "You are Dodo.",
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
      tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } as never }],
    });
    expect(res.errorMessage).toBeUndefined();
    expect(res.stopReason).toBe("stop");
    expect(fetched).toEqual([]);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.gatewayId).toBe("gw");
    expect(c.request.provider).toBe("anthropic");
    expect(c.request.endpoint).toBe("v1/messages");
    expect(JSON.stringify(c)).not.toContain("gw-key");
    expect((c.options.gateway as { metadata?: unknown }).metadata).toEqual({ dodo_session: "sess-9", dodo_role: "main" });
    const body = c.request.query;
    expect(body.model).toBe("claude-sonnet-4-6");
    expect((body.system as Array<Record<string, unknown>>).at(-1)?.cache_control).toMatchObject({ type: "ephemeral" });
    expect((body.tools as Array<Record<string, unknown>>).at(-1)?.cache_control).toMatchObject({ type: "ephemeral" });
    // Usage: pi-ai splits uncached input from cache reads/writes and prices them.
    expect(res.model).toBe("anthropic/claude-sonnet-4-6");
    expect(res.usage.input).toBe(12);
    expect(res.usage.cacheRead).toBe(9000);
    expect(res.usage.cacheWrite).toBe(500);
    expect(res.usage.cost.cacheRead).toBeCloseTo((9000 * 0.3) / 1e6);
    expect(res.usage.cost.cacheWrite).toBeCloseTo((500 * 3.75) / 1e6);
  });

  it("waits out a 429 from the gateway and resends the binding call", async () => {
    let n = 0;
    const { binding, calls } = fakeAIBinding(() =>
      n++ === 0
        ? new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "0" } })
        : reply(),
    );
    const env = { AI: binding, CLOUDFLARE_ACCOUNT_ID: "acct" } as never;
    const models = createModels();
    setDodoProvider(models, ["anthropic/claude-sonnet-4-6"], config, env);
    const ref = agentModelRef("anthropic/claude-sonnet-4-6", config, env);
    const res = await models.complete(models.getModel(ref.provider, ref.modelId)!, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
    expect(res.errorMessage).toBeUndefined();
    expect(calls).toHaveLength(2);
  }, 20_000);
});

describe("pi gateway wire", () => {
  afterEach(() => vi.unstubAllGlobals());

  for (const activeGateway of ["ai-gateway", "opencode"] as const) {
    it(`${activeGateway}: sends gateway auth and no placeholder Authorization`, async () => {
      const seen: Headers[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        seen.push(req.headers);
        return new Response("nope", { status: 400 });
      });
      const config = { activeGateway, opencodeBaseURL: "https://oc.example/v1", aiGatewayBaseURL: "https://gw.example/v1" };
      const env = { AI_GATEWAY_KEY: "gw-key", OPENCODE_GATEWAY_TOKEN: "oc-token" } as never;
      const models = createModels();
      setDodoProvider(models, ["anthropic/claude-sonnet-4-6"], config, env);
      const ref = agentModelRef("anthropic/claude-sonnet-4-6", config, env);
      const model = models.getModel(ref.provider, ref.modelId)!;
      const res = await models.complete(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
      expect(res.stopReason).toBe("error");
      expect(seen.length).toBeGreaterThan(0);
      const h = seen[0]!;
      expect(h.get("authorization")).toBeNull();
      if (activeGateway === "ai-gateway") expect(h.get("cf-aig-authorization")).toBe("Bearer gw-key");
      else expect(h.get("cf-access-token")).toBe("oc-token");
    });
  }
});
