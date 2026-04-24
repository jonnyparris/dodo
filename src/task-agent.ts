import { Workspace } from "@cloudflare/shell";
import { Agent, getAgentByName } from "agents";
import { generateText, stepCountIs, type ToolSet } from "ai";
import {
  createReadTool,
  createListTool,
  createFindTool,
  createGrepTool,
  createWriteTool,
  createEditTool,
} from "@cloudflare/think/tools/workspace";
import {
  buildProviderForModel,
  capToolOutputs,
  resolveSubagentModel,
  TASK_SYSTEM_PROMPT,
  TASK_MAX_STEPS,
  TASK_FACET_TIMEOUT_MS,
} from "./agentic";
import type { AppConfig, Env } from "./types";
import type { CodingAgent } from "./coding-agent";

/**
 * TaskAgent — facet (sub-agent) for general read+write coding tasks that
 * need their own LLM turn budget and, optionally, a scratch workspace.
 *
 * Phase 4: real task port + opt-in workspace isolation.
 *
 * `workspaceMode: "shared"` (default) — the facet proxies workspace
 * reads AND writes back to the parent via RPC. Parent workspace
 * mutations are immediate and visible to both sides.
 *
 * `workspaceMode: "scratch"` — the facet gets its own local `Workspace`
 * instance keyed by the facet's own SQL + an R2 prefix of
 * `workspace/<parentSessionId>/scratch/<facetName>/`. The parent
 * workspace is untouched. After the task returns, the parent can call
 * `applyFromScratch(paths)` to selectively copy scratch files back
 * into the parent workspace (via facetWriteFile on the parent).
 *
 * Retention: a 24h cleanup alarm is scheduled on the parent (facets
 * can't self-schedule — the Agents SDK throws on `setAlarm` inside a
 * facet). The parent's cleanup hook deletes the R2 prefix and the
 * facet's DO storage via `deleteSubAgent`.
 *
 * Requires the `"experimental"` compatibility flag.
 */

export interface TaskInvokeOpts {
  /** Natural-language task description. */
  prompt: string;
  /** Optional path prefix restricting the workspace surface. */
  scope?: string;
  /** Optional per-call model override. */
  model?: string;
  /** Workspace isolation mode — see class docstring. */
  workspaceMode?: "shared" | "scratch";
  /**
   * Parent CodingAgent's session id — needed so the facet can proxy
   * workspace reads/writes back to the parent (shared mode) or derive
   * the scratch R2 prefix (scratch mode).
   */
  parentSessionId?: string;
  /** Parent session config snapshot — drives provider + model selection. */
  parentConfig?: AppConfig;
}

export interface TaskInvokeResult {
  ok: true;
  facetName: string;
  /** Formatted `## Task results` block, ready to drop into the parent transcript. */
  summary: string;
  /** Workspace mode the task actually ran in. */
  workspaceMode: "shared" | "scratch";
  /** Total input tokens consumed by this facet run (all steps summed). */
  tokenInput: number;
  /** Total output tokens emitted by this facet run. */
  tokenOutput: number;
  /**
   * In scratch mode: list of paths the facet wrote under its scratch
   * workspace. Parent can pass a subset of these back through
   * `applyFromScratch()` to merge.
   */
  scratchWrites?: string[];
}

export interface ApplyFromScratchResult {
  ok: true;
  applied: string[];
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * Narrow parent stub shape — only the RPCs this facet touches. Keeps
 * the facet decoupled from the wider CodingAgent surface.
 */
type ParentStub = Pick<
  CodingAgent,
  | "facetReadFile"
  | "facetStat"
  | "facetReadDir"
  | "facetGlob"
  | "facetWriteFile"
>;

export class TaskAgent extends Agent<Env> {
  /**
   * Cache the scratch Workspace — the @cloudflare/shell Workspace
   * constructor registers the namespace on the SqlBackend, and
   * registering the same namespace twice throws. Re-using one instance
   * per facet lifetime sidesteps that.
   */
  private _scratchWorkspace: Workspace | null = null;
  private schemaInitialized = false;

