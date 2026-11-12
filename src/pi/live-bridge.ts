// LiveBridge: turns pi-durable's conversation view (Conversation.watch():
// transcript entries + the `pi.live` document) into Dodo's SSE events.
//
// pi 1.5 removed watchEvents(). A watch delivers the newest view; commits
// made while the listener runs arrive folded into one call, and the view's
// entries are a window (PiEngine's WATCH_WINDOW: the newest 24, appends,
// trimmed back to 24 past 64; render() pages what a trim skipped). So the
// bridge renders state, it doesn't replay events:
//
//   - New transcript entries drive everything the turn result or the chat
//     depends on: each step's final text, tool_call (from the tool-calling
//     answer's toolCall blocks), tool_result (pi.tool-result entries), steps
//     and usage. Entries arrive in order, survive folding, and can be re-read
//     (`loadEntries`), so none is missed or emitted twice.
//   - `pi.live` drives only what a fold may skip without harm: the streaming
//     partial, the turn stall guard's snapshot, and log lines.
//
// apply() never throws: a throwing watch listener ends the watch.

import type { AssistantMessage, ImageContent, TextContent, ToolCall } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord, LiveState } from "@earendil-works/pi-durable";
import type { TurnStallProgress } from "../turn-stall-guard";

/**
 * What the turn stall guard needs from each view: a full snapshot, not a
 * delta. Open tool calls include pending ones: after a restart a running
 * call can show pending.
 */
export type PiTurnProgress = TurnStallProgress;

export interface LiveBridgeTotals {
  steps: number;
  input: number;
  output: number;
  /** Context size of the last assistant step. */
  context: number;
  toolCalls: string[];
}

export interface LiveBridgeHost {
  emit(event: { type: string; data: unknown }): void;
  log(level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>): void;
  onProgress?(progress: PiTurnProgress): void;
  /** Entries with `min <= id <= max` (max open when absent), oldest first. */
  loadEntries(min: number, max?: number): Promise<readonly EntryRecord[]>;
}

interface PendingCall {
  name: string;
  input: unknown;
  emitted: boolean;
}

