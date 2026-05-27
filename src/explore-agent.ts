import { Agent, getAgentByName } from "agents";
import {
  createReadTool,
  createListTool,
  createFindTool,
  createGrepTool,
} from "./think-adapter";
import { runSubagentForProfile } from "./subagent-runner";
import { EXPLORE_PROFILE, resolveProfileModel } from "./agent-profile";
import type { AppConfig, Env } from "./types";
import type { CodingAgent } from "./coding-agent";

/**
 * ExploreAgent — facet (sub-agent) for read-only codebase exploration.
 *
 * Phase 2 port: the real `generateText()` call from `buildExploreTool`
 * lives here now, gated behind `config.exploreMode === "facet"` in the
 * parent. The facet runs in its own Durable Object so:
 *
 *   - its LLM turns don't block the parent's stream
 *   - its SQLite storage is isolated (own transcript log)
 *   - phase 3 can fan out N facets for parallel exploration
 *
 * "Shared" workspace mode: the facet proxies read-only workspace ops
 * back to the parent via `facetReadFile` / `facetReadDir` / `facetGlob`
 * RPC methods. The parent's live workspace is the source of truth —
 * writes the parent made in previous turns are visible here.
 *
 * Requires the `"experimental"` compatibility flag.
 */
export interface ExploreQueryOpts {
  /** The natural-language exploration question. */
  q: string;
  /** Optional path prefix restricting the workspace surface. */
  scope?: string;
  /** Optional per-call model override. Falls back to the session's
   *  `exploreModel` config, then the provider-family heuristic. */
  model?: string;
  /**
   * The parent CodingAgent's session id. Needed so the facet can
   * resolve the parent stub and proxy workspace reads. The parent
   * fills this in automatically via `invokeExploreFacet()` — callers
   * from a test context can pass it themselves.
   */
  parentSessionId?: string;
  /**
   * Parent session config snapshot — the facet uses the same provider
   * / gateway / model-resolution rules as the parent. Optional because
   * the phase-1 placeholder path (and the scaffold test) didn't need
   * it; `query()` builds a synthetic fallback when absent.
   */
  parentConfig?: AppConfig;
}

export interface ExploreQueryResult {
  /** Always true when the call returns — errors surface via `summary`. */
  ok: true;
  /** Facet name (e.g. `pool-explore-0`). */
  facetName: string;
  /**
   * Formatted summary block, including the `## Explore results` header,
   * token usage, step count, and the model's free-form output. This is
   * what the parent explore tool returns to the main model verbatim.
   */
  summary: string;
  /** Total input tokens consumed by this facet run (all steps summed). */
  tokenInput: number;
  /** Total output tokens emitted by this facet run. */
  tokenOutput: number;
}

/**
 * Parent stub shape — narrow to the RPC methods this facet uses.
 * Keeps the facet decoupled from the rest of the CodingAgent surface.
 */
type ParentStub = Pick<
  CodingAgent,
  "facetReadFile" | "facetStat" | "facetReadDir" | "facetGlob"
>;

export class ExploreAgent extends Agent<Env> {
  private transcriptInitialized = false;

