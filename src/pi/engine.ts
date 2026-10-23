// PiEngine: Dodo's agent loop on @earendil-works/pi-durable.
//
// One Harness per CodingAgent DO, stored in the DO's own SQLite under the
// `pi_` table prefix. pi-durable owns what Dodo previously hand-rolled on
// top of Think:
//
//   - the multi-step tool loop (was the own-loop in coding-agent.ts)
//   - per-step durability: every model response and tool result is
//     committed before it is shown, so an eviction resumes mid-turn instead
//     of replaying the whole turn from the fiber's top
//   - compaction (background + blocking + overflow retry) — was
//     compaction-policy.ts, overflow-retry.ts, own-loop-prune.ts
//   - provider retries with backoff
//   - abort that cascades through running tool calls
//   - idempotent submission by request id (prompt id)
//
// Dodo keeps: its tools, system prompt, prompt lifecycle/queue, goal and
// watchdog policies, attachments, SSE event protocol.

import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { AssistantMessage, ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  type AgentEvent,
  AssistantEntry,
  createRegistry,
  defineExtension,
  type EntryRecord,
  type Extension,
  Harness,
  type HarnessSettings,
  type ReportInfo,
  section,
  type Submission,
  watchEvents,
} from "@earendil-works/pi-durable";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { buildLoopGuardExtension, type LoopVerdict } from "./loop-guard";
import { DODO_PROVIDER_ID } from "./models";

export const PI_TABLE_PREFIX = "pi_";
export const DODO_USER_ENTRY = "dodo.user";
/** An assistant message written without a model run: imported history, generated images. */
export const DODO_ASSISTANT_ENTRY = "dodo.assistant";
/**
 * A summary of earlier conversation (a Think-era compaction summary carried
 * over by migration/import). Written with `head: "self"`, so the model's
 * context starts at it, like pi's own reset-with-handoff. Shown as a system row.
 */
export const DODO_SUMMARY_ENTRY = "dodo.summary";

export type PiUserContent = string | Array<TextContent | ImageContent>;

export interface DodoAssistantEntryData {
  messageId: string;
  text: string;
  createdAt: number;
  [key: string]: string | number | null;
}

/** One message to write into the transcript as-is (no model call). */
export interface PiImportedMessage {
  /** "system" = summary of earlier conversation; the model's context restarts at it. */
  role: "user" | "assistant" | "system";
  id: string;
  /** What the chat shows. */
  text: string;
  /** What the model sees, when it differs (e.g. inlined documents). Defaults to `text`. */
  contextText?: string;
  authorEmail?: string | null;
  /** Epoch seconds. */
  createdAt?: number;
  /** Model that produced an assistant message, for the context record. */
  model?: string;
}

export interface DodoUserEntryData {
  messageId: string;
  text: string;
  authorEmail: string | null;
  createdAt: number;
  [key: string]: string | number | null;
}

export interface PiEngineHost {
  /** The DO's storage (`ctx.storage`). */
  storage: DurableObjectStorage;
  /**
   * Current model access (catalog, credentials, request transforms). pi calls
   * this at each use (every generation, compaction, hook and tool), so a
   * model/gateway change applies at the next request without reopening the
   * Harness. Cheap to call: the host should cache by config.
   */
  models(): Models;
  /** Current model ref for the conversation. */
  modelRef(): { provider: string; modelId: string };
  /** Current system prompt. Rendered before each model request. */
  systemPrompt(): string;
  /** Emit a Dodo SSE/WS event. */
  emit(event: { type: string; data: unknown }): void;
  /** The loop guard nudged or refused a tool. */
  onLoopVerdict?(verdict: LoopVerdict): void;
  log(level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>): void;
}

