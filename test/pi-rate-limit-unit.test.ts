/**
 * pi main loop vs Workers AI per-minute rate limits (AiError 3021).
 *
 * Bench 10-21: a main session failed after pi's 3 harness retries (2s/4s/8s)
 * all landed in the same rate-limit minute. rateLimitFetch waits out 429s
 * inside the request, honouring Retry-After.
 */
import { describe, expect, it } from "vitest";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { rateLimitFetch, retryAfterMs } from "../src/pi/rate-limit-fetch";
import { createModels } from "@earendil-works/pi-ai/models";
import { agentModelRef, dodoModel, setDodoProvider, withRateLimitRetry } from "../src/pi/models";
import type { Env } from "../src/types";

const RPM_BODY = JSON.stringify({
  name: "AiError",
  internalCode: 3021,
  httpCode: 429,
  message: "AiError: AiError: rate limiting: inference request per min rate reached (x)",
  description: "rate limiting: inference request per min rate reached",
});

function rateLimited(headers: Record<string, string> = {}, body = RPM_BODY): Response {
  return new Response(body, { status: 429, headers: { "content-type": "application/json", ...headers } });
}

function scripted(responses: Array<() => Response>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body });
    const next = responses.shift();
    if (!next) throw new Error("no more scripted responses");
    return next();
  }) as typeof fetch;
  return { base, calls };
}

function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

