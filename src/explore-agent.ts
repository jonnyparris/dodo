import { Agent } from "agents";
import type { Env } from "./types";

/**
 * ExploreAgent — facet (sub-agent) for read-only codebase exploration.
 *
 * Phase 1 scaffold: registers the class with the Agents SDK as a facet and
 * exposes a placeholder `query()` RPC. Phase 2 will port the body of
 * `buildExploreTool.execute` in `agentic.ts` into this class so the
 * `generateText()` call and the read-only workspace tools run inside
 * this facet's Durable Object instead of blocking the parent's turn.
 *
 * Facets are co-located with the parent on the same machine and are
 * keyed by `(class, name)` — see `CodingAgent.subAgent(ExploreAgent, name)`.
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
}

export interface ExploreQueryResult {
  ok: true;
  facetName: string;
}

export class ExploreAgent extends Agent<Env> {
  /**
   * Run an exploration query. Phase 1 returns a placeholder so the
   * RPC surface is wired end-to-end before any behaviour moves.
   */
  async query(opts: ExploreQueryOpts): Promise<ExploreQueryResult> {
    // Intentional no-op parameter touches so TypeScript / linters don't
    // complain about unused args in the phase-1 placeholder. Phase 2
    // replaces this body with the real generateText() call.
    void opts.q;
    void opts.scope;
    void opts.model;

    return {
      ok: true,
      facetName: this.name,
    };
  }
}