export interface PiTurnInput {
  promptId: string;
  /** Builds the turn's user content. Only called the first time a prompt runs — not on recovery. */
  prepare: () => Promise<{ content: PiUserContent; entry: DodoUserEntryData }>;
  /** Current tool set as a pi extension; installed before the run starts. */
  tools: Extension;
  signal?: AbortSignal;
  /** A setup step started (open, configure, prepare, submit). For the turn stall guard. */
  onPhase?: (phase: string) => void;
  /** Every pi agent event of the turn, before Dodo translates it. For the turn stall guard. */
  onEvent?: (event: AgentEvent) => void;
}

export interface PiTurnResult {
  assistantMessageId: string;
  text: string;
  tokenInput: number;
  tokenOutput: number;
  /** Context size of the last model request (input + cache read/write): the "how full is it" number. */
  contextTokens: number;
  steps: number;
  toolCalls: string[];
  recovered: boolean;
  status: "done" | "unanswered";
  reason?: string;
}

/** pi-durable's default `settings.restartLimit`. Dodo keeps it. */
export const PI_RESTART_LIMIT = 5;

const SETTINGS: HarnessSettings = {
  retry: { maxRetries: 3 },
  compaction: { enabled: true },
  // DO SQLite is local; 250 ms keeps write volume modest while streaming.
  progress: { partialIntervalMs: 250, outputIntervalMs: 250 },
  toolExecution: "parallel",
  // A task the DO is reset under this many times without progress is parked;
  // run() fails the turn (PiTaskParkedError) instead of waiting on it.
  restartLimit: PI_RESTART_LIMIT,
};

/** A task pi's crash-loop guard parked (cut off `restartLimit` times without progress). */
export interface PiParkedTask {
  id: string;
  kind: string;
}

/**
 * The turn's work was parked by pi's crash-loop guard: the Durable Object was
 * reset that many times mid-task without the task making progress. The turn
 * is aborted rather than retried, since the same step would most likely
 * crash again.
 */
export class PiTaskParkedError extends Error {
  readonly tasks: PiParkedTask[];
  constructor(tasks: PiParkedTask[], restartLimit: number) {
    super(
      `This turn was stopped: the session restarted ${restartLimit} times while running it without making progress ` +
        `(${tasks.map((t) => t.kind).join(", ")}). A step is probably crashing or overloading the worker. ` +
        "Send the prompt again to retry, or break the work into smaller steps.",
    );
    this.name = "PiTaskParkedError";
    this.tasks = tasks;
  }
}

/** After aborting a parked turn, how long to wait for its submission to settle before giving up on it. */
const PARKED_ABORT_SETTLE_MS = 30_000;

function textOf(message: AssistantMessage | UserMessage | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  return content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
}

interface BridgeState {
  steps: number;
  input: number;
  output: number;
  /** Context size of the last assistant step. */
  context: number;
  toolCalls: string[];
  /** Text of the current assistant message already sent as text_delta. */
  streamed: string;
}

export class PiEngine {
  private harness: Harness | undefined;
  private opening: Promise<Harness> | undefined;
  private database: DurableObjectSqliteDatabase | undefined;
  private readonly registry = createRegistry();
  private readonly ctx: Context = BACKGROUND_CONTEXT;

  constructor(private readonly host: PiEngineHost) {
    this.registry.install(
      defineExtension({
        name: "dodo-prompt",
        sections: [section("dodo", () => this.host.systemPrompt(), { tag: false })],
      }),
    );
    this.registry.install(buildLoopGuardExtension((v) => this.host.onLoopVerdict?.(v)));
  }

  private async db(): Promise<DurableObjectSqliteDatabase> {
    if (!this.database) {
      this.database = new DurableObjectSqliteDatabase(this.host.storage);
      await this.database.exec(
        `CREATE TABLE IF NOT EXISTS ${PI_TABLE_PREFIX}dodo_prompts (prompt_id TEXT PRIMARY KEY, submission_id TEXT NOT NULL)`,
      );
    }
    return this.database;
  }

