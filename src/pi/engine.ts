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
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import {
  type AgentEvent,
  AssistantEntry,
  createRegistry,
  defineExtension,
  type EntryRecord,
  type Extension,
  Harness,
  type HarnessSettings,
  section,
  type Submission,
  watchEvents,
} from "@earendil-works/pi-durable";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

export const PI_TABLE_PREFIX = "pi_";
export const DODO_USER_ENTRY = "dodo.user";

export type PiUserContent = string | Array<TextContent | ImageContent>;

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
   * Refresh model access on the shared Models collection (e.g. after a
   * model/gateway change). Called before every run. pi-durable > 1.3.0
   * accepts a function for `models`; until then we mutate one collection.
   */
  configureModels(models: MutableModels): void;
  /** Current model ref for the conversation. */
  modelRef(): { provider: string; modelId: string };
  /** Current system prompt. Rendered before each model request. */
  systemPrompt(): string;
  /** Emit a Dodo SSE/WS event. */
  emit(event: { type: string; data: unknown }): void;
  log(level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>): void;
}

export interface PiTurnInput {
  promptId: string;
  /** Builds the turn's user content. Only called the first time a prompt runs — not on recovery. */
  prepare: () => Promise<{ content: PiUserContent; entry: DodoUserEntryData }>;
  /** Current tool set as a pi extension; installed before the run starts. */
  tools: Extension;
  signal?: AbortSignal;
}

export interface PiTurnResult {
  assistantMessageId: string;
  text: string;
  tokenInput: number;
  tokenOutput: number;
  steps: number;
  toolCalls: string[];
  recovered: boolean;
  status: "done" | "unanswered";
  reason?: string;
}

const SETTINGS: HarnessSettings = {
  retry: { maxRetries: 3 },
  compaction: { enabled: true },
  // DO SQLite is local; 250 ms keeps write volume modest while streaming.
  progress: { partialIntervalMs: 250, outputIntervalMs: 250 },
  toolExecution: "parallel",
};

function textOf(message: AssistantMessage | UserMessage | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  return content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
}

export class PiEngine {
  private harness: Harness | undefined;
  private opening: Promise<Harness> | undefined;
  private database: DurableObjectSqliteDatabase | undefined;
  private readonly registry = createRegistry();
  private readonly ctx: Context = BACKGROUND_CONTEXT;
  private readonly models: MutableModels = createModels();

  constructor(private readonly host: PiEngineHost) {
    this.registry.install(
      defineExtension({
        name: "dodo-prompt",
        sections: [section("dodo", () => this.host.systemPrompt(), { tag: false })],
      }),
    );
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
    this.host.configureModels(this.models);
    if (this.harness) return this.harness;
    if (!this.opening) {
      this.opening = (async () => {
        const database = await this.db();
        const storage = await SqliteStorage.open(database, { prefix: PI_TABLE_PREFIX });
        const harness = await Harness.open(
          storage,
          {
            models: this.models,
            registry: this.registry,
            settings: SETTINGS,
            onReport: (error) =>
              this.host.log("warn", "pi-durable report", { error: error instanceof Error ? error.message : String(error) }),
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
    const harness = await this.open();
    this.registry.install(input.tools);
    const root = await this.root();
    const model = this.host.modelRef();
    const agent = await root.agent(this.ctx);
    if (agent.model?.provider !== model.provider || agent.model?.modelId !== model.modelId) {
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
    if (!submission) {
      const { content, entry } = await input.prepare();
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

    const acc = { steps: 0, input: 0, output: 0, toolCalls: [] as string[] };
    const stream = await watchEvents(harness, root.id, this.ctx);
    stream.start(async (events) => {
      for (const event of events) this.bridge(event, acc);
    });

    const onAbort = () => {
      void root.abort(this.ctx).catch(() => {});
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
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
      steps: acc.steps,
      toolCalls: acc.toolCalls,
      recovered,
      status: "done",
    };
  }

  /** Translate pi agent events into Dodo's SSE protocol. */
  private bridge(event: AgentEvent, acc: { steps: number; input: number; output: number; toolCalls: string[] }): void {
    switch (event.type) {
      case "message_update":
        for (const change of event.changes) {
          if (change.type === "text_delta") this.host.emit({ type: "text_delta", data: { delta: change.delta } });
        }
        return;
      case "message_end": {
        if (event.entry.kind !== "pi.assistant") return;
        acc.steps++;
        const m = event.entry.model?.[0] as AssistantMessage | undefined;
        acc.input += m?.usage?.input ?? 0;
        acc.output += m?.usage?.output ?? 0;
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

  async close(): Promise<void> {
    const harness = this.harness;
    this.harness = undefined;
    this.opening = undefined;
    if (harness) await harness.close(this.ctx);
  }
}

export interface PiMessageView {
  role: "user" | "assistant";
  /** Dodo message id: the user's prepared id, or the answer entry id. */
  id: string;
  content: string;
  authorEmail: string | null;
  createdAt: number | null;
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
      const text = data.text ?? textOf(entry.model?.[0] as UserMessage | undefined);
      out.push({
        role: "user",
        id: data.messageId ?? String(entry.id),
        content: text,
        authorEmail: data.authorEmail ?? null,
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
