import { Agent, getAgentByName } from "agents";
import { generateText, stepCountIs } from "ai";
import {
  createReadTool,
  createListTool,
  createFindTool,
  createGrepTool,
} from "@cloudflare/think/tools/workspace";
import {
  buildProviderForModel,
  capToolOutputs,
  EXPLORE_SYSTEM_PROMPT,
  EXPLORE_MAX_STEPS,
  EXPLORE_TIMEOUT_MS,
  resolveSubagentModel,
} from "./agentic";
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
    // If no parent session context, fall back to the placeholder. This
    // keeps the phase-1 scaffold test green and gives a deterministic
    // signal when the facet is invoked without proper plumbing.
    if (!opts.parentSessionId || !opts.parentConfig) {
      return {
        ok: true,
        facetName: this.name,
        summary: `## Explore results (placeholder)\n\nFacet ${this.name} reached without parent session context (parentSessionId or parentConfig missing). Phase 1 scaffold mode.`,
      };
    }

    const config = opts.parentConfig;
    const parentSessionId = opts.parentSessionId;

    const modelId = resolveSubagentModel({ model: opts.model }, config.exploreModel, config.model);
    const provider = buildProviderForModel(modelId, config, this.env);
    const model = provider.chatModel(modelId);

    // Get the parent stub and build read-only workspace tools that proxy
    // through the parent's workspace — see `CodingAgent.facetReadFile`.
    const parent = (await getAgentByName(
      this.env.CODING_AGENT as never,
      parentSessionId,
    )) as unknown as ParentStub;

    const readOnlyTools = capToolOutputs({
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
    });

    const scope = opts.scope ? `\n\nSearch scope: ${opts.scope}` : "";
    const userMessage = `${opts.q}${scope}`;

    this.recordTranscript("user", userMessage, { model: modelId });

    try {
      const result = await generateText({
        model,
        system: EXPLORE_SYSTEM_PROMPT,
        messages: [{ role: "user" as const, content: userMessage }],
        tools: readOnlyTools,
        stopWhen: stepCountIs(EXPLORE_MAX_STEPS),
        maxOutputTokens: 4000,
        abortSignal: AbortSignal.timeout(EXPLORE_TIMEOUT_MS),
      });

      const summary = result.text;
      const steps = result.steps.length;
      const toolCalls = result.steps.flatMap((s) =>
        (s.toolCalls ?? []).map((tc) => tc.toolName),
      );
      const totalInput = result.steps.reduce(
        (sum, s) => sum + (s.usage?.inputTokens ?? 0),
        0,
      );
      const totalOutput = result.steps.reduce(
        (sum, s) => sum + (s.usage?.outputTokens ?? 0),
        0,
      );
      const usageLine =
        totalInput > 0 || totalOutput > 0
          ? `**Tokens:** ${totalInput} in / ${totalOutput} out | `
          : "";

      const formatted = [
        `## Explore results (model: ${modelId}) [facet: ${this.name}]`,
        `${usageLine}**Steps:** ${steps} | **Tools used:** ${toolCalls.join(", ") || "none"}`,
        "",
        summary ||
          "(No output — subagent ran its tool budget without emitting a summary. Try a narrower query or a higher-capability model via the `model` arg.)",
      ]
        .filter(Boolean)
        .join("\n");

      this.recordTranscript("assistant", formatted, {
        model: modelId,
        tokenInput: totalInput,
        tokenOutput: totalOutput,
      });

      return { ok: true, facetName: this.name, summary: formatted };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const failureSummary = `Explore failed (model: ${modelId}) [facet: ${this.name}]: ${msg}`;
      this.recordTranscript("assistant", failureSummary, { model: modelId });
      return {
        ok: true,
        facetName: this.name,
        summary: failureSummary,
      };
    }
  }
}
