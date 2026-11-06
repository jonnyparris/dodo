import { describe, expect, it } from "vitest";
import { adaptBindingForCreateAI, runAsResponse } from "../src/cloudflare-ai";
import { fakeAIBinding } from "./helpers/fake-ai-binding";

describe("adaptBindingForCreateAI", () => {
  it("can be awaited without touching the stub's then", async () => {
    const { binding } = fakeAIBinding(() => new Response("{}"));
    const adapted = adaptBindingForCreateAI(binding);
    await expect(Promise.resolve(adapted)).resolves.toBe(adapted);
  });

  it("returns undefined for aiGatewayLogId instead of reading the stub", () => {
    const binding = { aiGatewayLogId: "log-1" } as unknown as Ai;
    expect((adaptBindingForCreateAI(binding) as unknown as { aiGatewayLogId: unknown }).aiGatewayLogId).toBeUndefined();
  });

  it("run strips the signal and goes through retry", async () => {
    const { binding, runCalls } = fakeAIBinding(() => new Response("{}"), () => new Response("ok"));
    let retried = 0;
    const adapted = adaptBindingForCreateAI(binding, (send) => {
      retried++;
      return send();
    });
    const res = (await (adapted as unknown as { run: (...a: unknown[]) => Promise<Response> }).run("@cf/x", { prompt: "hi" }, { signal: new AbortController().signal, returnRawResponse: true })) as Response;
    expect(await res.text()).toBe("ok");
    expect(retried).toBe(1);
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].options).toEqual({ returnRawResponse: true });
  });

  it("fetch (createAI's provider-native path and stream resume) strips the signal and still honours it", async () => {
    const { binding, calls } = fakeAIBinding(() => new Response("ok"));
    const adapted = adaptBindingForCreateAI(binding) as unknown as { fetch: (input: string, init?: RequestInit) => Promise<Response> };
    const url = "https://workers-binding.ai/ai-gateway/gateways/gw/anthropic/v1/messages";
    const res = await adapted.fetch(url, { method: "POST", body: "{}", signal: new AbortController().signal });
    expect(await res.text()).toBe("ok");
    expect(calls).toHaveLength(1);
    const aborted = new AbortController();
    aborted.abort();
    await expect(adapted.fetch(url, { method: "POST", body: "{}", signal: aborted.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(1);
  });

  it("run turns a thrown AiError 3021 into a 429 Response", async () => {
    const { binding } = fakeAIBinding(() => new Response("{}"), () => {
      throw new Error("AiError: 3021: per min rate reached");
    });
    const adapted = adaptBindingForCreateAI(binding);
    const res = await (adapted as unknown as { run: (...a: unknown[]) => Promise<Response> }).run("@cf/x", {}, {});
    expect(res.status).toBe(429);
  });
});

describe("runAsResponse", () => {
  it("turns a thrown httpCode 429 into a 429 Response", async () => {
    const res = await runAsResponse(() => Promise.reject(Object.assign(new Error("x"), { httpCode: 429 })));
    expect(res.status).toBe(429);
  });

  it("rethrows errors that aren't rate limits", async () => {
    await expect(runAsResponse(() => Promise.reject(new Error("boom 3021 later")))).rejects.toThrow("boom");
  });
});