export function messageText(message: { content?: unknown } | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

const liveOf = (view: ConversationView): LiveState => (view.docs["pi.live"] ?? {}) as unknown as LiveState;
const idOf = (entry: EntryRecord): number => Number(entry.id);

export class LiveBridge {
  readonly totals: LiveBridgeTotals = { steps: 0, input: 0, output: 0, context: 0, toolCalls: [] };
  /** Newest entry id already handled. */
  private lastSeen = 0;
  /** Text of the current generation attempt already sent as text_delta. */
  private streamed = "";
  /** `${run.taskId}:${attempt}` of the attempt `streamed` belongs to. */
  private streamKey = "";
  /** Key of the last attempt whose answer entry was handled: its stale partial must not stream again. */
  private finishedKey = "";
  private readonly calls = new Map<string, PendingCall>();
  private retryAt: number | undefined;
  private compactions = new Set<string>();
  private compactionFailure: string | undefined;
  private runFailure: string | undefined;
  /** Serialises apply()/catchUp(): a gap load awaits. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly host: LiveBridgeHost) {}

  /**
   * The watch's first value is the baseline: its entries (earlier turns, or a
   * recovered turn's earlier steps) are not re-emitted, nor the partial
   * streamed so far. Tool calls of the newest answer still waiting for a
   * result get their tool_call before that result arrives.
   */
  attach(view: ConversationView): void {
    const entries = view.entries;
    const last = entries.at(-1);
    this.lastSeen = last ? idOf(last) : view.before !== undefined ? Number(view.before) : 0;
    const results = new Set<string>();
    let answer: EntryRecord | undefined;
    for (const entry of entries) {
      if (entry.kind === "pi.tool-result") {
        const id = (entry.model?.[0] as { toolCallId?: string } | undefined)?.toolCallId;
        if (id) results.add(id);
      } else if (entry.kind === "pi.assistant") {
        answer = entry;
        results.clear();
      }
    }
    for (const call of this.toolCallsOf(answer)) {
      if (!results.has(call.id)) this.calls.set(call.id, { name: call.name, input: call.arguments, emitted: false });
    }
    const live = liveOf(view);
    const message = live.generation?.message as AssistantMessage | undefined;
    if (message && live.run) {
      this.streamKey = `${live.run.taskId}:${live.generation?.attempt ?? 0}`;
      this.streamed = messageText(message);
    }
    this.retryAt = live.generation?.retry?.at;
    this.compactions = new Set((live.compactions ?? []).map((c) => String(c.taskId)));
    this.compactionFailure = live.compactionFailure ? String(live.compactionFailure.taskId) : undefined;
    this.runFailure = live.runFailure ? `${live.runFailure.taskId}:${live.runFailure.reason}` : undefined;
    this.progress(live, "attach");
  }

  /** Render the next view. Resolves once it is handled; never rejects. */
  apply(view: ConversationView): Promise<void> {
    this.chain = this.chain.then(() => this.render(view)).catch((err) => this.host.log("warn", "pi: live bridge failed", { error: String(err) }));
    return this.chain;
  }

  /**
   * Read the entries no delivered view showed (a listener that lagged behind
   * the turn's settle, or folds dropped by stop()), then end tool calls that
   * never got a result. Call after the watch stopped and its listener ended.
   */
  finish(): Promise<void> {
    this.chain = this.chain
      .then(async () => {
        for (const entry of await this.host.loadEntries(this.lastSeen + 1)) this.entry(entry);
      })
      .catch((err) => this.host.log("warn", "pi: live bridge catch-up failed", { error: String(err) }))
      .then(() => this.endCalls());
    return this.chain;
  }

  private async render(view: ConversationView): Promise<void> {
    // The window was trimmed past entries this bridge never saw (many
    // entries folded into one call): read them first, in order.
    if (view.before !== undefined && Number(view.before) > this.lastSeen) {
      for (const entry of await this.host.loadEntries(this.lastSeen + 1, Number(view.before))) this.entry(entry);
    }
    for (const entry of view.entries) this.entry(entry);
    const live = liveOf(view);
    this.stream(live);
    this.logs(live);
    this.progress(live);
  }

  private entry(entry: EntryRecord): void {
    const id = idOf(entry);
    if (id <= this.lastSeen) return;
    this.lastSeen = id;
    if (entry.kind === "pi.assistant") {
      // A new answer: the previous round is over.
      this.endCalls();
      const m = entry.model?.[0] as AssistantMessage | undefined;
      this.totals.steps++;
      // Total prompt tokens incl. cache reads/writes — what the AI SDK's
      // inputTokens reported on Think, and what users compare against bills.
      this.totals.input += (m?.usage?.input ?? 0) + (m?.usage?.cacheRead ?? 0) + (m?.usage?.cacheWrite ?? 0);
      this.totals.output += m?.usage?.output ?? 0;
      if (m?.usage) this.totals.context = (m.usage.input ?? 0) + (m.usage.cacheRead ?? 0) + (m.usage.cacheWrite ?? 0);
      if (m?.stopReason !== "aborted" && m?.stopReason !== "error") {
        this.emitText(messageText(m));
        for (const call of this.toolCallsOf(entry)) {
          const pending: PendingCall = { name: call.name, input: call.arguments, emitted: false };
          this.calls.set(call.id, pending);
          this.emitCall(call.id, pending);
        }
        // Its partial must not stream again. Not for a failed answer: a
        // context-overflow retry runs again under the same task and attempt.
        this.finishedKey = this.streamKey;
      }
      this.streamed = "";
      return;
    }
    if (entry.kind === "pi.tool-result") {
      const result = entry.model?.[0] as { toolCallId?: string; toolName?: string; content?: Array<TextContent | ImageContent> } | undefined;
      const callId = result?.toolCallId;
      if (!callId) return;
      // Results in the transcript are for the model's own calls (a nested
      // call's result stays in its caller). One whose answer this bridge
      // never saw (a recovered round older than the window) still gets its
      // tool_call first.
      const pending = this.calls.get(callId) ?? { name: result?.toolName ?? "tool", input: {}, emitted: false };
      this.emitCall(callId, pending);
      this.calls.delete(callId);
      this.host.emit({ type: "tool_result", data: { toolCallId: callId, output: messageText(result) } });
    }
  }

  private toolCallsOf(entry: EntryRecord | undefined): ToolCall[] {
    const m = entry?.model?.[0] as AssistantMessage | undefined;
    if (!Array.isArray(m?.content)) return [];
    return m.content.filter((c): c is ToolCall => c.type === "toolCall");
  }

  private emitCall(callId: string, pending: PendingCall): void {
    if (pending.emitted) return;
    pending.emitted = true;
    this.totals.toolCalls.push(pending.name);
    this.host.emit({ type: "tool_call", data: { toolCallId: callId, toolName: pending.name, input: pending.input ?? {} } });
  }

  /** Calls whose result never came (a faulted or orphaned tool task): close them in the chat. */
  private endCalls(): void {
    for (const [callId, pending] of this.calls) {
      if (pending.emitted) this.host.emit({ type: "tool_result", data: { toolCallId: callId, output: "" } });
    }
    this.calls.clear();
  }

  private emitText(text: string): void {
    // Partials are committed on an interval and folds skip some: text can
    // arrive in steps or only with the final message. Emit each attempt's
    // text once, as the not-yet-streamed suffix.
    if (text.length > this.streamed.length && text.startsWith(this.streamed)) {
      this.host.emit({ type: "text_delta", data: { delta: text.slice(this.streamed.length) } });
      this.streamed = text;
    }
  }

  private stream(live: LiveState): void {
    const message = live.generation?.message as AssistantMessage | undefined;
    if (!message || !live.run) return;
    const key = `${live.run.taskId}:${live.generation?.attempt ?? 0}`;
    if (key === this.finishedKey) return;
    if (key !== this.streamKey) {
      this.streamKey = key;
      this.streamed = "";
    }
    this.emitText(messageText(message));
  }

  private logs(live: LiveState): void {
    const retry = live.generation?.retry;
    if (retry && retry.at !== this.retryAt) {
      this.host.log("warn", "pi: provider retry", { attempt: live.generation?.attempt, error: retry.error });
    }
    this.retryAt = retry?.at;
    const now = new Map((live.compactions ?? []).map((c) => [String(c.taskId), c]));
    for (const [id, c] of now) {
      if (!this.compactions.has(id)) this.host.log("info", "pi: compaction start", { trigger: c.trigger, blocking: c.blocking });
    }
    for (const id of this.compactions) if (!now.has(id)) this.host.log("info", "pi: compaction end", { taskId: id });
    this.compactions = new Set(now.keys());
    const failure = live.compactionFailure;
    if (failure && String(failure.taskId) !== this.compactionFailure) {
      this.host.log("warn", "pi: compaction failed", { trigger: failure.trigger, error: failure.error });
    }
    this.compactionFailure = failure ? String(failure.taskId) : undefined;
    const run = live.runFailure;
    const runKey = run ? `${run.taskId}:${run.reason}` : undefined;
    if (run && runKey !== this.runFailure) this.host.log("warn", "pi: run ended without an answer", { reason: run.reason, detail: run.detail });
    this.runFailure = runKey;
  }

  private progress(live: LiveState, fallback?: string): void {
    if (!this.host.onProgress) return;
    const openTools = (live.tools ?? []).filter((t) => t.status !== "done").map((t) => ({ callId: t.callId, name: t.name }));
    const compacting = (live.compactions?.length ?? 0) > 0;
    const label = openTools.length
      ? `tool:${openTools.map((t) => t.name).join(",")}`
      : compacting
        ? "compaction"
        : live.generation?.retry
          ? "retry"
          : live.generation
            ? "generation"
            : (fallback ?? (live.run ? "run" : "idle"));
    try {
      this.host.onProgress({ label, openTools, compacting });
    } catch {
      // bookkeeping must not break the turn
    }
  }
}
