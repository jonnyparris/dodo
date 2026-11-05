/**
 * A model request that goes quiet fails as a retryable error instead of
 * hanging the turn (10-21: session f25c9901 sat 30 min until an outside abort).
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { AssistantMessage, AssistantMessageEvent, ProviderStreams } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { PiEngine, type PiEngineHost } from "../src/pi/engine";
import { buildToolsExtension } from "../src/pi/tools";
import { dodoModel } from "../src/pi/models";
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, streamIdleTimeoutMessage, withStreamIdleTimeout, type StreamIdleTimeoutInfo } from "../src/pi/stream-idle-timeout";
import type { Env } from "../src/types";

const config = { activeGateway: "ai-gateway" as const, opencodeBaseURL: "", aiGatewayBaseURL: "https://gw.example/v1" };
const model = dodoModel("@cf/zai-org/glm-4.7-flash", config, { AI_GATEWAY_KEY: "k" } as unknown as Env);
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
const enc = new TextEncoder();
const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  enc.encode(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fetch whose SSE body sends `before`, then goes quiet (until aborted). */
function stallingFetch(before: Uint8Array[]) {
  let aborted = false;
  const f = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const b of before) c.enqueue(b);
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          c.error(init.signal?.reason ?? new Error("aborted"));
        });
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { fetch: f, wasAborted: () => aborted };
}

function collect() {
  const timeouts: StreamIdleTimeoutInfo[] = [];
  return { timeouts, onTimeout: (i: StreamIdleTimeoutInfo) => void timeouts.push(i) };
}