  /**
   * Lazy-create the `assistant_messages` table used for the transcript
   * log. Called from every entry point that writes rows so the table
   * always exists before we touch it. Keeping the DDL idempotent is
   * cheaper than wiring an explicit init hook (Agent.onStart is async
   * and we don't want query() to await it on every call).
   */
  private ensureTranscriptTable(): void {
    if (this.transcriptInitialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS assistant_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT,
        token_input INTEGER NOT NULL DEFAULT 0,
        token_output INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `);
    this.transcriptInitialized = true;
  }

  private recordTranscript(role: string, content: string, extras: { model?: string; tokenInput?: number; tokenOutput?: number } = {}): void {
    this.ensureTranscriptTable();
    this.ctx.storage.sql.exec(
      "INSERT INTO assistant_messages (role, content, model, token_input, token_output, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      role, content, extras.model ?? null, extras.tokenInput ?? 0, extras.tokenOutput ?? 0, Date.now(),
    );
  }

  /**
   * Return every recorded transcript row. Backs
   * `CodingAgent.getFacetTranscript` / `GET /session/:id/facets/:name/transcript`.
   */
  async getTranscript(): Promise<Array<Record<string, unknown>>> {
    this.ensureTranscriptTable();
    const rows = this.ctx.storage.sql.exec(
      "SELECT id, role, content, model, token_input as tokenInput, token_output as tokenOutput, created_at as createdAt FROM assistant_messages ORDER BY id ASC"
    ).toArray() as Array<Record<string, unknown>>;
    return rows;
  }

  /**
   * Run an exploration query inside this facet's DO.
   *
   * - Resolves the parent CodingAgent stub via `getAgentByName` so the
   *   facet can read the parent's workspace.
   * - Builds the same read-only tool subset the in-process path used.
   * - Runs `generateText()` with the session's selected model, the same
   *   system prompt, the same step + timeout budget.
   * - Returns a fully-formatted `## Explore results` block so callers
   *   can drop it straight into the parent's tool message.
   */
  async query(opts: ExploreQueryOpts): Promise<ExploreQueryResult> {
    if (!opts.parentSessionId || !opts.parentConfig) {
      throw new Error(
        "ExploreAgent.query() requires parentSessionId and parentConfig. Callers should go through CodingAgent.runExploreFacet() which auto-fills them.",
      );
    }

    const config = opts.parentConfig;
    const parentSessionId = opts.parentSessionId;

    const modelId = resolveProfileModel(
      EXPLORE_PROFILE,
      { model: opts.model },
      config.exploreModel,
      config.model,
    );

    // Get the parent stub and build read-only workspace tools that proxy
    // through the parent's workspace — see `CodingAgent.facetReadFile`.
    const parent = (await getAgentByName(
      this.env.CODING_AGENT as never,
      parentSessionId,
    )) as unknown as ParentStub;

    const readOnlyTools = {
      read: createReadTool({
        ops: {
          readFile: (path: string) => parent.facetReadFile(path),
          stat: (path: string) => parent.facetStat(path),
        },
      }),
      list: createListTool({
        ops: {
          readDir: (path: string, listOpts?: { limit?: number; offset?: number }) =>
            parent.facetReadDir(path, listOpts),
        },
      }),
      find: createFindTool({
        ops: {
          glob: (pattern: string) => parent.facetGlob(pattern),
        },
      }),
      grep: createGrepTool({
        ops: {
          glob: (pattern: string) => parent.facetGlob(pattern),
          readFile: (path: string) => parent.facetReadFile(path),
        },
      }),
    };

    const scope = opts.scope ? `\n\nSearch scope: ${opts.scope}` : "";
    const userMessage = `${opts.q}${scope}`;

    this.recordTranscript("user", userMessage, { model: modelId });

    try {
      const result = await runSubagentForProfile(EXPLORE_PROFILE, {
        prompt: userMessage,
        model: modelId,
        config,
        toolset: readOnlyTools,
        env: this.env,
      });

      const usageLine =
        result.tokenInput > 0 || result.tokenOutput > 0
          ? `**Tokens:** ${result.tokenInput} in / ${result.tokenOutput} out | `
          : "";

      const formatted = [
        `## Explore results (model: ${modelId}) [facet: ${this.name}]`,
        `${usageLine}**Steps:** ${result.steps} | **Tools used:** ${result.toolCalls.join(", ") || "none"}`,
        "",
        result.finalText ||
          "(No output — subagent ran its tool budget without emitting a summary. Try a narrower query or a higher-capability model via the `model` arg.)",
      ]
        .filter(Boolean)
        .join("\n");

      this.recordTranscript("assistant", formatted, {
        model: modelId,
        tokenInput: result.tokenInput,
        tokenOutput: result.tokenOutput,
      });

      return {
        ok: true,
        facetName: this.name,
        summary: formatted,
        tokenInput: result.tokenInput,
        tokenOutput: result.tokenOutput,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const failureSummary = `Explore failed (model: ${modelId}) [facet: ${this.name}]: ${msg}\n${EXPLORE_PROFILE.fallbackHint ?? ""}`;
      this.recordTranscript("assistant", failureSummary, { model: modelId });
      return {
        ok: true,
        facetName: this.name,
        summary: failureSummary,
        tokenInput: 0,
        tokenOutput: 0,
      };
    }
  }
}