  /**
   * Create both the transcript table and the scratch-writes index.
   *
   * The scratch-writes table is the durable replacement for what used
   * to be an in-memory `Set<string>` — DO eviction between `task()` and
   * a later `applyFromScratch()` would wipe the set, causing every
   * merge-back request to be rejected as "not among the files written".
   * Persisting to SQL (same ctx.storage.sql that holds assistant_messages)
   * keeps the write list stable across evictions for the whole scratch
   * lifetime, until the 24h alarm fires.
   */
  private ensureSchema(): void {
    if (this.schemaInitialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS assistant_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT,
        workspace_mode TEXT,
        token_input INTEGER NOT NULL DEFAULT 0,
        token_output INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS scratch_writes (
        path TEXT PRIMARY KEY,
        written_at INTEGER NOT NULL
      )
    `);
    this.schemaInitialized = true;
  }

  /** Back-compat name — other call sites still reference this. */
  private ensureTranscriptTable(): void {
    this.ensureSchema();
  }

  /** Record a scratch write so applyFromScratch can validate it later. */
  private recordScratchWrite(path: string): void {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      "INSERT INTO scratch_writes (path, written_at) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET written_at = excluded.written_at",
      path, Date.now(),
    );
  }

  /** Return every recorded scratch write path. */
  private listScratchWrites(): string[] {
    this.ensureSchema();
    const rows = this.ctx.storage.sql.exec(
      "SELECT path FROM scratch_writes ORDER BY written_at ASC"
    ).toArray() as Array<{ path: string }>;
    return rows.map((r) => r.path);
  }

  /** Check whether a specific path was written during a scratch run. */
  private hasScratchWrite(path: string): boolean {
    this.ensureSchema();
    const rows = this.ctx.storage.sql.exec(
      "SELECT 1 as hit FROM scratch_writes WHERE path = ? LIMIT 1",
      path,
    ).toArray();
    return rows.length > 0;
  }

  /** Wipe the scratch-writes index — called by cleanupScratch. */
  private clearScratchWrites(): void {
    this.ensureSchema();
    this.ctx.storage.sql.exec("DELETE FROM scratch_writes");
  }

  private recordTranscript(role: string, content: string, extras: { model?: string; workspaceMode?: string; tokenInput?: number; tokenOutput?: number } = {}): void {
    this.ensureTranscriptTable();
    this.ctx.storage.sql.exec(
      "INSERT INTO assistant_messages (role, content, model, workspace_mode, token_input, token_output, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      role, content, extras.model ?? null, extras.workspaceMode ?? null, extras.tokenInput ?? 0, extras.tokenOutput ?? 0, Date.now(),
    );
  }

  /**
   * Return every recorded transcript row. Backs
   * `CodingAgent.getFacetTranscript` / `GET /session/:id/facets/:name/transcript`.
   */
  async getTranscript(): Promise<Array<Record<string, unknown>>> {
    this.ensureTranscriptTable();
    const rows = this.ctx.storage.sql.exec(
      "SELECT id, role, content, model, workspace_mode as workspaceMode, token_input as tokenInput, token_output as tokenOutput, created_at as createdAt FROM assistant_messages ORDER BY id ASC"
    ).toArray() as Array<Record<string, unknown>>;
    return rows;
  }

  /**
   * Run a task. Phase 4 real implementation.
   */
  async task(opts: TaskInvokeOpts): Promise<TaskInvokeResult> {
    if (!opts.parentSessionId || !opts.parentConfig) {
      throw new Error(
        "TaskAgent.task() requires parentSessionId and parentConfig. Callers should go through CodingAgent.runTaskFacet() which auto-fills them.",
      );
    }

    const config = opts.parentConfig;
    const parentSessionId = opts.parentSessionId;
    const workspaceMode: "shared" | "scratch" = opts.workspaceMode ?? "shared";

    const modelId = resolveSubagentModel({ model: opts.model }, config.taskModel, config.model);
    const provider = buildProviderForModel(modelId, config, this.env);
    const model = provider.chatModel(modelId);

    const parent = (await getAgentByName(
      this.env.CODING_AGENT as never,
      parentSessionId,
    )) as unknown as ParentStub;

    // Scratch writes accumulate across multiple task() calls on the
    // same pooled facet until cleanup fires — do NOT clear them here.
    // applyFromScratch needs every write ever made in this scratch
    // lifetime to be eligible for merge-back.
    this.ensureSchema();

    // Persist parentSessionId up-front so a later applyFromScratch()
    // after DO eviction can recover the scratch R2 prefix. Previously
    // this was a fire-and-forget `void ctx.storage.put(...)` inside
    // openScratchWorkspace — that write could in principle be dropped
    // if called outside a request-gated path. Awaiting it here guarantees
    // durability before the first tool invocation can run.
    if (workspaceMode === "scratch") {
      await this.persistParentSessionId(parentSessionId);
    }

    // Build the task tool set. Shared mode proxies everything through
    // the parent so all writes hit the parent workspace. Scratch mode
    // uses a facet-local Workspace rooted at a scratch R2 prefix.
    const taskTools = workspaceMode === "shared"
      ? this.buildSharedTools(parent)
      : this.buildScratchTools(parentSessionId);

    const scope = opts.scope ? `\n\nScope hint: ${opts.scope}` : "";
    const userMessage = `${opts.prompt}${scope}`;

    this.recordTranscript("user", userMessage, { model: modelId, workspaceMode });

    // Facets always get the extended timeout regardless of workspace
    // mode — the point of moving task into a facet DO is to escape the
    // parent's turn budget, and a 180s ceiling defeats that. In-process
    // mode keeps the 180s TASK_TIMEOUT_MS (see buildTaskTool).
    const timeoutMs = TASK_FACET_TIMEOUT_MS;

    try {
      const result = await generateText({
        model,
        system: TASK_SYSTEM_PROMPT,
        messages: [{ role: "user" as const, content: userMessage }],
        tools: taskTools,
        stopWhen: stepCountIs(TASK_MAX_STEPS),
        maxOutputTokens: 4000,
        abortSignal: AbortSignal.timeout(timeoutMs),
      });

      const summaryText = result.text;
      const steps = result.steps.length;
      const toolCalls = result.steps.flatMap((s) =>
        (s.toolCalls ?? []).map((tc) => tc.toolName),
      );
      const totalInput = result.steps.reduce((sum, s) => sum + (s.usage?.inputTokens ?? 0), 0);
      const totalOutput = result.steps.reduce((sum, s) => sum + (s.usage?.outputTokens ?? 0), 0);
      const usageLine = totalInput > 0 || totalOutput > 0
        ? `**Tokens:** ${totalInput} in / ${totalOutput} out | `
        : "";

      const modeLabel = workspaceMode === "scratch" ? " [scratch workspace]" : "";
      const formatted = [
        `## Task results (model: ${modelId}) [facet: ${this.name}]${modeLabel}`,
        `${usageLine}**Steps:** ${steps} | **Tools used:** ${toolCalls.join(", ") || "none"}`,
        "",
        summaryText || "(No output — task ran its step budget without emitting a summary.)",
      ].filter(Boolean).join("\n");

      this.recordTranscript("assistant", formatted, {
        model: modelId,
        workspaceMode,
        tokenInput: totalInput,
        tokenOutput: totalOutput,
      });

      return {
        ok: true,
        facetName: this.name,
        summary: formatted,
        workspaceMode,
        tokenInput: totalInput,
        tokenOutput: totalOutput,
        scratchWrites: workspaceMode === "scratch" ? this.listScratchWrites() : undefined,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const failureSummary = `Task failed (model: ${modelId}) [facet: ${this.name}]: ${msg}`;
      this.recordTranscript("assistant", failureSummary, { model: modelId, workspaceMode });
      return {
        ok: true,
        facetName: this.name,
        summary: failureSummary,
        workspaceMode,
        tokenInput: 0,
        tokenOutput: 0,
      };
    }
  }

