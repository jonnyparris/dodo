/**
 * AI Gateway `/compat` calls (OpenAI, Google, DeepSeek, `@cf/` off the run
 * path) go over the `AI` binding's universal endpoint with provider
 * "compat", so they need no AI_GATEWAY_KEY. These tests pin the routing,
 * the absence of key headers, the kill switch and the Google id.
 */
import { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compatBindingFetch, compatBindingGatewayId } from "../src/cloudflare-ai";
import { gatewayHeaders, withCompatBinding, withRateLimitRetry } from "../src/pi/models";
import { buildProviderForModel, resolveWireModelId } from "../src/subagent-runner";
import type { AppConfig, Env } from "../src/types";
import { fakeAIBinding } from "./helpers/fake-ai-binding";

const BASE = "https://gateway.ai.cloudflare.com/v1/acc/gw/compat";
const config = { activeGateway: "ai-gateway", aiGatewayBaseURL: BASE, opencodeBaseURL: "https://opencode.example/v1" } as unknown as AppConfig;
const completion = {
  id: "1", object: "chat.completion", created: 1, model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const envWith = (AI: Ai, extra: Partial<Env> = {}) =>
  ({ AI, AI_GATEWAY_KEY: "aig-key", OPENCODE_GATEWAY_TOKEN: "oc", CLOUDFLARE_ACCOUNT_ID: "acc", ...extra }) as unknown as Env;

afterEach(() => vi.unstubAllGlobals());

describe("compatBindingGatewayId", () => {
  it("follows bindingGatewayId and honours COMPAT_VIA_BINDING=0", () => {
    const env = { AI: {} as Ai, CLOUDFLARE_ACCOUNT_ID: "acc" };
    expect(compatBindingGatewayId(config, env)).toBe("gw");
    expect(compatBindingGatewayId(config, { ...env, COMPAT_VIA_BINDING: "0" })).toBeUndefined();
    expect(compatBindingGatewayId(config, { ...env, CLOUDFLARE_ACCOUNT_ID: "other" })).toBeUndefined();
    expect(compatBindingGatewayId({ ...config, activeGateway: "opencode" }, env)).toBeUndefined();
  });
});

describe("compatBindingFetch", () => {
  it("sends a /compat POST as a universal 'compat' request without auth headers", async () => {
    const { binding, calls } = fakeAIBinding(() => json(completion));
    const base = vi.fn(async () => new Response("http"));
    const f = compatBindingFetch(binding, "gw", `${BASE}/`, base);
    const res = await f(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-aig-authorization": "Bearer k", "x-api-key": "k", authorization: "Bearer x", "cf-aig-metadata": "{\"a\":\"b\"}", "x-session-affinity": "s1" },
      body: JSON.stringify({ model: "openai/gpt-4.1-mini", stream: true }),
      signal: new AbortController().signal,
    });
    expect(await res.json()).toMatchObject({ id: "1" });
    expect(base).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.gatewayId).toBe("gw");
    expect(c.request).toMatchObject({ provider: "compat", endpoint: "chat/completions", query: { model: "openai/gpt-4.1-mini", stream: true } });
    expect(c.request.headers).toEqual({ "content-type": "application/json", "cf-aig-metadata": "{\"a\":\"b\"}", "x-session-affinity": "s1" });
    // The signal stays on this side of the RPC boundary (the fake throws otherwise).
    expect(c.options ?? {}).toEqual({});
  });

  it("passes a gateway error Response through untouched (rate-limit retry still sees the 429)", async () => {
    const { binding } = fakeAIBinding(() => json({ error: "slow down" }, 429));
    const res = await compatBindingFetch(binding, "gw", BASE)(`${BASE}/chat/completions`, { method: "POST", body: "{}" });
    expect(res.status).toBe(429);
  });

  it("leaves other URLs and methods on the base fetch, Request bodies intact; throws on a non-JSON /compat body", async () => {
    const { binding, calls } = fakeAIBinding(() => json(completion));
    const bodies: string[] = [];
    const base = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(input instanceof Request ? await input.text() : String(init?.body ?? ""));
      return new Response("http");
    });
    const f = compatBindingFetch(binding, "gw", BASE, base as typeof fetch);
    await f("https://example.com/x", { method: "POST", body: "{}" });
    await f(new Request("https://example.com/y", { method: "POST", body: "{\"r\":1}" }));
    await f(`${BASE}/models`);
    expect(bodies).toEqual(["{}", "{\"r\":1}", ""]);
    await expect(f(`${BASE}/chat/completions`, { method: "POST", body: "not json" })).rejects.toThrow(/not JSON/);
    expect(calls).toHaveLength(0);
  });

  it("accepts a Request input for /compat", async () => {
    const { binding, calls } = fakeAIBinding(() => json(completion));
    const f = compatBindingFetch(binding, "gw", BASE, vi.fn() as never);
    const res = await f(new Request(`${BASE}/chat/completions`, { method: "POST", headers: { "x-api-key": "k" }, body: "{\"model\":\"m\"}" }));
    expect(res.status).toBe(200);
    expect(calls[0].request).toMatchObject({ endpoint: "chat/completions", query: { model: "m" } });
    expect(calls[0].request.headers["x-api-key"]).toBeUndefined();
  });

  it("stops the body and rejects the read when the caller aborts mid-stream", async () => {
    let cancelled = false;
    const { binding } = fakeAIBinding(() => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode("data: 1\n\n")); },
      cancel() { cancelled = true; },
    })));
    const ac = new AbortController();
    const res = await compatBindingFetch(binding, "gw", BASE)(`${BASE}/chat/completions`, { method: "POST", body: "{}", signal: ac.signal });
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await expect(reader.read()).rejects.toBeDefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(cancelled).toBe(true);
  });
});

