/**
 * Shared per-model Workers AI request budget (src/model-budget.ts).
 *
 * Bench 10-21: subagent fan-out on DeepSeek 1017 used the account's
 * per-minute cap, and the main session on the same model failed with
 * AiError 3021. Main turns and subagents now draw from one budget, and
 * subagents must leave a reserve for main turns.
 */
import { env } from "cloudflare:workers";
import { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { ModelBudgetBook, budgetKey, modelRpm, priorityLimit, WINDOW_MS } from "../src/model-budget";
import { budgetFetch, type ModelBudgetClient, sharedIndexBudgetClient, withModelBudget } from "../src/model-budget-fetch";
import { dodoModel, withModelBudgetStreams, withRateLimitRetry } from "../src/pi/models";
import { buildProviderForModel } from "../src/subagent-runner";
import type { AppConfig, Env } from "../src/types";

const RPM_BODY = JSON.stringify({ name: "AiError", internalCode: 3021, message: "rate limiting: inference request per min rate reached" });
const rateLimited = (headers: Record<string, string> = {}, body = RPM_BODY) =>
  new Response(body, { status: 429, headers: { "content-type": "application/json", ...headers } });

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

function bookClient(book: ModelBudgetBook) {
  const reports: Array<{ key: string; retryAfterMs?: number }> = [];
  const client: ModelBudgetClient = {
    acquire: async (key, rpm, priority) => book.acquire(key, rpm, priority),
    report429: async (key, rpm, retryAfterMs) => {
      reports.push({ key, retryAfterMs });
      book.report429(key, rpm, retryAfterMs);
    },
  };
  return { client, reports };
}

describe("ModelBudgetBook", () => {
  const KEY = "ai-gateway:@cf/deepseek-ai/deepseek-v4.1-flash-1017";

  it("subagents stop at the cap minus the main-turn reserve; main turns can use the reserve", () => {
    const c = clock();
    const book = new ModelBudgetBook(c.now);
    let subOk = 0;
    for (let i = 0; i < 60; i++) if (book.acquire(KEY, 50, "subagent").ok) subOk++;
    expect(subOk).toBe(37); // 50 - ceil(50 * 0.25)
    let mainOk = 0;
    for (let i = 0; i < 20; i++) if (book.acquire(KEY, 50, "main").ok) mainOk++;
    expect(mainOk).toBe(13);
    const denied = book.acquire(KEY, 50, "main");
    expect(denied.ok).toBe(false);
    expect(denied.waitMs).toBe(WINDOW_MS);
  });

  it("says how long until a slot frees, and frees it when the minute passes", () => {
    const c = clock();
    const book = new ModelBudgetBook(c.now);
    for (let i = 0; i < 3; i++) {
      expect(book.acquire(KEY, 4, "subagent").ok).toBe(true);
      c.advance(10_000);
    }
    const denied = book.acquire(KEY, 4, "subagent");
    expect(denied).toMatchObject({ ok: false, used: 3, limit: 3 });
    expect(denied.waitMs).toBe(WINDOW_MS - 30_000); // oldest stamp ages out
    c.advance(denied.waitMs);
    expect(book.acquire(KEY, 4, "subagent").ok).toBe(true);
  });

  it("keys are independent", () => {
    const book = new ModelBudgetBook(clock().now);
    for (let i = 0; i < 3; i++) book.acquire("a", 4, "subagent");
    expect(book.acquire("a", 4, "subagent").ok).toBe(false);
    expect(book.acquire("b", 4, "subagent").ok).toBe(true);
  });

  it("a 429 lowers the cap to what was in flight and holds subagents for Retry-After, not main turns", () => {
    const c = clock();
    const book = new ModelBudgetBook(c.now);
    for (let i = 0; i < 30; i++) expect(book.acquire(KEY, 50, "subagent").ok).toBe(true);
    book.report429(KEY, 50, 8_000);
    const sub = book.acquire(KEY, 50, "subagent");
    expect(sub.ok).toBe(false);
    expect(sub.waitMs).toBe(8_000);
    expect(sub.cap).toBe(29);
    expect(book.acquire(KEY, 50, "main").ok).toBe(true); // main uses the reserve
    c.advance(8_000);
    // Cooldown over, but 31 used against a subagent limit of 29 - 8 = 21.
    expect(book.acquire(KEY, 50, "subagent").ok).toBe(false);
  });

  it("the learned cap never drops below a quarter of the configured rpm, and recovers per quiet minute", () => {
    const c = clock();
    const book = new ModelBudgetBook(c.now);
    book.acquire(KEY, 40, "main");
    book.report429(KEY, 40);
    expect(book.snapshot()[0].cap).toBe(10);
    c.advance(WINDOW_MS);
    book.acquire(KEY, 40, "main");
    expect(book.snapshot()[0].cap).toBe(14); // +10% of 40
    c.advance(WINDOW_MS * 10);
    book.acquire(KEY, 40, "main");
    expect(book.snapshot()[0].cap).toBe(40);
  });

  it("a burst of 429s cuts the cap once; each new episode cuts at least 20%", () => {
    const c = clock();
    const book = new ModelBudgetBook(c.now);
    for (let i = 0; i < 50; i++) book.acquire(KEY, 50, "main"); // over-sent: used can't tell us the cap
    book.report429(KEY, 50, 5_000);
    expect(book.snapshot()[0].cap).toBe(40);
    book.report429(KEY, 50, 5_000);
    book.report429(KEY, 50, 5_000);
    expect(book.snapshot()[0].cap).toBe(40);
    c.advance(10_000); // cooldown over, still inside the 15s episode
    book.report429(KEY, 50, 5_000);
    expect(book.snapshot()[0].cap).toBe(40);
    c.advance(5_000);
    book.report429(KEY, 50, 5_000);
    expect(book.snapshot()[0].cap).toBe(32);
  });

  it("fractional or junk rpm and priority from RPC can't produce a NaN wait", () => {
    const book = new ModelBudgetBook(clock().now);
    for (let i = 0; i < 3; i++) book.acquire("f", 2.5, "subagent");
    const d = book.acquire("f", 2.5, "subagent");
    expect(d.ok).toBe(false);
    expect(Number.isFinite(d.waitMs)).toBe(true);
    expect(book.acquire("n", Number.NaN, "main").ok).toBe(true);
    expect(book.acquire("n", Number.NaN, "main").ok).toBe(false);
    expect(book.acquire("p", 4, "bogus" as never).limit).toBe(3); // treated as subagent
  });

  it("snapshot reports use, waits and 429s", () => {
    const book = new ModelBudgetBook(clock().now);
    for (let i = 0; i < 5; i++) book.acquire(KEY, 4, "subagent");
    book.report429(KEY, 4, 2_000);
    expect(book.snapshot()).toEqual([{ key: KEY, rpm: 4, cap: 2, used: 3, cooldownMs: 2_000, throttled: 2, rateLimited: 1 }]);
  });

  it("priorityLimit always leaves subagents at least one request", () => {
    expect(priorityLimit(1, "subagent")).toBe(1);
    expect(priorityLimit(2, "subagent")).toBe(1);
    expect(priorityLimit(20, "subagent")).toBe(15);
    expect(priorityLimit(20, "main")).toBe(20);
    expect(priorityLimit(10, "main", 50)).toBe(50); // main ignores the learned cap
  });
});

describe("modelRpm", () => {
  it("budgets Workers AI models only: 50/min for frontier models, 300 for the rest", () => {
    expect(modelRpm("anthropic/claude-sonnet-4-6")).toBeUndefined();
    expect(modelRpm("deepseek/deepseek-flash")).toBeUndefined();
    expect(modelRpm("@cf/deepseek-ai/deepseek-v4.1-flash-1017")).toBe(50);
    expect(modelRpm("@cf/moonshotai/kimi-k2.6")).toBe(50);
    expect(modelRpm("@cf/zai-org/glm-5.3-flash")).toBe(50);
    expect(modelRpm("@cf/meta/llama-4-scout-17b-16e-instruct")).toBe(300);
  });

  it("MODEL_RPM_LIMITS overrides per model, then @cf/*; 0 turns a budget off; bad JSON is ignored", () => {
    const o = JSON.stringify({ "@cf/moonshotai/kimi-k2.6": 20, "@cf/*": 100, "@cf/zai-org/glm-5.3-flash": 0 });
    expect(modelRpm("@cf/moonshotai/kimi-k2.6", o)).toBe(20);
    expect(modelRpm("@cf/meta/llama-4-scout-17b-16e-instruct", o)).toBe(100);
    expect(modelRpm("@cf/zai-org/glm-5.3-flash", o)).toBeUndefined();
    expect(modelRpm("anthropic/claude-sonnet-4-6", o)).toBeUndefined();
    expect(modelRpm("@cf/moonshotai/kimi-k2.6", "{not json")).toBe(50);
    expect(modelRpm("@cf/moonshotai/kimi-k2.6", JSON.stringify({ "@cf/moonshotai/kimi-k2.6": 20.7 }))).toBe(20);
    expect(modelRpm("@cf/moonshotai/kimi-k2.6", JSON.stringify({ "@cf/moonshotai/kimi-k2.6": "20" }))).toBe(50);
    expect(modelRpm("@cf/moonshotai/kimi-k2.6", JSON.stringify({ "@cf/moonshotai/kimi-k2.6": 0.5 }))).toBe(1);
  });
});

describe("budgetFetch", () => {
  const ok = () => new Response("ok");

  it("waits for a slot, then sends", async () => {
    const c = clock();
    const book = new ModelBudgetBook(c.now);
    const { client } = bookClient(book);
    for (let i = 0; i < 3; i++) book.acquire("k", 4, "subagent");
    const waits: number[] = [];
    const sent: string[] = [];
    const f = budgetFetch(async (input) => (sent.push(String(input)), ok()), {
      client,
      key: "k",
      rpm: 4,
      priority: "subagent",
      sleep: async (ms) => {
        waits.push(ms);
        c.advance(ms);
      },
    });
    expect((await f("https://gw/chat", { method: "POST", body: "{}" })).status).toBe(200);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(WINDOW_MS);
    expect(sent).toEqual(["https://gw/chat"]);
  });

  it("sends anyway after maxWaitMs", async () => {
    const book = new ModelBudgetBook(clock().now); // clock never moves
    const { client } = bookClient(book);
    for (let i = 0; i < 3; i++) book.acquire("k", 4, "subagent");
    const waits: number[] = [];
    const f = budgetFetch(async () => ok(), { client, key: "k", rpm: 4, priority: "subagent", maxWaitMs: 5_000, sleep: async (ms) => void waits.push(ms) });
    expect((await f("https://gw/chat")).status).toBe(200);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(5_000);
  });

  it("maxWaitScope total: one allowance across every call (a pi request and its 429 resends)", async () => {
    const book = new ModelBudgetBook(clock().now);
    const { client } = bookClient(book);
    for (let i = 0; i < 4; i++) book.acquire("k", 4, "main");
    const waits: number[] = [];
    const f = budgetFetch(async () => ok(), { client, key: "k", rpm: 4, priority: "main", maxWaitMs: 5_000, maxWaitScope: "total", sleep: async (ms) => void waits.push(ms) });
    await f("https://gw/chat");
    await f("https://gw/chat");
    expect(waits.reduce((a, b) => a + b, 0)).toBe(5_000);
  });

  it("fails open when the budget client throws synchronously", async () => {
    const client = {
      acquire: () => {
        throw new Error("no binding");
      },
      report429: () => {
        throw new Error("no binding");
      },
    } as unknown as ModelBudgetClient;
    const f = budgetFetch(async () => rateLimited(), { client, key: "k", rpm: 4, priority: "main" });
    expect((await f("https://gw/chat")).status).toBe(429);
  });

  it("does not wait for report429 before returning the 429", async () => {
    const client: ModelBudgetClient = { acquire: async () => ({ ok: true, waitMs: 0, used: 1, limit: 4, cap: 4 }), report429: () => new Promise(() => {}) };
    const f = budgetFetch(async () => rateLimited(), { client, key: "k", rpm: 4, priority: "main", callTimeoutMs: 60_000 });
    const started = Date.now();
    expect((await f("https://gw/chat")).status).toBe(429);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("fails open when the budget call hangs", async () => {
    const client: ModelBudgetClient = { acquire: () => new Promise(() => {}), report429: () => new Promise(() => {}) };
    const f = budgetFetch(async () => rateLimited(), { client, key: "k", rpm: 4, priority: "main", callTimeoutMs: 20 });
    expect((await f("https://gw/chat")).status).toBe(429);
  });

  it("honours the signal of a Request input", async () => {
    const book = new ModelBudgetBook(clock().now);
    const { client } = bookClient(book);
    for (let i = 0; i < 3; i++) book.acquire("k", 4, "subagent");
    const controller = new AbortController();
    controller.abort();
    const f = budgetFetch(async () => ok(), { client, key: "k", rpm: 4, priority: "subagent" });
    await expect(f(new Request("https://gw/chat", { signal: controller.signal }))).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails open when the budget call throws", async () => {
    const client: ModelBudgetClient = {
      acquire: async () => {
        throw new Error("DO down");
      },
      report429: async () => {
        throw new Error("DO down");
      },
    };
    const f = budgetFetch(async () => rateLimited(), { client, key: "k", rpm: 4, priority: "main" });
    expect((await f("https://gw/chat")).status).toBe(429);
  });

  it("reports a per-minute 429 with its Retry-After, but not a daily-limit 429", async () => {
    const book = new ModelBudgetBook(clock().now);
    const { client, reports } = bookClient(book);
    const responses = [rateLimited({ "retry-after": "7" }), rateLimited({}, JSON.stringify({ message: "daily free allocation exceeded" }))];
    const f = budgetFetch(async () => responses.shift()!, { client, key: "k", rpm: 50, priority: "main" });
    await f("https://gw/chat");
    await f("https://gw/chat");
    expect(reports).toEqual([{ key: "k", retryAfterMs: 7_000 }]);
  });

  it("an abort during the wait rejects and sends nothing", async () => {
    const book = new ModelBudgetBook(clock().now);
    const { client } = bookClient(book);
    for (let i = 0; i < 3; i++) book.acquire("k", 4, "subagent");
    let sent = 0;
    const controller = new AbortController();
    const f = budgetFetch(async () => (sent++, ok()), { client, key: "k", rpm: 4, priority: "subagent" });
    const pending = f("https://gw/chat", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(sent).toBe(0);
  });

  it("withModelBudget leaves non-Workers-AI models alone", () => {
    const base = (async () => ok()) as typeof fetch;
    const e = { SHARED_INDEX: (env as unknown as Env).SHARED_INDEX } as unknown as Env;
    expect(withModelBudget(base, { env: e, gateway: "ai-gateway", modelId: "anthropic/claude-sonnet-4-6", priority: "main" })).toBe(base);
    expect(withModelBudget(base, { env: e, gateway: "ai-gateway", modelId: "@cf/moonshotai/kimi-k2.6", priority: "main" })).not.toBe(base);
  });
});

describe("main turn + subagents share one budget", () => {
  const sse = (text: string) =>
    new Response(
      [
        { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: text } }] },
        { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]
        .map((c) => `data: ${JSON.stringify(c)}\n\n`)
        .join("") + "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

  it("a subagent fan-out that fills its share leaves the main turn room to run", async () => {
    const MODEL = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
    const c = clock();
    const book = new ModelBudgetBook(c.now);
    const { client } = bookClient(book);
    const e = { AI_GATEWAY_KEY: "k" } as unknown as Env;

    // Fan-out: 45 subagent requests try to go out at once against a 50/min cap.
    let subSent = 0;
    const subFetch = withModelBudget(async () => (subSent++, new Response("{}")), {
      env: e,
      gateway: "ai-gateway",
      modelId: MODEL,
      priority: "subagent",
      client,
      maxWaitMs: 0,
    });
    for (let i = 0; i < 45; i++) await subFetch("https://gw/chat");
    // maxWaitMs 0: the over-budget ones went out unthrottled, but only 37 took a slot.
    expect(book.snapshot()[0].used).toBe(37);

    // The main turn, through the real pi provider stack: budget under the 429 retry.
    const waits: number[] = [];
    const model = dodoModel(MODEL, { activeGateway: "ai-gateway", opencodeBaseURL: "", aiGatewayBaseURL: "https://gw.example/v1" }, e);
    const api = withModelBudgetStreams(withRateLimitRetry(openAICompletionsApi(), { sleep: async (ms) => void waits.push(ms) }), {
      env: e,
      gateway: "ai-gateway",
      client,
    });
    const responses = [rateLimited({ "retry-after": "1" }), sse("hello")];
    let mainSent = 0;
    const base = (async () => (mainSent++, responses.shift()!)) as typeof fetch;
    const message = await api
      .stream(model, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }), { apiKey: "unused", fetch: base })
      .result();
    expect(message.stopReason).toBe("stop");
    expect(mainSent).toBe(2);
    // Both main sends (the first and the 429 resend) took a slot from the reserve.
    const snap = book.snapshot()[0];
    expect(snap.used).toBe(39);
    expect(snap.rateLimited).toBe(1);
    expect(snap.cap).toBe(37);
    // ...and subagents are now held back by the 429's cooldown.
    expect(book.acquire(budgetKey("ai-gateway", MODEL), 50, "subagent").ok).toBe(false);
    expect(subSent).toBe(45);
  });
});

describe("SharedIndex budget RPC", () => {
  it("acquire and report429 go to one book per deployment; GET /model-budget shows it", async () => {
    const client = sharedIndexBudgetClient(env as unknown as Env);
    const key = `test:${crypto.randomUUID()}`;
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await client.acquire(key, 4, "subagent"));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect((await client.acquire(key, 4, "main")).ok).toBe(true);
    await client.report429(key, 4, 3_000);
    const stub = (env as unknown as Env).SHARED_INDEX.get((env as unknown as Env).SHARED_INDEX.idFromName("global"));
    const res = await stub.fetch("https://shared-index/model-budget");
    const { budgets } = (await res.json()) as { budgets: Array<{ key: string; used: number; rateLimited: number; cap: number }> };
    expect(budgets.find((b) => b.key === key)).toMatchObject({ used: 4, rateLimited: 1, cap: 3 });
  });
});

describe("subagent provider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("Workers AI subagent requests take a subagent slot from the SharedIndex budget", async () => {
    const model = `@cf/test/${crypto.randomUUID()}`;
    const e = { ...(env as unknown as Env), AI_GATEWAY_KEY: "k", MODEL_RPM_LIMITS: JSON.stringify({ [model]: 4 }) } as Env;
    const config = { activeGateway: "ai-gateway", aiGatewayBaseURL: "https://gw.example/v1", opencodeBaseURL: "" } as unknown as AppConfig;
    let sent = 0;
    vi.stubGlobal("fetch", async () => {
      sent++;
      return Response.json({ id: "1", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
    });
    const provider = buildProviderForModel(model, config, e, "sess-1");
    await generateText({ model: provider.chatModel(model), prompt: "hi" });
    expect(sent).toBe(1);
    const stub = e.SHARED_INDEX.get(e.SHARED_INDEX.idFromName("global"));
    const { budgets } = (await (await stub.fetch("https://shared-index/model-budget")).json()) as { budgets: Array<{ key: string; used: number; rpm: number }> };
    expect(budgets.find((b) => b.key === `ai-gateway:${model}`)).toMatchObject({ used: 1, rpm: 4 });
  });
});