  /**
   * Copy the named files from this facet's scratch workspace back into
   * the parent session's workspace. Only files previously written
   * during a scratch run (tracked in the `scratch_writes` SQL table)
   * are eligible; requests for other paths are skipped and reported
   * in the result.
   *
   * Survives DO eviction: the scratch writes index is SQL-backed, not
   * in-memory. A merge-back request minutes or hours after the task
   * ran still works correctly.
   *
   * No-op when the facet has never run a scratch task or when the
   * facet has no scratch workspace instantiated.
   */
  async applyFromScratch(paths: string[]): Promise<ApplyFromScratchResult> {
    const applied: string[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];

    const parentSessionId = (await this.ctx.storage.get<string>("parentSessionId")) ?? undefined;
    if (!parentSessionId) {
      return {
        ok: true,
        applied: [],
        skipped: paths.map((p) => ({ path: p, reason: "facet has no scratch workspace" })),
      };
    }

    const scratch = this.openScratchWorkspace(parentSessionId);
    const parent = (await getAgentByName(
      this.env.CODING_AGENT as never,
      parentSessionId,
    )) as unknown as ParentStub;

    for (const path of paths) {
      if (!this.hasScratchWrite(path)) {
        skipped.push({ path, reason: "not among the files the facet wrote during scratch runs" });
        continue;
      }
      const content = await scratch.readFile(path);
      if (content === null) {
        skipped.push({ path, reason: "scratch workspace has no file at this path (concurrent cleanup?)" });
        continue;
      }
      await parent.facetWriteFile(path, content);
      applied.push(path);
    }

    return { ok: true, applied, skipped };
  }

