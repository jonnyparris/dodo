import { runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/types";
import { env } from "cloudflare:workers";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { tool, zodSchema } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { entriesToMessages, PiEngine, type PiEngineHost } from "../src/pi/engine";
import { buildToolsExtension, modelOutputToContent, REPLAY_SAFE_TOOLS } from "../src/pi/tools";
import { agentModelRef, dodoModel, gatewayHeaders, setDodoProvider } from "../src/pi/models";
import { createModels } from "@earendil-works/pi-ai/models";

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

  // Regression: prompt caching reports the cached prefix in cacheRead/cacheWrite,
  // leaving usage.input as only the uncached remainder. Counting input alone
  // reported a ~29k prompt as "145 in" and under-reported usage stats and the
  // session summary by the whole cached prefix.
  it("counts cached prompt tokens in the turn's input total", async () => {
    const stub = (env as unknown as Env).CODING_AGENT.get((env as unknown as Env).CODING_AGENT.idFromName("pi-engine-usage"));
    await runInDurableObject(stub, async (_i, state) => {
      const usage = (input: number, cacheRead: number, cacheWrite: number): AssistantMessage["usage"] => ({
        input,
        output: 7,
        cacheRead,
        cacheWrite,
        totalTokens: input + 7 + cacheRead + cacheWrite,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      });
      // Spread so the override survives even if faux hands back a frozen message.
      const withUsage = (m: ReturnType<typeof fauxAssistantMessage>, u: AssistantMessage["usage"]) => ({ ...m, usage: u });
      const faux = fauxProvider();
      faux.setResponses([
        // Step 1: cache miss — the ~28k prefix is written to the cache.
        withUsage(fauxAssistantMessage([fauxToolCall("noop", {}, { id: "c1" })], { stopReason: "toolUse" }), usage(145, 0, 28_400)),
        // Step 2: cache hit — the prefix comes back as cacheRead.
        withUsage(fauxAssistantMessage([fauxText("done")]), usage(180, 28_400, 512)),
      ]);
      const tools = {
        noop: tool({
          description: "noop",
          inputSchema: zodSchema(z.object({})),
          execute: async () => "ok",
        }),
      };
      const engine = new PiEngine(host(state.storage, faux, []));
      const result = await engine.run({
        promptId: "p1",
        prepare: async () => ({ content: "go", entry: entry("go") }),
        tools: await buildToolsExtension(tools),
      });
      expect(result.status).toBe("done");
      // Every prompt token the model received, cached prefix included.
      expect(result.tokenInput).toBe(145 + 28_400 + 180 + 28_400 + 512);
      // The old accounting: uncached remainders only.
      expect(result.tokenInput).not.toBe(145 + 180);
      expect(result.tokenOutput).toBe(14);
      // Context size is the last request's prompt, cache included.
      expect(result.contextTokens).toBe(180 + 28_400 + 512);
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
    expect(m.contextWindow).toBe(200_000);
    expect(m.compat?.cacheControlFormat).toBe("anthropic");
    const h = gatewayHeaders({ activeGateway: "ai-gateway", opencodeBaseURL: "", aiGatewayBaseURL: "" }, { AI_GATEWAY_KEY: "k" } as never);
    expect(h["cf-aig-authorization"]).toBe("Bearer k");
    expect(h.Authorization).toBeNull();
    const w = dodoModel("@cf/moonshotai/kimi-k2.6", { activeGateway: "ai-gateway", opencodeBaseURL: "", aiGatewayBaseURL: "https://gw/v1" }, {} as never);
    expect(w.id).toBe("workers-ai/@cf/moonshotai/kimi-k2.6");
    expect(w.compat?.cacheControlFormat).toBeUndefined();
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
      const ref = agentModelRef("anthropic/claude-sonnet-4-6", config);
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