  /** Open (once) and return the Harness. */
  async open(): Promise<Harness> {
    if (this.harness) return this.harness;
    if (!this.opening) {
      this.opening = (async () => {
        const database = await this.db();
        const storage = await SqliteStorage.open(database, { prefix: PI_TABLE_PREFIX });
        const harness = await Harness.open(
          storage,
          {
            models: () => this.host.models(),
            registry: this.registry,
            settings: SETTINGS,
            onReport: (error, info) => this.report(error, info),
          },
          this.ctx,
        );
        harness.closed.then((end) => {
          if (this.harness === harness) {
            this.harness = undefined;
            this.opening = undefined;
          }
          if (end.reason === "failed") {
            this.host.log("error", "pi-durable harness failed", { error: String(end.error) });
          }
        });
        this.harness = harness;
        return harness;
      })().catch((err) => {
        this.opening = undefined;
        throw err;
      });
    }
    return this.opening;
  }

  private report(error: unknown, info: ReportInfo): void {
    const fields: Record<string, unknown> = { type: info.type, error: error instanceof Error ? error.message : String(error) };
    if ("task" in info && info.task) {
      fields.taskId = String(info.task.id);
      fields.taskKind = info.task.kind;
    }
    if ("extension" in info && info.extension) fields.extension = info.extension;
    if ("reason" in info) fields.reason = info.reason;
    if (info.type === "host_error") fields.callback = info.callback;
    if (info.type === "task_parked") {
      // run() finds the parked task through inspect() (parkedTasks) and fails
      // or clears it. Parks are only counted at open, before any turn waits.
      this.host.log("error", "pi: task parked by the crash-loop guard", fields);
      return;
    }
    const level = info.type === "session_failed" || info.type === "task_faulted" ? "error" : "warn";
    this.host.log(level, "pi-durable report", fields);
  }

  /**
   * Tasks pi's crash-loop guard has parked. pi reports a park once, when the
   * open that counts the last restart happens, so a later open (another
   * isolate) only finds it here.
   */
  async parkedTasks(): Promise<PiParkedTask[]> {
    const harness = await this.open();
    const live = await harness.inspect(this.ctx);
    return live.tasks
      .filter((t) => t.state.kind === "blocked" && t.state.reason === "restart_limit")
      .map((t) => ({ id: String(t.record.id), kind: t.record.kind }));
  }

  private async root() {
    const harness = await this.open();
    return harness.root(this.ctx, { agent: { model: this.host.modelRef() } });
  }

  /** Continue any run a previous isolate left unfinished. */
  async resume(): Promise<void> {
    (await this.open()).resume();
  }

