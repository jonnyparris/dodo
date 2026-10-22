// Fail a model request that goes quiet, so pi's retry can take over.
//
// On 10-21 a session (f25c9901) sat in one turn for 30 minutes with no AI
// Gateway traffic until an outside abort ended it. Nothing inside Dodo
// noticed. pi-ai's openai-completions client only times out until the
// response headers arrive (OpenAI SDK default: 600s), and nothing at all
// watches a stream that stops sending after the headers.
//
// This wrapper starts a timer when the request starts and resets it on
// every stream event (and on every raw provider event, for adapters that
// report them, so Anthropic pings count). If the timer runs out, it aborts
// the request and ends the stream with an error message that pi-ai's
// retry classifier treats as transient ("timeout"). pi-durable then retries
// the generation with its normal backoff (engine SETTINGS.retry). The
// error ends the stream at once, even if the provider ignores the abort,
// so a fetch that never settles can't hold the turn.
//
// A caller abort is not a timeout: it passes through as "aborted".

import type { AssistantMessage, AssistantMessageEvent, Model, ProviderStreams, StreamOptions } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { combineAbortSignals } from "@earendil-works/pi-ai/utils/abort-signals";

/**
 * Longest silence allowed before the first event and between events.
 * Generous on purpose: models whose reasoning isn't streamed can be quiet
 * for minutes before the first token, and a false positive costs a full
 * retry of the request. The 429 wait in rate-limit-fetch.ts (at most 60s
 * per request) sits inside this window.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 5 * 60_000;

export interface StreamIdleTimeoutInfo {
  model: string;
  idleMs: number;
  /** Stream events seen before the stall; 0 means it stalled before the first one (request or headers). */
  events: number;
}

export interface StreamIdleTimeoutOptions {
  idleMs?: number;
  /** Called once when a request is timed out (logging). */
  onTimeout?: (info: StreamIdleTimeoutInfo) => void;
}

/** The error text. Must stay matched by pi-ai's RETRYABLE pattern ("timeout"). */
export function streamIdleTimeoutMessage(idleMs: number, events: number): string {
  const where = events === 0 ? "before the first response event" : `after ${events} events`;
  return `Model stream idle timeout: no data for ${Math.round(idleMs / 1000)}s ${where}`;
}

// Scratch fields pi-ai's adapters use while a block is still streaming.
const SCRATCH_FIELDS = ["index", "partialArgs", "customInput", "streamIndex"] as const;

function timedOutMessage(model: Model<never>, partial: AssistantMessage | undefined, errorMessage: string): AssistantMessage {
  const base: AssistantMessage = partial
    ? structuredClone(partial)
    : {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        timestamp: Date.now(),
      };
  for (const block of base.content) for (const field of SCRATCH_FIELDS) delete (block as unknown as Record<string, unknown>)[field];
  return { ...base, stopReason: "error", errorMessage };
}

function guard<O extends StreamOptions | undefined>(
  run: (options: O) => AssistantMessageEventStream,
  model: Model<never>,
  options: O,
  idleMs: number,
  onTimeout: StreamIdleTimeoutOptions["onTimeout"],
): AssistantMessageEventStream {
  const out = new AssistantMessageEventStream();
  const idle = new AbortController();
  const combined = combineAbortSignals([options?.signal, idle.signal]);
  let events = 0;
  let partial: AssistantMessage | undefined;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const finish = () => {
    finished = true;
    clearTimeout(timer);
    combined.cleanup();
  };
  const fire = () => {
    if (finished) return;
    // A caller abort racing the timer wins: the provider reports it as aborted.
    if (options?.signal?.aborted) return;
    finish();
    onTimeout?.({ model: model.id, idleMs, events });
    const error = timedOutMessage(model, partial, streamIdleTimeoutMessage(idleMs, events));
    idle.abort(new Error(error.errorMessage));
    out.push({ type: "error", reason: "error", error });
    out.end();
  };
  const arm = () => {
    clearTimeout(timer);
    if (!finished) timer = setTimeout(fire, idleMs);
  };

  const inner = run({
    ...options,
    signal: combined.signal,
    onProviderStreamEvent: async (data: unknown, m: Model<never>) => {
      arm();
      await options?.onProviderStreamEvent?.(data, m);
    },
  } as O);
  arm();

  (async () => {
    try {
      for await (const event of inner as AsyncIterable<AssistantMessageEvent>) {
        if (finished) return;
        events++;
        if ("partial" in event) partial = event.partial;
        if (event.type === "done" || event.type === "error") {
          finish();
          out.push(event);
          out.end();
          return;
        }
        arm();
        out.push(event);
      }
      if (finished) return;
      // Ended without a terminal event: hand on whatever result it settled with.
      finish();
      out.end(await inner.result());
    } catch (error) {
      if (finished) return;
      finish();
      const message = timedOutMessage(model, partial, error instanceof Error ? error.message : String(error));
      out.push({ type: "error", reason: options?.signal?.aborted ? "aborted" : "error", error: { ...message, stopReason: options?.signal?.aborted ? "aborted" : "error" } });
      out.end();
    }
  })();
  return out;
}

/** Wrap both stream entry points with the idle timeout (see top of file). */
export function withStreamIdleTimeout(api: ProviderStreams, opts: StreamIdleTimeoutOptions = {}): ProviderStreams {
  const idleMs = opts.idleMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  return {
    ...api,
    stream: (model, context, options) => guard((o) => api.stream(model, context, o), model as Model<never>, options, idleMs, opts.onTimeout),
    streamSimple: (model, context, options) => guard((o) => api.streamSimple(model, context, o), model as Model<never>, options, idleMs, opts.onTimeout),
  };
}