  /**
   * Open the facet's scratch Workspace, keyed on the facet's own SQL
   * storage and an R2 prefix derived from the parent session id.
   *
   * parentSessionId durability is the caller's responsibility — real
   * runs go through `task()` which awaits `persistParentSessionId`
   * before any tool can fire. This method stays synchronous so tool
   * op closures can open the workspace without refactoring to async.
   */
  private openScratchWorkspace(parentSessionId: string): Workspace {
    if (this._scratchWorkspace) return this._scratchWorkspace;
    this._scratchWorkspace = new Workspace({
      sql: this.ctx.storage.sql,
      r2: this.env.WORKSPACE_BUCKET,
      r2Prefix: `workspace/${parentSessionId}/scratch/${this.name}`,
      name: () => this.name,
    });
    return this._scratchWorkspace;
  }

  /**
   * Persist parentSessionId to DO KV storage so
   * `applyFromScratch` can recover it after DO eviction. Guarded by
   * an in-memory flag to avoid redundant writes on hot paths.
   */
  private _persistedParent: string | null = null;
  private async persistParentSessionId(parentSessionId: string): Promise<void> {
    if (this._persistedParent === parentSessionId) return;
    await this.ctx.storage.put("parentSessionId", parentSessionId);
    this._persistedParent = parentSessionId;
  }

  /**
   * Build the tool set for shared-workspace mode. Every op proxies back
   * to the parent's workspace so writes land immediately in the
   * canonical session state.
   */
  private buildSharedTools(parent: ParentStub): ToolSet {
    return capToolOutputs({
      read: createReadTool({
        ops: {
          readFile: (path: string) => parent.facetReadFile(path),
          stat: (path: string) => parent.facetStat(path),
        },
      }),
      list: createListTool({
        ops: {
          readDir: (path: string, opts?: { limit?: number; offset?: number }) =>
            parent.facetReadDir(path, opts),
        },
      }),
      find: createFindTool({
        ops: { glob: (pattern: string) => parent.facetGlob(pattern) },
      }),
      grep: createGrepTool({
        ops: {
          glob: (pattern: string) => parent.facetGlob(pattern),
          readFile: (path: string) => parent.facetReadFile(path),
        },
      }),
      write: createWriteTool({
        ops: {
          writeFile: async (path: string, content: string) => {
            await parent.facetWriteFile(path, content);
          },
          mkdir: async () => { /* shared mode: parent creates dirs implicitly on write */ },
        },
      }),
      edit: createEditTool({
        ops: {
          readFile: (path: string) => parent.facetReadFile(path),
          writeFile: async (path: string, content: string) => {
            await parent.facetWriteFile(path, content);
          },
        },
      }),
    });
  }