  /** Run (or reattach to) the turn for one Dodo prompt. */
  async run(input: PiTurnInput): Promise<PiTurnResult> {
    // The turn can be aborted (user abort, turn stall guard) while a setup
    // step below is still waiting. Stop before writing anything new.
    const bail = () => {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error("aborted");
    };
    bail();
    input.onPhase?.("pi_open");
    const harness = await this.open();
    this.registry.install(input.tools);
    input.onPhase?.("pi_root");
    const root = await this.root();
    const model = this.host.modelRef();
    const agent = await root.agent(this.ctx);
    if (agent.model?.provider !== model.provider || agent.model?.modelId !== model.modelId) {
      input.onPhase?.("pi_configure");
      await root.configure({ model }, this.ctx);
    }

    const db = await this.db();
    const existing = await db.get<{ submission_id: string }>(
      `SELECT submission_id FROM ${PI_TABLE_PREFIX}dodo_prompts WHERE prompt_id = ?`,
      input.promptId,
    );
    let submission: Submission | undefined;
    let recovered = false;
    if (existing) {
      submission = await harness.submission(existing.submission_id as never, this.ctx);
      recovered = submission !== undefined;
    }
    // pi parks a task the DO was reset under `restartLimit` times without
    // progress. A parked task never runs again by itself, so without this the
    // turn would sit until the turn stall guard (15 min).
    const parkedAtStart = await this.parkedTasks();
    if (parkedAtStart.length > 0) {
      if (submission) {
        // Reattaching to this prompt's own run: it is what crash-looped.
        await this.abortParked(root, submission, parkedAtStart);
      }
      // A new prompt: the park is left over from an earlier turn (whose
      // prompt already failed or gave up). Abort it so this prompt can run;
      // the new input queues behind the aborting run. An abort-marked task is
      // no longer blocked, so the re-check is empty unless the abort failed.
      this.host.log("warn", "pi: aborting work parked by an earlier turn", { tasks: parkedAtStart });
      await root.abort(this.ctx).catch((err) => this.host.log("warn", "pi: abort of parked work failed", { error: String(err) }));
      const still = await this.parkedTasks();
      if (still.length > 0) throw new PiTaskParkedError(still, PI_RESTART_LIMIT);
    }
    if (!submission) {
      bail();
      input.onPhase?.("prepare");
      const { content, entry } = await input.prepare();
      bail();
      input.onPhase?.("submit");
      submission = await root.submit(
        { type: "input", content, requestId: input.promptId, entry: { kind: DODO_USER_ENTRY, data: entry } },
        this.ctx,
      );
      await db.run(
        `INSERT OR REPLACE INTO ${PI_TABLE_PREFIX}dodo_prompts (prompt_id, submission_id) VALUES (?, ?)`,
        input.promptId,
        submission.id,
      );
    }
    harness.resume();
    input.onPhase?.("running");

    const acc: BridgeState = { steps: 0, input: 0, output: 0, context: 0, toolCalls: [], streamed: "" };
    const stream = await watchEvents(harness, root.id, this.ctx);
    // A recovered turn can attach with tool calls already running.
    input.onEvent?.(stream.snapshot);
    stream.start(async (events) => {
      for (const event of events) {
        input.onEvent?.(event);
        this.bridge(event, acc);
      }
    });

    const onAbort = () => {
      void root.abort(this.ctx).catch(() => {});
    };

    input.signal?.addEventListener("abort", onAbort, { once: true });
    // Aborted between submit and here: the listener won't fire for a past abort.
    if (input.signal?.aborted) onAbort();
    let settled: Awaited<ReturnType<Submission["wait"]>>;
    try {
      const waitCtx = input.signal ? withAbortSignal(input.signal, this.ctx) : this.ctx;
      settled = await submission.wait(waitCtx).catch(async (err) => {
        if (input.signal?.aborted) return submission.wait(this.ctx);
        throw err;
      });
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
      await stream.stop().catch(() => {});
    }

    if (settled.status !== "done" || settled.type !== "input") {
      const reason = settled.status === "unanswered" ? settled.reason : settled.status;
      const detail = settled.status === "unanswered" && settled.detail !== undefined ? JSON.stringify(settled.detail) : "";
      return {
        assistantMessageId: "",
        text: "",
        tokenInput: acc.input,
        tokenOutput: acc.output,
        contextTokens: acc.context,
        steps: acc.steps,
        toolCalls: acc.toolCalls,
        recovered,
        status: "unanswered",
        reason: detail ? `${reason}: ${detail}` : reason,
      };
    }
    const answerId = settled.answer;
    const answer = await root.commit((tx) => tx.entry(AssistantEntry, answerId), this.ctx);
    const message = answer?.model?.[0] as AssistantMessage | undefined;
    return {
      assistantMessageId: String(answerId),
      text: textOf(message),
      tokenInput: acc.input,
      tokenOutput: acc.output,
      contextTokens: acc.context,
      steps: acc.steps,
      toolCalls: acc.toolCalls,
      recovered,
      status: "done",
    };
  }

