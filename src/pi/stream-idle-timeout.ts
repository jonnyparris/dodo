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
// A caller abort is not a timeout: it passes through as "aborted". If the
// provider ignores a caller abort, the stream ends (as "aborted") after a
// short grace period (ABORT_GRACE_MS).
//
// Worst case for a request that always stalls: pi-durable makes 4 attempts
// (maxRetries 3), each with its own timer, so the turn fails after about
// 4 x 5 min = 20 min (plus 14s of backoff) instead of hanging until someone
// aborts it.

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

/** How long a provider gets to end its own stream after a caller abort. */
const ABORT_GRACE_MS = 1_000;

export interface StreamIdleTimeoutInfo {
  model: string;
  idleMs: number;
  /** pi stream events seen before the stall. */
  events: number;
  /** Raw provider events seen (only adapters that report them); both 0 means nothing came back at all. */
  providerEvents: number;
}

export interface StreamIdleTimeoutOptions {
  idleMs?: number;
  /** Called once when a request is timed out (logging). */
  onTimeout?: (info: StreamIdleTimeoutInfo) => void;
}

/** The error text. Must stay matched by pi-ai's RETRYABLE pattern ("timeout"). */
export function streamIdleTimeoutMessage(idleMs: number, events: number, providerEvents = 0): string {
  const where =
    events > 0 ? `after ${events} events` : providerEvents > 0 ? `after ${providerEvents} provider events` : "before the first response event";
  return `Model stream idle timeout: no data for ${Math.round(idleMs / 1000)}s ${where}`;
}

// Scratch fields pi-ai's adapters use while a block is still streaming.
const SCRATCH_FIELDS = ["index", "partialArgs", "customInput", "streamIndex"] as const;

function terminalMessage(model: Model<never>, partial: AssistantMessage | undefined, errorMessage: string): AssistantMessage {
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
  let providerEvents = 0;
  let partial: AssistantMessage | undefined;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onCallerAbort = () => {
    clearTimeout(timer);
    if (!finished) timer = setTimeout(fire, ABORT_GRACE_MS);
  };
  const finish = () => {
    finished = true;
    clearTimeout(timer);
    options?.signal?.removeEventListener("abort", onCallerAbort);
    combined.cleanup();
  };
  const end = (reason: "error" | "aborted", errorMessage: string) => {
    const error = terminalMessage(model, partial, errorMessage);
    out.push({ type: "error", reason, error: { ...error, stopReason: reason } });
    out.end();
  };
  function fire() {
    if (finished) return;
    if (options?.signal?.aborted) {
      // Caller aborted and the provider never ended the stream: end it for them.
      finish();
      end("aborted", "Request was aborted");
      return;
    }
    const message = streamIdleTimeoutMessage(idleMs, events, providerEvents);
    // Abort before finish(): cleanup() detaches idle.signal from the combined signal.
    idle.abort(new Error(message));
    finish();
    end("error", message);
    try {
      onTimeout?.({ model: model.id, idleMs, events, providerEvents });
    } catch {
      // Logging only; the stream has already ended.
    }
  }
  const arm = () => {
    // After a caller abort only the grace timer runs; late events must not cancel it.
    if (finished || options?.signal?.aborted) return;
    clearTimeout(timer);
    timer = setTimeout(fire, idleMs);
  };

  let inner: AssistantMessageEventStream;
  try {
    inner = run({
      ...options,
      signal: combined.signal,
      onProviderStreamEvent: async (data: unknown, m: Model<never>) => {
        providerEvents++;
        arm();
        await options?.onProviderStreamEvent?.(data, m);
      },
    } as O);
  } catch (error) {
    finish();
    throw error;
  }
  options?.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (options?.signal?.aborted) onCallerAbort();
  else arm();

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
      // pi-ai adapters always end with done/error; if one doesn't, its result() may never settle.
      finish();
      end(options?.signal?.aborted ? "aborted" : "error", "Model stream ended without a terminal event");
    } catch (error) {
      if (finished) return;
      finish();
      end(options?.signal?.aborted ? "aborted" : "error", error instanceof Error ? error.message : String(error));
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