  /**
   * Build the tool set for scratch-workspace mode. Reads hit the
   * parent's workspace (starting state) OR the scratch workspace
   * (earlier writes from this same task) — the scratch workspace
   * fallback matters so the task sees its own edits mid-run. Writes
   * only land in the scratch workspace and are tracked in
   * `scratchWrites` so `applyFromScratch` can validate.
   */
  private buildScratchTools(parentSessionId: string): ToolSet {
    const scratch = this.openScratchWorkspace(parentSessionId);

    const readFromScratchThenParent = async (path: string): Promise<string | null> => {
      const scratchContent = await scratch.readFile(path);
      if (scratchContent !== null) return scratchContent;
      const parent = (await getAgentByName(
        this.env.CODING_AGENT as never,
        parentSessionId,
      )) as unknown as ParentStub;
      return parent.facetReadFile(path);
    };

    const writeToScratch = async (path: string, content: string): Promise<void> => {
      await scratch.writeFile(path, content);
      this.recordScratchWrite(path);
    };

    return capToolOutputs({
      read: createReadTool({
        ops: {
          readFile: readFromScratchThenParent,
          stat: async (path: string) => {
            const stat = await scratch.stat(path);
            if (stat) return stat;
            const parent = (await getAgentByName(
              this.env.CODING_AGENT as never,
              parentSessionId,
            )) as unknown as ParentStub;
            return parent.facetStat(path);
          },
        },
      }),
      list: createListTool({
        ops: {
          // Scratch lists are the union of parent + scratch entries, but
          // for simplicity we defer to the parent — scratch tasks that
          // need listings should search by pattern via find/grep, which
          // we override below to read scratch directly.
          readDir: async (path: string, opts?: { limit?: number; offset?: number }) => {
            const parent = (await getAgentByName(
              this.env.CODING_AGENT as never,
              parentSessionId,
            )) as unknown as ParentStub;
            return parent.facetReadDir(path, opts);
          },
        },
      }),
      find: createFindTool({
        ops: {
          glob: async (pattern: string) => {
            // Include both scratch and parent hits so scratch writes
            // show up in finds done later in the same task run.
            const [scratchHits, parent] = await Promise.all([
              scratch.glob(pattern),
              getAgentByName(
                this.env.CODING_AGENT as never,
                parentSessionId,
              ) as unknown as Promise<ParentStub>,
            ]);
            const parentHits = await parent.facetGlob(pattern);
            // De-dupe by path; scratch wins (fresher metadata).
            const seen = new Set<string>();
            const combined = [...scratchHits, ...parentHits].filter((f) => {
              if (seen.has(f.path)) return false;
              seen.add(f.path);
              return true;
            });
            return combined;
          },
        },
      }),
      grep: createGrepTool({
        ops: {
          glob: async (pattern: string) => {
            const scratchHits = await scratch.glob(pattern);
            const parent = (await getAgentByName(
              this.env.CODING_AGENT as never,
              parentSessionId,
            )) as unknown as ParentStub;
            const parentHits = await parent.facetGlob(pattern);
            const seen = new Set<string>();
            return [...scratchHits, ...parentHits].filter((f) => {
              if (seen.has(f.path)) return false;
              seen.add(f.path);
              return true;
            });
          },
          readFile: readFromScratchThenParent,
        },
      }),
      write: createWriteTool({
        ops: {
          writeFile: writeToScratch,
          mkdir: async (path: string, opts?: { recursive?: boolean }) => {
            await scratch.mkdir(path, opts);
          },
        },
      }),
      edit: createEditTool({
        ops: {
          readFile: readFromScratchThenParent,
          writeFile: writeToScratch,
        },
      }),
    });
  }

  /**
   * Test-only: simulate a scratch write without running the model. The
   * real `task()` call writes via the write/edit tools the model
   * invokes; exposing this directly is the simplest way to assert
   * scratch isolation in unit tests.
   *
   * Parent CodingAgent is responsible for only calling this from
   * test contexts. Not surfaced on any public HTTP route.
   */
  async writeScratchForTest(parentSessionId: string, path: string, content: string): Promise<{ ok: true }> {
    // Mirror the real runtime path: task() awaits persistParentSessionId
    // before the first write tool can fire. Tests that drive scratch
    // writes without calling task() must do the same, otherwise a later
    // applyFromScratch() can't recover parentSessionId from storage.
    await this.persistParentSessionId(parentSessionId);
    const scratch = this.openScratchWorkspace(parentSessionId);
    await scratch.writeFile(path, content);
    this.recordScratchWrite(path);
    return { ok: true };
  }

  /**
   * Test-only: read from the scratch workspace. Paired with
   * `writeScratchForTest` so tests can confirm scratch state without
   * round-tripping through the model.
   */
  async readScratchForTest(parentSessionId: string, path: string): Promise<string | null> {
    await this.persistParentSessionId(parentSessionId);
    const scratch = this.openScratchWorkspace(parentSessionId);
    return scratch.readFile(path);
  }

  /**
   * Called by the parent CodingAgent 24h after the last scratch task
   * completed. Wipes the scratch R2 prefix. Facet storage itself is
   * wiped by the parent's matching `deleteSubAgent` call.
   */
  async cleanupScratch(parentSessionId: string): Promise<{ deleted: number }> {
    const bucket = this.env.WORKSPACE_BUCKET;
    if (!bucket) return { deleted: 0 };
    const prefix = `workspace/${parentSessionId}/scratch/${this.name}/`;
    let deleted = 0;
    // Re-list from the prefix on every iteration rather than advancing
    // via cursor. Each iteration deletes the batch it just listed, so
    // the next list starts from whatever is left under the prefix —
    // which terminates naturally when nothing is left. Avoids the
    // brittleness of relying on cursor semantics across concurrent
    // deletes from the same listing.
    for (;;) {
      const listed = await bucket.list({ prefix, limit: 1000 });
      if (listed.objects.length === 0) break;
      await bucket.delete(listed.objects.map((o) => o.key));
      deleted += listed.objects.length;
      if (!listed.truncated) break;
    }
    this.clearScratchWrites();
    return { deleted };
  }
}