  /**
   * Abort a turn pi parked, wait (bounded) for its submission to settle so
   * the conversation is free for the next prompt, and fail the turn.
   */
  private async abortParked(root: Awaited<ReturnType<PiEngine["root"]>>, submission: Submission, tasks: PiParkedTask[]): Promise<never> {
    this.host.log("error", "pi: failing the turn, its work was parked by the crash-loop guard", { tasks });
    await root.abort(this.ctx).catch((err) => this.host.log("warn", "pi: abort of parked turn failed", { error: String(err) }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      submission.wait(this.ctx).catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, PARKED_ABORT_SETTLE_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    throw new PiTaskParkedError(tasks, PI_RESTART_LIMIT);
  }

  /** Translate pi agent events into Dodo's SSE protocol. */
  private bridge(event: AgentEvent, acc: BridgeState): void {
    const emitText = (text: string) => {
      // Partials are committed on an interval: text can arrive as deltas,
      // whole in a block, or only with the final message. Emit each
      // message's text exactly once, as the not-yet-streamed suffix.
      if (text.length > acc.streamed.length && text.startsWith(acc.streamed)) {
        this.host.emit({ type: "text_delta", data: { delta: text.slice(acc.streamed.length) } });
        acc.streamed = text;
      }
    };
    switch (event.type) {
      case "message_start":
        acc.streamed = "";
        if (event.message.role === "assistant") emitText(textOf(event.message));
        return;
      case "message_update":
        for (const change of event.changes) {
          if (change.type === "text_delta") emitText(acc.streamed + change.delta);
          else if (change.type === "message") emitText(textOf(change.message));
        }
        return;
      case "message_end": {
        if (event.entry.kind !== "pi.assistant") return;
        acc.steps++;
        const m = event.entry.model?.[0] as AssistantMessage | undefined;
        if (m?.stopReason !== "aborted" && m?.stopReason !== "error") emitText(textOf(m));
        acc.streamed = "";
        // Total prompt tokens incl. cache reads/writes — what the AI SDK's
        // inputTokens reported on Think, and what users compare against bills.
        acc.input += (m?.usage?.input ?? 0) + (m?.usage?.cacheRead ?? 0) + (m?.usage?.cacheWrite ?? 0);
        acc.output += m?.usage?.output ?? 0;
        if (m?.usage) acc.context = (m.usage.input ?? 0) + (m.usage.cacheRead ?? 0) + (m.usage.cacheWrite ?? 0);
        return;
      }
      case "tool_execution_start":
        if (event.parentToolCallId) return;
        acc.toolCalls.push(event.toolName);
        this.host.emit({
          type: "tool_call",
          data: { toolCallId: event.toolCallId, toolName: event.toolName, input: event.args },
        });
        return;
      case "tool_execution_end": {
        if (event.parentToolCallId) return;
        const result = event.entry?.model?.[0] as { content?: Array<TextContent | ImageContent> } | undefined;
        const output = (result?.content ?? [])
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("");
        this.host.emit({ type: "tool_result", data: { toolCallId: event.toolCallId, output } });
        return;
      }
      case "auto_retry_start":
        this.host.log("warn", "pi: provider retry", { attempt: event.attempt, error: event.errorMessage });
        return;
      case "compaction_start":
        this.host.log("info", "pi: compaction start", { reason: event.reason, blocking: event.blocking });
        return;
      case "compaction_end":
        this.host.log(event.error ? "warn" : "info", "pi: compaction end", { reason: event.reason, error: event.error });
        return;
      case "task_failed":
        this.host.log("error", "pi: task failed", { kind: event.kind, message: event.message });
        return;
      default:
        return;
    }
  }

  /**
   * Write messages into the transcript without running the model: imported
   * history (fork, snapshot) and generated images. They show in the chat and
   * count as context for later turns.
   */
  async append(messages: readonly PiImportedMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const harness = await this.open();
    const root = await this.root();
    const write = async (entry: Parameters<typeof root.submit>[0]) => {
      const sub = await root.submit(entry, this.ctx);
      harness.resume();
      await sub.wait(this.ctx);
    };
    const model = this.host.modelRef();
    for (const m of messages) {
      // Dodo stores epoch seconds; pi messages carry ms timestamps.
      const createdAt = m.createdAt ?? Math.floor(Date.now() / 1000);
      const timestamp = createdAt * 1000;
      if (m.role === "system") {
        const data: DodoAssistantEntryData = { messageId: m.id, text: m.text, createdAt };
        const content = `Summary of the conversation so far:\n\n${m.contextText ?? m.text}`;
        await write({ type: "write", entry: { kind: DODO_SUMMARY_ENTRY, data, head: "self", model: [{ role: "user", content, timestamp }] } });
      } else if (m.role === "user") {
        const data: DodoUserEntryData = { messageId: m.id, text: m.text, authorEmail: m.authorEmail ?? null, createdAt };
        await write({ type: "write", entry: { kind: DODO_USER_ENTRY, data, model: [{ role: "user", content: m.contextText ?? m.text, timestamp }] } });
      } else {
        const data: DodoAssistantEntryData = { messageId: m.id, text: m.text, createdAt };
        const message: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: m.contextText ?? m.text }],
          api: "openai-completions",
          provider: DODO_PROVIDER_ID,
          model: m.model ?? model.modelId,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp,
        };
        await write({ type: "write", entry: { kind: DODO_ASSISTANT_ENTRY, data, model: [message] } });
      }
    }
  }

  /**
   * Compact now (summarize the old part of the context, keep the recent part)
   * and wait for it. For the admin debug route; pi compacts on its own at
   * thresholds and on overflow.
   */
  async compact(instructions?: string): Promise<unknown> {
    const harness = await this.open();
    const root = await this.root();
    const task = await root.compact(instructions, this.ctx);
    harness.resume();
    return harness.waitForTask(task, this.ctx);
  }

  /** Abort the running turn, if any. */
  async abort(): Promise<void> {
    if (!this.harness) return;
    const root = await this.root();
    await root.abort(this.ctx);
  }

  /** All transcript entries, oldest first (fork-aware, across resets/compactions). */
  async entries(): Promise<EntryRecord[]> {
    const root = await this.root();
    const out: EntryRecord[] = [];
    let cursor: unknown;
    for (;;) {
      const page = await root.entries({ order: "ascending" }, 500, cursor as never, this.ctx);
      out.push(...page.items);
      if (!page.next) break;
      cursor = page.next;
    }
    return out;
  }

  /**
   * Operator view: live tasks/submissions and a compact transcript (entry
   * kinds, tool names, error flags, short text). For debugging recovery.
   */
  async inspect(): Promise<{ live: unknown; transcript: Array<Record<string, unknown>> }> {
    const harness = await this.open();
    const live = await harness.inspect(this.ctx);
    const transcript = (await this.entries()).map((e) => {
      const m = e.model?.[0] as { role?: string; content?: unknown; toolName?: string; isError?: boolean; stopReason?: string } | undefined;
      const blocks = Array.isArray(m?.content) ? (m.content as Array<{ type: string; text?: string; name?: string }>) : [];
      return {
        id: e.id,
        kind: e.kind,
        ...(m?.toolName ? { tool: m.toolName, isError: m.isError ?? false } : {}),
        ...(m?.stopReason ? { stopReason: m.stopReason } : {}),
        ...(blocks.some((b) => b.type === "toolCall") ? { calls: blocks.filter((b) => b.type === "toolCall").map((b) => b.name) } : {}),
        text: (typeof m?.content === "string" ? m.content : blocks.filter((b) => b.type === "text").map((b) => b.text).join("")).slice(0, 160),
      };
    });
    return {
      live: {
        scheduling: live.scheduling,
        tasks: live.tasks.map((t) => ({ id: t.record.id, kind: t.record.kind, state: t.state.kind })),
        submissions: live.submissions.map((s) => ({ id: s.id, status: s.status })),
      },
      transcript,
    };
  }

  async close(): Promise<void> {
    const harness = this.harness;
    this.harness = undefined;
    this.opening = undefined;
    if (harness) await harness.close(this.ctx);
  }

  /**
   * Delete everything pi stored for this session (transcript, tasks, prompt
   * map): drops every `pi_` table. The engine is unusable afterwards; make a
   * new one, which recreates the schema on open.
   */
  async destroy(): Promise<number> {
    await this.close().catch(() => {});
    this.database = undefined;
    const sql = this.host.storage.sql;
    const tables = Array.from(
      sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\'", `${PI_TABLE_PREFIX.replace(/_/g, "\\_")}%`),
    ).map((r) => String(r.name));
    for (const t of tables) sql.exec(`DROP TABLE IF EXISTS "${t.replace(/"/g, '""')}"`);
    return tables.length;
  }
}

