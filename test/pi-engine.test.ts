import { runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/types";
import { env } from "cloudflare:workers";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { tool, zodSchema } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { entriesToMessages, PiEngine, type PiEngineHost } from "../src/pi/engine";
import { buildToolsExtension, modelOutputToContent, REPLAY_SAFE_TOOLS } from "../src/pi/tools";
import { agentModelRef, CREATE_AI_PROVIDER_ID, createAIGatewayId, dodoModel, gatewayHeaders, modelCost, setDodoProvider, WORKERS_AI_API, workersAIOnRunPath } from "../src/pi/models";
import { fakeAIBinding } from "./helpers/fake-ai-binding";
import { calculateCost, createModels } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

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

  it("stops waiting for pi a grace period after an abort when the run never settles", async () => {
    const stub = (env as unknown as Env).CODING_AGENT.get((env as unknown as Env).CODING_AGENT.idFromName("pi-engine-abort-grace"));
    await runInDurableObject(stub, async (_i, state) => {
      const faux = fauxProvider();
      faux.setResponses([fauxAssistantMessage([fauxToolCall("stuck", {}, { id: "c1" })], { stopReason: "toolUse" })]);
      let entered: () => void = () => {};
      const enteredP = new Promise<void>((r) => { entered = r; });
      let release: () => void = () => {};
      const tools = {
        stuck: tool({
          description: "ignores the abort signal",
          inputSchema: zodSchema(z.object({})),
          execute: async () => {
            entered();
            await new Promise<void>((resolve) => { release = resolve; });
            return "late";
          },
        }),
      };
      const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
      const engine = new PiEngine({ ...host(state.storage, faux, []), log: (_l, message, fields) => logs.push({ message, fields }) });
      const controller = new AbortController();
      const running = engine.run({
        promptId: "p1",
        prepare: async () => ({ content: "go", entry: entry("go") }),
        tools: await buildToolsExtension(tools),
        signal: controller.signal,
        abortGraceMs: 200,
      });
      await enteredP;
      const abortedAt = Date.now();
      controller.abort();
      const result = await running;
      expect(result.status).toBe("unanswered");
      expect(result.reason).toBe("abort_timeout");
      expect(Date.now() - abortedAt).toBeLessThan(10_000);
      expect(logs.map((l) => l.message)).toContain("pi: run did not settle after abort");
      release();
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

  it("caps max_tokens to a Workers AI model's real window when Dodo's catalog doesn't list it", async () => {
    // Qwen3 30B isn't in Dodo's catalog. It used to get the 128k default, so
    // /compat sent max_tokens 32000 on top of the prompt into a 32,768 window
    // and Workers AI 400'd the first turn (preview, 2026-10-22).
    const config = { activeGateway: "ai-gateway" as const, opencodeBaseURL: "", aiGatewayBaseURL: "https://gw/v1" };
    const m = dodoModel("@cf/qwen/qwen3-30b-a3b-fp8", config, {} as never);
    expect(m.contextWindow).toBe(32_768);
    expect(dodoModel("@cf/qwen/qwen2.5-coder-32b-instruct", config, {} as never).contextWindow).toBe(32_768); // Dodo's catalog
    expect(dodoModel("@cf/acme/not-a-model", config, {} as never).contextWindow).toBe(128_000); // neither catalog

    let body: { max_tokens?: number; max_completion_tokens?: number } | undefined;
    const capture = (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ error: { message: "stop here" } }), { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const prompt = "word ".repeat(4000);
    const context = normalizeContext({ messages: [{ role: "user", content: prompt, timestamp: 0 }] });
    await openAICompletionsApi().streamSimple(m as never, context, { apiKey: "k", fetch: capture }).result();
    const cap = body?.max_tokens ?? body?.max_completion_tokens;
    expect(cap).toBeDefined();
    expect(cap!).toBeLessThan(32_000);
    expect(cap! + prompt.length / 4).toBeLessThan(32_768);
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
    expect(res.usage.totalTokens).toBe(12 + 5 + 9000 + 500);
    expect(res.usage.cost.cacheRead).toBeCloseTo((9000 * 0.3) / 1e6);
    expect(res.usage.cost.cacheWrite).toBeCloseTo((500 * 3.75) / 1e6);
  });

  it("still resolves a pre-createAI dodo-gateway/anthropic ref (persisted turn) and sends it through the binding", async () => {
    const { binding, calls } = fakeAIBinding(() => reply());
    const env = { AI: binding, AI_GATEWAY_KEY: "gw-key", CLOUDFLARE_ACCOUNT_ID: "acct" } as never;
    const models = createModels();
    setDodoProvider(models, ["anthropic/claude-sonnet-4-6"], config, env);
    const legacy = models.getModel("dodo-gateway", "anthropic/claude-sonnet-4-6");
    expect(legacy?.api).toBe("anthropic-messages");
    const res = await models.complete(legacy!, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
    expect(res.errorMessage).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request.query.model).toBe("claude-sonnet-4-6");
    // The dodo-gateway auth headers (gateway key) never reach the binding call.
    expect(JSON.stringify(calls[0])).not.toContain("gw-key");
  });

  it("drops the createAI provider when the config no longer uses it", () => {
    const env = { AI: fakeAIBinding(() => reply()).binding, CLOUDFLARE_ACCOUNT_ID: "acct" } as never;
    const models = createModels();
    setDodoProvider(models, ["anthropic/claude-sonnet-4-6"], config, env);
    expect(models.getModel(CREATE_AI_PROVIDER_ID, "anthropic/claude-sonnet-4-6")).toBeDefined();
    setDodoProvider(models, ["@cf/moonshotai/kimi-k2.6"], config, env);
    expect(models.getModel(CREATE_AI_PROVIDER_ID, "anthropic/claude-sonnet-4-6")).toBeUndefined();
    // Only the /compat drain entry for @cf/ refs is left (see the run-path tests).
    expect(models.getModel(CREATE_AI_PROVIDER_ID, "@cf/moonshotai/kimi-k2.6")?.api).toBe("openai-completions");
    // Nothing that could have a cloudflare/ ref: the provider goes.
    setDodoProvider(models, ["openai/gpt-5.4"], config, env);
    expect(models.getModel(CREATE_AI_PROVIDER_ID, "@cf/moonshotai/kimi-k2.6")).toBeUndefined();
  });

  it("keeps the caller's AbortSignal off the binding call and still honours it", async () => {
    const { binding, calls } = fakeAIBinding(() => reply());
    const env = { AI: binding, CLOUDFLARE_ACCOUNT_ID: "acct" } as never;
    const models = createModels();
    setDodoProvider(models, ["anthropic/claude-sonnet-4-6"], config, env);
    const ref = agentModelRef("anthropic/claude-sonnet-4-6", config, env);
    const model = models.getModel(ref.provider, ref.modelId)!;
    const ok = await models.complete(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { signal: new AbortController().signal });
    expect(ok.errorMessage).toBeUndefined();
    expect(calls).toHaveLength(1);
    const aborted = new AbortController();
    aborted.abort();
    const res = await models.complete(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { signal: aborted.signal });
    // pi-ai reports a pre-aborted call as "error" here (seen with both an
    // AbortError and a raw reason); what matters is that nothing was sent.
    // Live abort mid-turn on preview ends the prompt as "aborted".
    expect(res.stopReason).not.toBe("stop");
    expect(calls).toHaveLength(1);
  });

  it("fails a binding stream that goes quiet as a retryable idle timeout, on both refs", async () => {
    // Headers arrive, then the SSE body never sends anything.
    const { binding } = fakeAIBinding(
      () => new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const env = { AI: binding, CLOUDFLARE_ACCOUNT_ID: "acct" } as never;
    const models = createModels();
    setDodoProvider(models, ["anthropic/claude-sonnet-4-6"], config, env, { idleMs: 50 });
    const ref = agentModelRef("anthropic/claude-sonnet-4-6", config, env);
    for (const model of [models.getModel(ref.provider, ref.modelId)!, models.getModel("dodo-gateway", "anthropic/claude-sonnet-4-6")!]) {
      const res = await models.complete(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
      expect(res.stopReason).toBe("error");
      expect(res.errorMessage).toMatch(/idle timeout/);
    }
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

describe("pi gateway wire: Workers AI through createAI's run path (WORKERS_AI_VIA_BINDING)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const KIMI = "@cf/moonshotai/kimi-k2.6";
  const config = { activeGateway: "ai-gateway" as const, opencodeBaseURL: "", aiGatewayBaseURL: "https://gateway.ai.cloudflare.com/v1/acct/gw/compat", sessionId: "sess-7" };
  const chunks = (events: Array<Record<string, unknown>>, status = 200, headers: Record<string, string> = {}) =>
    new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", {
      status,
      headers: { "content-type": "text/event-stream", ...headers },
    });
  const reply = () =>
    chunks([
      { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "hello" } }] },
      { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      // include_usage: the totals come in a final chunk with no choices.
      { id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 40, completion_tokens: 2, total_tokens: 42 } },
    ]);

  it("is opt-in: without the flag (or with it off) @cf/ ids stay on /compat", () => {
    const env = { AI: fakeAIBinding(() => new Response("")).binding, CLOUDFLARE_ACCOUNT_ID: "acct" } as never;
    expect(workersAIOnRunPath(KIMI, {})).toBe(false);
    expect(workersAIOnRunPath(KIMI, { WORKERS_AI_VIA_BINDING: "0" })).toBe(false);
    expect(workersAIOnRunPath("anthropic/claude-sonnet-4-6", { WORKERS_AI_VIA_BINDING: "1" })).toBe(false);
    expect(createAIGatewayId(KIMI, config, env)).toBeUndefined();
    expect(dodoModel(KIMI, config, env).api).toBe("openai-completions");
  });

  it("routes @cf/ ids through createAI when on, and keeps the /compat entry for persisted refs", () => {
    const env = { AI: fakeAIBinding(() => new Response("")).binding, CLOUDFLARE_ACCOUNT_ID: "acct", WORKERS_AI_VIA_BINDING: "true" } as never;
    expect(createAIGatewayId(KIMI, config, env)).toBe("gw");
    const m = dodoModel(KIMI, config, env);
    expect(m.api).toBe(WORKERS_AI_API);
    expect(m.provider).toBe(CREATE_AI_PROVIDER_ID);
    expect(m.id).toBe(KIMI);
    expect(m.reasoning).toBe(false);
    expect(m.contextWindow).toBe(262_144);
    expect(agentModelRef(KIMI, config, env)).toEqual({ provider: CREATE_AI_PROVIDER_ID, modelId: KIMI });
    const models = createModels();
    setDodoProvider(models, [KIMI], config, env);
    expect(models.getModel(CREATE_AI_PROVIDER_ID, KIMI)?.api).toBe(WORKERS_AI_API);
    expect(models.getModel("dodo-gateway", `workers-ai/${KIMI}`)?.api).toBe("openai-completions");
    // OpenCode, no binding, or a gateway the binding can't reach: /compat.
    expect(dodoModel(KIMI, { ...config, activeGateway: "opencode", opencodeBaseURL: "https://oc/compat" }, env).api).toBe("openai-completions");
    expect(dodoModel(KIMI, config, { WORKERS_AI_VIA_BINDING: "1", CLOUDFLARE_ACCOUNT_ID: "acct" } as never).api).toBe("openai-completions");
    expect(dodoModel(KIMI, { ...config, aiGatewayBaseURL: "https://proxy.example/compat" }, env).api).toBe("openai-completions");
  });

  it("calls env.AI.run with the gateway, session metadata and affinity, no gateway key, and Workers AI quirks", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response("unexpected", { status: 500 });
    });
    const { binding, calls, runCalls } = fakeAIBinding(() => new Response("unexpected", { status: 500 }), () => reply());
    const env = { AI: binding, AI_GATEWAY_KEY: "gw-key", CLOUDFLARE_ACCOUNT_ID: "acct", WORKERS_AI_VIA_BINDING: "1" } as never;
    const models = createModels();
    setDodoProvider(models, [KIMI], config, env);
    const ref = agentModelRef(KIMI, config, env);
    const res = await models.complete(
      models.getModel(ref.provider, ref.modelId)!,
      {
        systemPrompt: "You are Dodo.",
        messages: [
          { role: "user", content: "read it", timestamp: 0 },
          // A tool-only assistant turn: /compat sent `content: null`, which
          // Workers AI's text-only models 400 on. The run path sends "".
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a" } }],
            api: WORKERS_AI_API,
            provider: CREATE_AI_PROVIDER_ID,
            model: KIMI,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "toolUse",
            timestamp: 1,
          },
          { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "contents" }], isError: false, timestamp: 2 },
        ],
        tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } as never }],
      },
      { sessionId: "sess-7" },
    );
    expect(res.errorMessage).toBeUndefined();
    expect(res.stopReason).toBe("stop");
    expect(fetched).toEqual([]);
    expect(calls).toEqual([]);
    expect(runCalls).toHaveLength(1);
    const c = runCalls[0]!;
    expect(c.model).toBe(KIMI);
    expect(JSON.stringify(c)).not.toContain("gw-key");
    expect(c.options.returnRawResponse).toBe(true);
    expect(c.options.gateway).toMatchObject({ id: "gw", metadata: { dodo_session: "sess-7", dodo_role: "main" } });
    expect(c.options.extraHeaders).toMatchObject({ "x-session-affinity": "sess-7" });
    expect(c.inputs.model).toBeUndefined();
    expect(c.inputs.stream).toBe(true);
    // A cap like pi-ai's own leg: the model's maxTokens, clamped to the room left in the context.
    expect(c.inputs.max_tokens).toBe(32_000);
    const assistant = (c.inputs.messages as Array<Record<string, unknown>>).find((m) => m.role === "assistant")!;
    expect(assistant.content).toBe("");
    expect((c.inputs.tools as unknown[]).length).toBe(1);
    expect(res.usage.input).toBe(40);
    expect(res.usage.output).toBe(2);
  });

  it("waits out a 429 on the run path and resends", async () => {
    let n = 0;
    const { binding, runCalls } = fakeAIBinding(
      () => new Response("unexpected", { status: 500 }),
      () => (n++ === 0 ? new Response(JSON.stringify({ errors: [{ message: "Capacity temporarily exceeded" }] }), { status: 429, headers: { "content-type": "application/json", "retry-after": "0" } }) : reply()),
    );
    const env = { AI: binding, CLOUDFLARE_ACCOUNT_ID: "acct", WORKERS_AI_VIA_BINDING: "1" } as never;
    const models = createModels();
    setDodoProvider(models, [KIMI], config, env);
    const res = await models.complete(models.getModel(CREATE_AI_PROVIDER_ID, KIMI)!, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
    expect(res.errorMessage).toBeUndefined();
    expect(runCalls).toHaveLength(2);
  }, 20_000);

  for (const [label, env] of [
    // COMPAT_VIA_BINDING=0: these check the /compat leg over HTTP (the stubbed fetch), not its binding transport.
    ["the flag is off", { CLOUDFLARE_ACCOUNT_ID: "acct", COMPAT_VIA_BINDING: "0" }],
    ["the binding can't reach the gateway", { WORKERS_AI_VIA_BINDING: "1" }],
  ] as const) {
    it(`resumes a persisted cloudflare/@cf/ ref on /compat when ${label}`, async () => {
      const seen: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        seen.push({ url: req.url, headers: req.headers, body: (await req.json()) as Record<string, unknown> });
        return reply();
      });
      const { binding, runCalls } = fakeAIBinding(() => new Response("unexpected", { status: 500 }), () => reply());
      const e = { AI: binding, AI_GATEWAY_KEY: "gw-key", ...env } as never;
      const models = createModels();
      setDodoProvider(models, [KIMI], config, e);
      // New turns: /compat.
      expect(agentModelRef(KIMI, config, e)).toEqual({ provider: "dodo-gateway", modelId: `workers-ai/${KIMI}` });
      // A turn that started on the run path still resolves, and goes to /compat.
      const persisted = models.getModel(CREATE_AI_PROVIDER_ID, KIMI);
      expect(persisted).toBeDefined();
      const res = await models.complete(persisted!, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
      expect(res.errorMessage).toBeUndefined();
      expect(runCalls).toHaveLength(0);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe(`${config.aiGatewayBaseURL}/chat/completions`);
      expect(seen[0]!.body.model).toBe(`workers-ai/${KIMI}`);
      expect(seen[0]!.headers.get("cf-aig-authorization")).toBe("Bearer gw-key");
      expect(seen[0]!.headers.get("authorization")).toBeNull();
    });
  }

  it("waits out a rate limit the binding throws (AiError 3021) instead of returning", async () => {
    let n = 0;
    const { binding, runCalls } = fakeAIBinding(
      () => new Response("unexpected", { status: 500 }),
      () => {
        if (n++ === 0) throw Object.assign(new Error("AiError: 3021: inference request per min rate reached"), { httpCode: 429 });
        return reply();
      },
    );
    const env = { AI: binding, CLOUDFLARE_ACCOUNT_ID: "acct", WORKERS_AI_VIA_BINDING: "1" } as never;
    const models = createModels();
    setDodoProvider(models, [KIMI], config, env);
    const res = await models.complete(models.getModel(CREATE_AI_PROVIDER_ID, KIMI)!, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
    expect(res.errorMessage).toBeUndefined();
    expect(runCalls).toHaveLength(2);
  }, 20_000);

  it("takes a shared model-budget slot per send on the run path, 429 resends included, and reports the 429", async () => {
    let n = 0;
    const { binding, runCalls } = fakeAIBinding(
      () => new Response("unexpected", { status: 500 }),
      () => (n++ === 0 ? new Response(JSON.stringify({ errors: [{ message: "Capacity temporarily exceeded" }] }), { status: 429, headers: { "content-type": "application/json", "retry-after": "0" } }) : reply()),
    );
    const acquired: Array<[string, string]> = [];
    const reported: string[] = [];
    let denyFirst = true;
    const waits: number[] = [];
    const SHARED_INDEX = {
      idFromName: () => "global",
      get: () => ({
        modelBudgetAcquire: async (key: string, _rpm: number, priority: string) => {
          acquired.push([key, priority]);
          if (denyFirst) {
            denyFirst = false;
            return { ok: false, waitMs: 1, used: 1, limit: 1 };
          }
          return { ok: true, waitMs: 0, used: 1, limit: 10 };
        },
        modelBudgetReport429: async (key: string) => {
          reported.push(key);
        },
      }),
    };
    const env = { AI: binding, CLOUDFLARE_ACCOUNT_ID: "acct", WORKERS_AI_VIA_BINDING: "1", SHARED_INDEX } as never;
    const models = createModels();
    setDodoProvider(models, [KIMI], config, env, { onBudgetWait: (info) => waits.push(info.waitMs) });
    const res = await models.complete(models.getModel(CREATE_AI_PROVIDER_ID, KIMI)!, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
    expect(res.errorMessage).toBeUndefined();
    expect(runCalls).toHaveLength(2);
    // One denied + one granted before the first send, one granted before the resend. Same key as /compat.
    expect(acquired).toEqual([
      [`ai-gateway:${KIMI}`, "main"],
      [`ai-gateway:${KIMI}`, "main"],
      [`ai-gateway:${KIMI}`, "main"],
    ]);
    expect(waits).toHaveLength(1);
    await vi.waitFor(() => expect(reported).toEqual([`ai-gateway:${KIMI}`]));
  }, 20_000);

  it("/compat over the binding (COMPAT_VIA_BINDING default) still takes the budget slot", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("HTTP fetch not expected: /compat should go over the binding");
    });
    const acquired: Array<[string, string]> = [];
    const SHARED_INDEX = {
      idFromName: () => "global",
      get: () => ({
        modelBudgetAcquire: async (key: string, _rpm: number, priority: string) => {
          acquired.push([key, priority]);
          return { ok: true, waitMs: 0, used: 1, limit: 10 };
        },
        modelBudgetReport429: async () => {},
      }),
    };
    const { binding, calls, runCalls } = fakeAIBinding(() => reply(), () => new Response("unexpected", { status: 500 }));
    const env = { AI: binding, CLOUDFLARE_ACCOUNT_ID: "acct", SHARED_INDEX } as never;
    const models = createModels();
    setDodoProvider(models, [KIMI], config, env);
    const ref = agentModelRef(KIMI, config, env);
    const res = await models.complete(models.getModel(ref.provider, ref.modelId)!, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
    expect(res.errorMessage).toBeUndefined();
    expect(runCalls).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].request.provider).toBe("compat");
    expect(acquired).toEqual([[`ai-gateway:${KIMI}`, "main"]]);
  });

  it("a drained cloudflare/@cf/ ref goes over the binding by default, keyless, with the budget slot", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("HTTP fetch not expected: /compat should go over the binding");
    });
    const acquired: Array<[string, string]> = [];
    const SHARED_INDEX = {
      idFromName: () => "global",
      get: () => ({
        modelBudgetAcquire: async (key: string, _rpm: number, priority: string) => {
          acquired.push([key, priority]);
          return { ok: true, waitMs: 0, used: 1, limit: 10 };
        },
        modelBudgetReport429: async () => {},
      }),
    };
    const { binding, calls, runCalls } = fakeAIBinding(() => reply(), () => new Response("unexpected", { status: 500 }));
    const env = { AI: binding, AI_GATEWAY_KEY: "gw-key", CLOUDFLARE_ACCOUNT_ID: "acct", SHARED_INDEX } as never;
    const models = createModels();
    setDodoProvider(models, [KIMI], config, env);
    const res = await models.complete(models.getModel(CREATE_AI_PROVIDER_ID, KIMI)!, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
    expect(res.errorMessage).toBeUndefined();
    expect(runCalls).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].request.provider).toBe("compat");
    expect(calls[0].request.query.model).toBe(`workers-ai/${KIMI}`);
    expect(JSON.stringify(calls[0])).not.toContain("gw-key");
    expect(acquired).toEqual([[`ai-gateway:${KIMI}`, "main"]]);
  });

  it("a drained cloudflare/@cf/ ref on /compat takes the same budget slot", async () => {
    vi.stubGlobal("fetch", async () => reply());
    const acquired: Array<[string, string]> = [];
    const SHARED_INDEX = {
      idFromName: () => "global",
      get: () => ({
        modelBudgetAcquire: async (key: string, _rpm: number, priority: string) => {
          acquired.push([key, priority]);
          return { ok: true, waitMs: 0, used: 1, limit: 10 };
        },
        modelBudgetReport429: async () => {},
      }),
    };
    const { binding, runCalls } = fakeAIBinding(() => new Response("unexpected", { status: 500 }), () => reply());
    const env = { AI: binding, AI_GATEWAY_KEY: "gw-key", CLOUDFLARE_ACCOUNT_ID: "acct", COMPAT_VIA_BINDING: "0", SHARED_INDEX } as never;
    const models = createModels();
    setDodoProvider(models, [KIMI], config, env);
    const res = await models.complete(models.getModel(CREATE_AI_PROVIDER_ID, KIMI)!, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
    expect(res.errorMessage).toBeUndefined();
    expect(runCalls).toHaveLength(0);
    expect(acquired).toEqual([[`ai-gateway:${KIMI}`, "main"]]);
  });

  it("passes other thrown binding errors through as a failed turn, without retrying", async () => {
    const { binding, runCalls } = fakeAIBinding(
      () => new Response("unexpected", { status: 500 }),
      () => {
        throw new Error("AiError: 5006: Bad input");
      },
    );
    const env = { AI: binding, CLOUDFLARE_ACCOUNT_ID: "acct", WORKERS_AI_VIA_BINDING: "1" } as never;
    const models = createModels();
    setDodoProvider(models, [KIMI], config, env);
    const res = await models.complete(models.getModel(CREATE_AI_PROVIDER_ID, KIMI)!, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
    expect(res.stopReason).toBe("error");
    expect(res.errorMessage).toContain("Bad input");
    expect(runCalls).toHaveLength(1);
  });

  it("keeps the AbortSignal off the binding call and settles an aborted run as aborted", async () => {
    const { binding, runCalls } = fakeAIBinding(() => new Response("unexpected", { status: 500 }), () => reply());
    const env = { AI: binding, CLOUDFLARE_ACCOUNT_ID: "acct", WORKERS_AI_VIA_BINDING: "1" } as never;
    const models = createModels();
    setDodoProvider(models, [KIMI], config, env);
    const model = models.getModel(CREATE_AI_PROVIDER_ID, KIMI)!;
    // Live signal: the fake binding throws if a signal crosses it.
    const ok = await models.complete(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { signal: new AbortController().signal });
    expect(ok.errorMessage).toBeUndefined();
    expect(runCalls[0]!.options.signal).toBeUndefined();
    const aborted = new AbortController();
    aborted.abort();
    const res = await models.complete(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { signal: aborted.signal });
    expect(["aborted", "error"]).toContain(res.stopReason);
    expect(runCalls).toHaveLength(1);
  });

  it("clamps max_tokens to the room left in a small context window", async () => {
    const { binding, runCalls } = fakeAIBinding(() => new Response("unexpected", { status: 500 }), () => reply());
    const env = { AI: binding, CLOUDFLARE_ACCOUNT_ID: "acct", WORKERS_AI_VIA_BINDING: "1" } as never;
    const models = createModels();
    // Not in Dodo's catalog: pi-ai's Workers AI catalog says 32,768 tokens.
    setDodoProvider(models, ["@cf/qwen/qwen3-30b-a3b-fp8"], config, env);
    const m = models.getModel(CREATE_AI_PROVIDER_ID, "@cf/qwen/qwen3-30b-a3b-fp8")!;
    expect(m.contextWindow).toBe(32_768);
    await models.complete(m, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
    const cap = runCalls[0]!.inputs.max_tokens as number;
    expect(cap).toBeGreaterThan(20_000);
    expect(cap).toBeLessThan(32_768 - 4096);
  });
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