describe("withStreamIdleTimeout (real openai-completions adapter)", () => {
  // The adapter is lazy-loaded: its first call pays the module import, which
  // would count against the short test timeouts below.
  beforeAll(async () => {
    const f = (async () => new Response(chunk({ content: "w" }, "stop"), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    await openAICompletionsApi().streamSimple(model, context, { apiKey: "unused", fetch: f }).result();
  });

  it("fails a stream that goes quiet after the headers as a retryable error, keeping the partial text", async () => {
    const { fetch, wasAborted } = stallingFetch([chunk({ role: "assistant", content: "hel" })]);
    const { timeouts, onTimeout } = collect();
    const api = withStreamIdleTimeout(openAICompletionsApi(), { idleMs: 100, onTimeout });
    const message = await api.streamSimple(model, context, { apiKey: "unused", fetch }).result();
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toMatch(/^Model stream idle timeout: no data for 0s after \d+ events$/);
    expect(isRetryableAssistantError(message)).toBe(true);
    expect(message.content).toEqual([{ type: "text", text: "hel" }]);
    expect(timeouts).toEqual([expect.objectContaining({ idleMs: 100 })]);
    expect(timeouts[0]!.events).toBeGreaterThan(0);
    expect(message.errorMessage).toBe(streamIdleTimeoutMessage(100, timeouts[0]!.events, timeouts[0]!.providerEvents));
    expect(wasAborted()).toBe(true);
  });

  it("fails a request that never gets headers, even if the fetch ignores the abort", async () => {
    const never = (() => new Promise<Response>(() => {})) as typeof fetch;
    const { timeouts, onTimeout } = collect();
    const api = withStreamIdleTimeout(openAICompletionsApi(), { idleMs: 100, onTimeout });
    const message = await api.stream(model, context, { apiKey: "unused", fetch: never }).result();
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe(streamIdleTimeoutMessage(100, 0));
    expect(isRetryableAssistantError(message)).toBe(true);
    expect(message.content).toEqual([]);
    expect(message.model).toBe(model.id);
    expect(timeouts.map((t) => t.events)).toEqual([0]);
  });

  it("lets a slow but steady stream finish: each event resets the timer", async () => {
    const f = (async () => {
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          for (const piece of ["a", "b", "c", "d"]) {
            await sleep(150);
            c.enqueue(chunk({ content: piece }));
          }
          c.enqueue(chunk({}, "stop"));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const { timeouts, onTimeout } = collect();
    // 4 x 150ms = 600ms total, well past the 300ms idle limit, but no single gap reaches it.
    const api = withStreamIdleTimeout(openAICompletionsApi(), { idleMs: 300, onTimeout });
    const message = await api.streamSimple(model, context, { apiKey: "unused", fetch: f }).result();
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([expect.objectContaining({ type: "text", text: "abcd" })]);
    expect(timeouts).toEqual([]);
  });

  it("a caller abort stays an abort, not a timeout", async () => {
    const { fetch } = stallingFetch([chunk({ role: "assistant", content: "x" })]);
    const { timeouts, onTimeout } = collect();
    const api = withStreamIdleTimeout(openAICompletionsApi(), { idleMs: 200, onTimeout });
    const controller = new AbortController();
    const stream = api.streamSimple(model, context, { apiKey: "unused", fetch, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const message = await stream.result();
    expect(message.stopReason).toBe("aborted");
    await sleep(250);
    expect(timeouts).toEqual([]);
  });

  it("a caller abort ends the stream promptly even if the provider ignores it", async () => {
    const never = (() => new Promise<Response>(() => {})) as typeof fetch;
    const { timeouts, onTimeout } = collect();
    const api = withStreamIdleTimeout(openAICompletionsApi(), { idleMs: 60_000, onTimeout });
    const controller = new AbortController();
    const stream = api.stream(model, context, { apiKey: "unused", fetch: never, signal: controller.signal });
    const t0 = Date.now();
    controller.abort();
    const message = await stream.result();
    expect(message.stopReason).toBe("aborted");
    expect(Date.now() - t0).toBeLessThan(5_000); // the 1s grace, not the 60s idle limit
    expect(timeouts).toEqual([]);
  });

  it("a late event after a caller abort doesn't cancel the grace timer", async () => {
    let emit: (() => void) | undefined;
    const respond = () => {
      const s = new AssistantMessageEventStream();
      const partial = fauxAssistantMessage("");
      s.push({ type: "start", partial } as AssistantMessageEvent);
      emit = () => s.push({ type: "text_start", contentIndex: 0, partial } as AssistantMessageEvent);
      return s; // ignores the abort, then goes quiet
    };
    const api = withStreamIdleTimeout({ stream: respond, streamSimple: respond } as unknown as ProviderStreams, { idleMs: 60_000 });
    const controller = new AbortController();
    const stream = api.stream(model, context, { signal: controller.signal });
    const t0 = Date.now();
    controller.abort();
    await sleep(100);
    emit?.();
    const message = await stream.result();
    expect(message.stopReason).toBe("aborted");
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("a timeout aborts the provider request when the caller also passed a signal", async () => {
    const { fetch, wasAborted } = stallingFetch([chunk({ role: "assistant", content: "x" })]);
    const { timeouts, onTimeout } = collect();
    const api = withStreamIdleTimeout(openAICompletionsApi(), { idleMs: 100, onTimeout });
    const caller = new AbortController();
    const message = await api.streamSimple(model, context, { apiKey: "unused", fetch, signal: caller.signal }).result();
    expect(message.stopReason).toBe("error");
    expect(isRetryableAssistantError(message)).toBe(true);
    await sleep(20);
    expect(wasAborted()).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    expect(timeouts).toHaveLength(1);
  });

  it("raw provider events count as activity and are reported separately", async () => {
    const respond = (_m: unknown, _c: unknown, options?: { onProviderStreamEvent?: (d: unknown, m: unknown) => unknown }) => {
      const s = new AssistantMessageEventStream();
      // Pings every 60ms for 300ms, past the 100ms limit, then silence.
      let n = 0;
      const ping = setInterval(() => {
        void options?.onProviderStreamEvent?.({ type: "ping" }, model);
        if (++n === 5) clearInterval(ping);
      }, 60);
      return s;
    };
    const { timeouts, onTimeout } = collect();
    const api = withStreamIdleTimeout({ stream: respond, streamSimple: respond } as unknown as ProviderStreams, { idleMs: 100, onTimeout });
    const t0 = Date.now();
    const message = await api.stream(model, context, {}).result();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    expect(message.errorMessage).toBe("Model stream idle timeout: no data for 0s after 5 provider events");
    expect(timeouts).toEqual([expect.objectContaining({ events: 0, providerEvents: 5 })]);
  });

  it("default is 5 minutes, and the message stays retryable at that size", () => {
    expect(DEFAULT_STREAM_IDLE_TIMEOUT_MS).toBe(300_000);
    const message = { stopReason: "error", errorMessage: streamIdleTimeoutMessage(DEFAULT_STREAM_IDLE_TIMEOUT_MS, 0) } as AssistantMessage;
    expect(message.errorMessage).toBe("Model stream idle timeout: no data for 300s before the first response event");
    expect(isRetryableAssistantError(message)).toBe(true);
  });
});

describe("withStreamIdleTimeout + pi-durable retry", () => {
  it("a stalled first attempt is retried by the harness and the turn answers", async () => {
    const stub = (env as unknown as Env).CODING_AGENT.get((env as unknown as Env).CODING_AGENT.idFromName("pi-stream-idle-1"));
    await runInDurableObject(stub, async (_i, state) => {
      let calls = 0;
      const respond = (): AssistantMessageEventStream => {
        const s = new AssistantMessageEventStream();
        calls++;
        const partial = fauxAssistantMessage("");
        if (calls === 1) {
          // Opens the stream, then never sends another byte and ignores the abort.
          s.push({ type: "start", partial } as AssistantMessageEvent);
          return s;
        }
        const message = fauxAssistantMessage("recovered");
        s.push({ type: "start", partial } as AssistantMessageEvent);
        s.push({ type: "done", reason: "stop", message } as AssistantMessageEvent);
        s.end();
        return s;
      };
      const streams: ProviderStreams = { stream: respond, streamSimple: respond };
      const { timeouts, onTimeout } = collect();
      const host: PiEngineHost = {
        storage: state.storage,
        configureModels: (models) =>
          models.setProvider(
            createProvider({
              id: "stall",
              auth: { apiKey: { name: "stall", resolve: async () => ({ auth: {} }) } },
              models: [{ id: "stall-1", name: "stall-1", api: "stall", provider: "stall", baseUrl: "http://x", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 1000 }],
              api: withStreamIdleTimeout(streams, { idleMs: 100, onTimeout }),
            }),
          ),
        modelRef: () => ({ provider: "stall", modelId: "stall-1" }),
        systemPrompt: () => "You are Dodo.",
        emit: () => {},
        log: () => {},
      };
      const engine = new PiEngine(host);
      const result = await engine.run({
        promptId: "p1",
        prepare: async () => ({ content: "go", entry: { messageId: "u-go", text: "go", authorEmail: "a@b.c", createdAt: 1 } }),
        tools: await buildToolsExtension({}),
      });
      expect(result.status).toBe("done");
      expect(result.text).toBe("recovered");
      expect(calls).toBe(2);
      expect(timeouts.map((t) => t.events)).toEqual([1]);
      await engine.close();
    });
  });
});