export interface PiMessageView {
  role: "user" | "assistant" | "system";
  /** Dodo message id: the user's prepared id, or the answer entry id. */
  id: string;
  content: string;
  authorEmail: string | null;
  createdAt: number | null;
  /** Images the user sent inline with this message (data URLs). */
  images?: Array<{ mediaType: string; url: string }>;
}

/**
 * Collapse pi entries into Dodo's chat view: one record per user input,
 * and one assistant record per run (all steps between two inputs, keyed by
 * the run's last assistant entry — the id `run()` returns).
 */
export function entriesToMessages(entries: readonly EntryRecord[]): PiMessageView[] {
  const out: PiMessageView[] = [];
  let pending: { id: string; text: string[] } | undefined;
  const flush = () => {
    if (pending && pending.text.join("").length > 0) {
      out.push({ role: "assistant", id: pending.id, content: pending.text.join("\n\n"), authorEmail: null, createdAt: null });
    }
    pending = undefined;
  };
  for (const entry of entries) {
    if (entry.kind === DODO_USER_ENTRY || entry.kind === "pi.user") {
      flush();
      const data = (entry.data ?? {}) as Partial<DodoUserEntryData>;
      const user = entry.model?.[0] as UserMessage | undefined;
      const text = data.text ?? textOf(user);
      const images = Array.isArray(user?.content)
        ? user.content
            .filter((c): c is ImageContent => c.type === "image")
            .map((c) => ({ mediaType: c.mimeType, url: `data:${c.mimeType};base64,${c.data}` }))
        : [];
      out.push({
        role: "user",
        id: data.messageId ?? String(entry.id),
        content: text,
        authorEmail: data.authorEmail ?? null,
        createdAt: data.createdAt ?? null,
        ...(images.length ? { images } : {}),
      });
    } else if (entry.kind === DODO_SUMMARY_ENTRY) {
      flush();
      const data = (entry.data ?? {}) as Partial<DodoAssistantEntryData>;
      out.push({ role: "system", id: data.messageId ?? String(entry.id), content: data.text ?? "", authorEmail: null, createdAt: data.createdAt ?? null });
    } else if (entry.kind === DODO_ASSISTANT_ENTRY) {
      flush();
      const data = (entry.data ?? {}) as Partial<DodoAssistantEntryData>;
      out.push({
        role: "assistant",
        id: data.messageId ?? String(entry.id),
        content: data.text ?? textOf(entry.model?.[0] as AssistantMessage | undefined),
        authorEmail: null,
        createdAt: data.createdAt ?? null,
      });
    } else if (entry.kind === "pi.assistant") {
      const message = entry.model?.[0] as AssistantMessage | undefined;
      if (message?.stopReason === "aborted" || message?.stopReason === "error") continue;
      const text = textOf(message);
      const current = pending ?? { id: String(entry.id), text: [] };
      current.id = String(entry.id);
      if (text) current.text.push(text);
      pending = current;
    }
  }
  flush();
  return out;
}
