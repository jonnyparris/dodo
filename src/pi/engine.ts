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
  AssistantEntry,
  createRegistry,
  defineExtension,
  type EntryRecord,
  type Extension,
  Harness,
  type HarnessSettings,
  type Report,
  section,
  type Submission,
  type SubmissionDraft,
} from "@earendil-works/pi-durable";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { LiveBridge, messageText, type PiTurnProgress } from "./live-bridge";
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
  /** Each change of the conversation's live state while the turn runs (a full snapshot). For the turn stall guard. */
  onProgress?: (progress: PiTurnProgress) => void;
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
  // How often the streamed answer and running tool output are committed.
  // Since pi 1.5 these commits are deferred: watches (the chat stream) see
  // each one at once, and storage gets them in batches, with the run's next
  // step or within persistWithinMs. So the interval sets the chat's update
  // rate, not the write volume. A crash loses up to persistWithinMs of
  // streamed text (pi's default, set here so it is visible).
  progress: { partialIntervalMs: 250, outputIntervalMs: 250, persistWithinMs: 1000 },
  toolExecution: "parallel",
  // A task the DO is reset under this many times in a row ends: a tool call
  // with an error result the model sees, a model request by ending the run
  // without an answer (`restart_limit`; piUnansweredMessage).
  restartLimit: PI_RESTART_LIMIT,
};

/**
 * Entries the turn's conversation watch holds: starts with the newest 24,
 * trims back to 24 past 64. A recovered tool round with up to 23 results
 * still has its answer in the first view, so its calls keep their arguments
 * in the chat (a bigger round's calls show with `{}`). Smaller than pi's
 * default (50/100), since entries can hold large tool output.
 */
const WATCH_WINDOW = { min: 24, max: 64 } as const;

/**
 * The user-facing error for a turn pi settled without an answer (not
 * aborted). `reason` is PiTurnResult.reason: the run failure reason, then
 * `: <detail JSON>` when there is one.
 */
export function piUnansweredMessage(reason: string): string {
  // pi already retried the provider; surface what the provider said.
  const modelError = /^model_error: "([\s\S]*)"$/.exec(reason)?.[1];
  if (modelError !== undefined) return modelError;
  if (/^restart_limit\b/.test(reason)) {
    return (
      "This turn was stopped: the session restarted while running it and gave up after too many restarts. " +
      "A step is probably crashing or overloading the worker. Send the prompt again to retry, or break the work into smaller steps."
    );
  }
  if (/^interrupted\b/.test(reason)) {
    return "This turn was stopped: the session restarted during the model's answer, and the retries ran out. Send the prompt again to retry.";
  }
  return `Turn ended without an answer (${reason})`;
}

function textOf(message: AssistantMessage | UserMessage | undefined): string {
  return messageText(message);
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
            onReport: (report) => this.report(report),
          },
          this.ctx,
        );
        harness.closed.then((end) => {
          if (this.harness === harness) {
            this.harness = undefined;
            this.opening = undefined;
          }
          if (end.kind === "failed") {
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

  private report(report: Report): void {
    const error = report.error;
    const fields: Record<string, unknown> = { kind: report.kind, error: error instanceof Error ? error.message : String(error) };
    if ("task" in report && report.task) {
      fields.taskId = String(report.task.id);
      fields.taskKind = report.task.kind;
    }
    if ("extension" in report && report.extension) fields.extension = report.extension;
    if ("reason" in report) fields.reason = report.reason;
    if ("restarts" in report) fields.restarts = report.restarts;
    if (report.kind === "host_error") fields.callback = report.callback;
    const level = report.kind === "storage_failed" || report.kind === "task_faulted" || report.kind === "task_interrupted" ? "error" : "warn";
    this.host.log(level, "pi-durable report", fields);
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

    // Attach before submitting (and before resuming a recovered run), so
    // every entry of this turn arrives after the baseline.
    const bridge = new LiveBridge({
      emit: (event) => this.host.emit(event),
      log: (level, message, fields) => this.host.log(level, message, fields),
      onProgress: input.onProgress,
      loadEntries: (min, max) => this.entriesBetween(root, min, max),
    });
    // attach() reads the newest answer's tool calls from the first view;
    // render() pages entries a later trim skipped.
    const watch = await root.watch(this.ctx, WATCH_WINDOW);
    let listening: Promise<void> = Promise.resolve();
    bridge.attach(watch.value);
    watch.start(async (call) => {
      if (call.kind !== "value") return;
      listening = bridge.apply(call.value);
      await listening;
    });

    const onAbort = () => {
      void root.abort(this.ctx).catch(() => {});
    };
    let settled: Awaited<ReturnType<Submission["wait"]>>;
    try {
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
      const turn = submission;
      harness.resume();
      input.onPhase?.("running");

      input.signal?.addEventListener("abort", onAbort, { once: true });
      // Aborted between submit and here: the listener won't fire for a past abort.
      if (input.signal?.aborted) onAbort();
      const waitCtx = input.signal ? withAbortSignal(input.signal, this.ctx) : this.ctx;
      settled = await turn.wait(waitCtx).catch(async (err) => {
        if (input.signal?.aborted) return turn.wait(this.ctx);
        throw err;
      });
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
      await watch.stop().catch(() => {});
      // stop() leaves a listener call that is already running.
      await listening;
    }
    // The listener can lag behind the settle, and stop() drops folded views:
    // read what it didn't show.
    await bridge.finish();
    const acc = bridge.totals;

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

  /** Transcript entries with `min <= id <= max`, oldest first. */
  private async entriesBetween(root: Awaited<ReturnType<PiEngine["root"]>>, min: number, max?: number): Promise<EntryRecord[]> {
    const out: EntryRecord[] = [];
    let cursor: unknown;
    for (;;) {
      const page = await root.entries(
        { order: "ascending", minEntryId: min as never, ...(max !== undefined ? { maxEntryId: max as never } : {}) },
        500,
        cursor as never,
        this.ctx,
      );
      out.push(...page.items);
      if (!page.next) break;
      cursor = page.next;
    }
    return out;
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
    const write = async (entry: SubmissionDraft) => {
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