describe("subagents on /compat", () => {
  function captureFetch() {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      urls.push(String(url instanceof Request ? url.url : url));
      return json(completion);
    });
    return urls;
  }

  it("go over the binding with no key for @cf/, OpenAI and Google", async () => {
    const http = captureFetch();
    const { binding, calls } = fakeAIBinding(() => json(completion));
    for (const id of ["@cf/moonshotai/kimi-k2.6", "openai/gpt-4.1-mini", "google/gemini-2.5-flash"]) {
      const res = await generateText({ model: buildProviderForModel(id, config, envWith(binding), "sess-1").chatModel(id), prompt: "hi" });
      expect(res.text).toBe("ok");
    }
    expect(http).toHaveLength(0);
    expect(calls.map((c) => c.request.query.model)).toEqual(["workers-ai/@cf/moonshotai/kimi-k2.6", "openai/gpt-4.1-mini", "google-ai-studio/gemini-2.5-flash"]);
    for (const c of calls) {
      expect(c.request.provider).toBe("compat");
      expect(c.request.endpoint).toBe("chat/completions");
      expect(JSON.stringify(c)).not.toContain("aig-key");
      expect(c.request.headers["x-session-affinity"]).toBe("sess-1");
      expect(JSON.parse(c.request.headers["cf-aig-metadata"])).toEqual({ dodo_session: "sess-1", dodo_role: "subagent" });
    }
  });

  it("use HTTP with the key when COMPAT_VIA_BINDING=0 or the binding can't reach the gateway", async () => {
    const http = captureFetch();
    const { binding, calls } = fakeAIBinding(() => json(completion));
    await generateText({ model: buildProviderForModel("openai/gpt-4.1-mini", config, envWith(binding, { COMPAT_VIA_BINDING: "0" })).chatModel("openai/gpt-4.1-mini"), prompt: "hi" });
    await generateText({ model: buildProviderForModel("openai/gpt-4.1-mini", config, envWith(binding, { CLOUDFLARE_ACCOUNT_ID: "other" })).chatModel("openai/gpt-4.1-mini"), prompt: "hi" });
    expect(http).toEqual([`${BASE}/chat/completions`, `${BASE}/chat/completions`]);
    expect(calls).toHaveLength(0);
  });
});

describe("main session on /compat", () => {
  it("gatewayHeaders drops the key when /compat goes over the binding", () => {
    const { binding } = fakeAIBinding(() => json(completion));
    const cfg = { ...config, sessionId: "s" } as never;
    expect(gatewayHeaders(cfg, envWith(binding))).toEqual({ "cf-aig-metadata": JSON.stringify({ dodo_session: "s", dodo_role: "main" }), Authorization: null });
    expect(gatewayHeaders(cfg, envWith(binding, { COMPAT_VIA_BINDING: "0" }))).toMatchObject({ "cf-aig-authorization": "Bearer aig-key", "x-api-key": "aig-key" });
  });

  it("the 429 wait wraps the binding fetch (withCompatBinding outside withRateLimitRetry)", async () => {
    let n = 0;
    const { binding, calls } = fakeAIBinding(() => (++n === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "0" } }) : json(completion)));
    let status = 0;
    const inner = { stream: (_m: unknown, _c: unknown, o?: { fetch?: typeof fetch }) => { void o!.fetch!(`${BASE}/chat/completions`, { method: "POST", body: "{}" }).then((r) => { status = r.status; }); return undefined; }, streamSimple: () => undefined } as never;
    const api = withCompatBinding(withRateLimitRetry(inner, { sleep: async () => {} } as never), config as never, envWith(binding));
    (api as { stream: Function }).stream({ baseUrl: BASE }, {}, {});
    await vi.waitFor(() => expect(status).toBe(200));
    expect(calls).toHaveLength(2);
  });

  it("withCompatBinding sets the binding fetch for /compat models only, keeping the caller's fetch as base", async () => {
    const { binding, calls } = fakeAIBinding(() => json(completion));
    const seen: Array<typeof fetch | undefined> = [];
    const api = { stream: (_m: unknown, _c: unknown, o?: { fetch?: typeof fetch }) => (seen.push(o?.fetch), undefined), streamSimple: () => undefined } as never;
    const callerFetch = vi.fn(async () => new Response("caller"));
    const wrapped = withCompatBinding(api, config as never, envWith(binding));
    (wrapped as { stream: Function }).stream({ baseUrl: BASE }, {}, { fetch: callerFetch });
    (wrapped as { stream: Function }).stream({ baseUrl: "https://opencode.example/v1" }, {}, { fetch: callerFetch });
    expect(seen[1]).toBe(callerFetch);
    await seen[0]!(`${BASE}/chat/completions`, { method: "POST", body: "{}" });
    expect(calls).toHaveLength(1);
    await seen[0]!("https://elsewhere.example/", { method: "POST", body: "{}" });
    expect(callerFetch).toHaveBeenCalledTimes(1);
    expect(withCompatBinding(api, config as never, envWith(binding, { COMPAT_VIA_BINDING: "0" }))).toBe(api);
  });
});

describe("resolveWireModelId for Google", () => {
  it("spells Google as google-ai-studio on AI Gateway only", () => {
    expect(resolveWireModelId("google/gemini-2.5-flash", "ai-gateway")).toBe("google-ai-studio/gemini-2.5-flash");
    expect(resolveWireModelId("google/gemini-2.5-flash", "opencode")).toBe("google/gemini-2.5-flash");
  });
});