describe("rateLimitFetch", () => {
  it("waits for Retry-After and resends the same request", async () => {
    const { base, calls } = scripted([() => rateLimited({ "retry-after": "7" }), () => new Response("ok")]);
    const { waits, sleep } = recordingSleep();
    const res = await rateLimitFetch(base, { sleep })("https://gw/chat", { method: "POST", body: '{"a":1}' });
    expect(res.status).toBe(200);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(7000); // plus up to 1s jitter
    expect(waits[0]).toBeLessThanOrEqual(8000);
    expect(calls.map((c) => c.body)).toEqual(['{"a":1}', '{"a":1}']);
  });

  it("backs off exponentially without Retry-After, until the 429 clears", async () => {
    const { base, calls } = scripted([() => rateLimited(), () => rateLimited(), () => rateLimited(), () => new Response("ok")]);
    const { waits, sleep } = recordingSleep();
    const res = await rateLimitFetch(base, { sleep, baseDelayMs: 4000 })("https://gw/chat", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(4);
    // 4s, 8s, 16s minus up to 25% jitter.
    expect(waits[0]).toBeGreaterThan(2999);
    expect(waits[0]).toBeLessThanOrEqual(4000);
    expect(waits[1]).toBeGreaterThan(5999);
    expect(waits[2]).toBeGreaterThan(11999);
  });

  it("covers a full rate-limit minute before giving up, then returns the 429", async () => {
    const { base, calls } = scripted(Array.from({ length: 20 }, () => () => rateLimited()));
    const { waits, sleep } = recordingSleep();
    const res = await rateLimitFetch(base, { sleep })("https://gw/chat", { method: "POST", body: "{}" });
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("3021");
    const total = waits.reduce((a, b) => a + b, 0);
    // pi's harness alone waits 14s; together with this the prompt rides out a 60s window.
    expect(total).toBeGreaterThan(40_000);
    expect(total).toBeLessThanOrEqual(60_000);
    expect(calls.length).toBe(waits.length + 1);
  });

  it("gives up at once when Retry-After is past the budget", async () => {
    const { base, calls } = scripted([() => rateLimited({ "retry-after": "3600" })]);
    const { waits, sleep } = recordingSleep();
    const res = await rateLimitFetch(base, { sleep })("https://gw/chat", { method: "POST", body: "{}" });
    expect(res.status).toBe(429);
    expect(waits).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("Retry-After: 0 can't become a tight resend loop", async () => {
    const { base, calls } = scripted(Array.from({ length: 100 }, () => () => rateLimited({ "retry-after": "0" })));
    const { waits, sleep } = recordingSleep();
    const res = await rateLimitFetch(base, { sleep })("https://gw", { method: "POST", body: "{}" });
    expect(res.status).toBe(429);
    expect(Math.min(...waits)).toBeGreaterThanOrEqual(1000);
    expect(new Set(waits).size).toBeGreaterThan(1); // jittered, not all exactly 1s
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60_000);
    expect(calls.length).toBeLessThanOrEqual(61);
  });

  it("short Retry-After values repeated for a whole minute are still ridden out", async () => {
    // 1-2s per wait: 30 rate-limited replies span 30-60s, then the window resets.
    const { base, calls } = scripted([...Array.from({ length: 30 }, () => () => rateLimited({ "retry-after": "1" })), () => new Response("ok")]);
    const { waits, sleep } = recordingSleep();
    expect((await rateLimitFetch(base, { sleep })("https://gw", { method: "POST", body: "{}" })).status).toBe(200);
    expect(calls).toHaveLength(31);
  });

  it("uses retry-after-ms for the wait", async () => {
    const { base } = scripted([() => rateLimited({ "retry-after-ms": "2500" }), () => new Response("ok")]);
    const { waits, sleep } = recordingSleep();
    await rateLimitFetch(base, { sleep })("https://gw", { method: "POST", body: "{}" });
    expect(waits[0]).toBeGreaterThanOrEqual(2500);
    expect(waits[0]).toBeLessThanOrEqual(3500);
  });

  it.each([
    ["OpenAI quota", '{"error":{"code":"insufficient_quota"}}', {}],
    ["OpenCode subscription limit", '{"type":"error","error":{"type":"GoUsageLimitError","message":"Monthly usage limit reached"}}', {}],
    ["Workers AI daily allocation", '{"internalCode":4006,"description":"you have used up your daily free allocation of 10,000 neurons"}', {}],
    ["OpenAI requests per day", '{"error":{"message":"Rate limit reached for requests per day (RPD)"}}', {}],
    ["x-should-retry: false", RPM_BODY, { "x-should-retry": "false" }],
  ])("does not wait on a 429 that won't clear: %s", async (_name, body, headers) => {
    const { base, calls } = scripted([() => rateLimited(headers as Record<string, string>, body as string)]);
    const { waits, sleep } = recordingSleep();
    expect((await rateLimitFetch(base, { sleep })("https://gw", { method: "POST", body: "{}" })).status).toBe(429);
    expect(waits).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("passes other statuses through untouched", async () => {
    const { base, calls } = scripted([() => new Response("boom", { status: 503 })]);
    const { waits, sleep } = recordingSleep();
    expect((await rateLimitFetch(base, { sleep })("https://gw", { method: "POST", body: "{}" })).status).toBe(503);
    expect(waits).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("does not resend a request whose body can only be read once", async () => {
    const { base, calls } = scripted([() => rateLimited()]);
    const { waits, sleep } = recordingSleep();
    const stream = new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode("{}")), c.close()) });
    const res = await rateLimitFetch(base, { sleep })("https://gw", { method: "POST", body: stream });
    expect(res.status).toBe(429);
    expect(waits).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("does not resend a Request object", async () => {
    const { base, calls } = scripted([() => rateLimited()]);
    const { waits, sleep } = recordingSleep();
    const res = await rateLimitFetch(base, { sleep })(new Request("https://gw", { method: "POST", body: "{}" }));
    expect(res.status).toBe(429);
    expect(waits).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("a Retry-After equal to the budget is honoured, capped at the budget", async () => {
    const { base, calls } = scripted([() => rateLimited({ "retry-after": "60" }), () => new Response("ok")]);
    const { waits, sleep } = recordingSleep();
    expect((await rateLimitFetch(base, { sleep })("https://gw", { method: "POST", body: "{}" })).status).toBe(200);
    expect(waits).toEqual([60_000]);
    expect(calls).toHaveLength(2);
  });

  it("an abort during the wait rejects with AbortError and sends nothing more", async () => {
    const { base, calls } = scripted([() => rateLimited({ "retry-after": "30" }), () => new Response("ok")]);
    const ctrl = new AbortController();
    let waiting!: () => void;
    const started = new Promise<void>((r) => (waiting = r));
    const p = rateLimitFetch(base, {
      onWait: () => waiting(),
    })("https://gw", { method: "POST", body: "{}", signal: ctrl.signal });
    await started;
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(1);
  });

  it("parses retry-after-ms, seconds and HTTP dates", () => {
    expect(retryAfterMs(new Headers({ "retry-after-ms": "1500" }))).toBe(1500);
    expect(retryAfterMs(new Headers({ "retry-after": "2" }))).toBe(2000);
    const now = Date.parse("2026-10-21T12:00:00Z");
    expect(retryAfterMs(new Headers({ "retry-after": "Wed, 21 Oct 2026 12:00:10 GMT" }), now)).toBe(10_000);
    expect(retryAfterMs(new Headers())).toBeUndefined();
  });
});

describe("pi gateway provider + rate limits", () => {
  const sse = (chunks: unknown[]) =>
    new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

  it("a Workers AI 3021 429 on the main model is waited out, not surfaced as the turn's error", async () => {
    const { base, calls } = scripted([
      () => rateLimited({ "retry-after": "1" }),
      () =>
        sse([
          { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "hello" } }] },
          { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]),
    ]);
    const { waits, sleep } = recordingSleep();
    const env = { AI_GATEWAY_KEY: "k" } as unknown as Env;
    const model = dodoModel("@cf/deepseek-ai/deepseek-v4-flash", { activeGateway: "ai-gateway", opencodeBaseURL: "", aiGatewayBaseURL: "https://gw.example/v1" }, env);
    const api = withRateLimitRetry(openAICompletionsApi(), { sleep });
    const message = await api.stream(model, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }), { apiKey: "unused", fetch: base }).result();
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([expect.objectContaining({ type: "text", text: "hello" })]);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(1000);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://gw.example/v1/chat/completions");
  });

  it("setDodoProvider installs the waiting fetch on the real gateway provider", async () => {
    const { base, calls } = scripted([
      () => rateLimited({ "retry-after": "0" }),
      () =>
        sse([
          { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] },
          { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]),
    ]);
    const config = { activeGateway: "ai-gateway" as const, opencodeBaseURL: "", aiGatewayBaseURL: "https://gw.example/v1" };
    const models = setDodoProvider(createModels(), ["@cf/zai-org/glm-4.7-flash"], config, { AI_GATEWAY_KEY: "k" } as unknown as Env);
    const ref = agentModelRef("@cf/zai-org/glm-4.7-flash", config);
    const model = models.getModel(ref.provider, ref.modelId)!;
    const message = await models.complete(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { fetch: base });
    expect(message.stopReason).toBe("stop");
    expect(calls).toHaveLength(2);
  });
});
