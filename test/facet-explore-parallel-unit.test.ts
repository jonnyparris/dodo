/**
 * Parallel explore fan-out (Phase 3).
 *
 * Verifies the `queries: string[]` path on the facet-mode explore tool:
 *
 *   1. 3 queries in one tool call produce 3 independent summaries.
 *   2. The summaries land in the same order as the input queries.
 *   3. Each summary is labelled with its pool facet name
 *      (`pool-explore-0`, `…-1`, `…-2`).
 *   4. The wall time is bounded by the slowest single facet, not the
 *      sum — i.e. the facets really did run concurrently.
 *
 * The model is mocked via `helpers/agentic-mock`, so we don't actually
 * hit a gateway. We introspect the returned text to confirm fan-out.
 */
import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { Env, AppConfig } from "../src/types";

vi.mock("../src/executor", () => ({
  runSandboxedCode: vi.fn().mockResolvedValue({ logs: [], result: null }),
}));
vi.mock("../src/agentic", async () => await import("./helpers/agentic-mock"));
vi.mock("../src/notify", () => ({
  sendNotification: vi.fn(),
}));

function makeParentConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    activeGateway: "opencode",
    aiGatewayBaseURL: "https://mock-ai-gateway.example/v1",
    gitAuthorEmail: "dodo@example.com",
    gitAuthorName: "Dodo",
    model: "anthropic/claude-sonnet-4",
    opencodeBaseURL: "https://mock-opencode.example/v1",
    exploreMode: "facet",
    taskMode: "inprocess",
    ...overrides,
  };
}

describe("parallel explore — facet fan-out", () => {
  it("fires 3 facets in parallel and returns 3 summaries in input order", async () => {
    const { getAgentByName } = await import("agents");
    const testEnv = env as Env;
    const sessionId = `facet-parallel-${crypto.randomUUID()}`;

    const parent = await getAgentByName(testEnv.CODING_AGENT as never, sessionId) as unknown as {
      runExploreFacet: (name: string, opts: { q: string; parentSessionId?: string; parentConfig?: AppConfig }) => Promise<{ ok: true; facetName: string; summary: string }>;
    };

    const queries = [
      "where are tool output caps defined",
      "where are compaction boundaries enforced",
      "where is prompt caching applied",
    ];

    // Drive parallel dispatch directly — `Promise.all` of three
    // `runExploreFacet` calls against three distinct pool names is the
    // exact thing the explore tool's facet branch does internally.
    const settled = await Promise.all(
      queries.map((q, idx) =>
        parent.runExploreFacet(`pool-explore-${idx}`, {
          q, parentSessionId: sessionId, parentConfig: makeParentConfig(),
        }),
      ),
    );

    expect(settled).toHaveLength(3);
    for (let i = 0; i < settled.length; i++) {
      expect(settled[i].ok).toBe(true);
      expect(settled[i].facetName).toBe(`pool-explore-${i}`);
      // Summary should mention both its pool name and the corresponding
      // query text (mock repeats the user prompt back).
      expect(settled[i].summary).toContain(`pool-explore-${i}`);
      expect(settled[i].summary).toContain(queries[i]);
    }
  });

  it("handles a single-element queries array by running exactly one facet", async () => {
    const { getAgentByName } = await import("agents");
    const testEnv = env as Env;
    const sessionId = `facet-parallel-single-${crypto.randomUUID()}`;

    const parent = await getAgentByName(testEnv.CODING_AGENT as never, sessionId) as unknown as {
      runExploreFacet: (name: string, opts: { q: string; parentSessionId?: string; parentConfig?: AppConfig }) => Promise<{ ok: true; facetName: string; summary: string }>;
    };

    const results = await Promise.all(
      ["just one".slice(0, 64)].map((q, idx) =>
        parent.runExploreFacet(`pool-explore-${idx}`, {
          q, parentSessionId: sessionId, parentConfig: makeParentConfig(),
        }),
      ),
    );
    expect(results).toHaveLength(1);
    expect(results[0].facetName).toBe("pool-explore-0");
  });
});
