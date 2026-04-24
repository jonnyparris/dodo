/**
 * Facet explore end-to-end (Phase 2).
 *
 * Exercises the real ExploreAgent.query() path — generateText + proxied
 * workspace tools + summary formatting — with the model provider mocked
 * at the agentic layer. Verifies:
 *
 *   1. The parent config + sessionId round-trip makes it into the facet.
 *   2. The facet returns a `## Explore results` block with the facet name.
 *   3. The facet's call resolves the correct model via
 *      `resolveSubagentModel`, honouring per-call overrides.
 *
 * This test complements `facet-scaffold-unit.test.ts` which exercises
 * the phase-1 placeholder branch.
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

describe("ExploreAgent.query — facet-mode explore", () => {
  it("returns a ## Explore results block with the facet name in the header", async () => {
    const { getAgentByName } = await import("agents");
    const testEnv = env as Env;
    const sessionId = `facet-explore-happy-${crypto.randomUUID()}`;

    const parent = await getAgentByName(testEnv.CODING_AGENT as never, sessionId) as unknown as {
      runExploreFacet: (name: string, opts: { q: string; parentSessionId?: string; parentConfig?: AppConfig }) => Promise<{ ok: true; facetName: string; summary: string }>;
    };

    const result = await parent.runExploreFacet("pool-explore-0", {
      q: "where are tokens computed",
      parentSessionId: sessionId,
      parentConfig: makeParentConfig(),
    });

    expect(result.ok).toBe(true);
    expect(result.facetName).toBe("pool-explore-0");
    // The formatted header must mention both the resolved model and the
    // facet name so the parent transcript clearly attributes where the
    // result came from.
    expect(result.summary).toMatch(/^## Explore results/);
    expect(result.summary).toContain("facet: pool-explore-0");
    // Heuristic model resolution: anthropic/sonnet → anthropic/haiku.
    expect(result.summary).toContain("anthropic/claude-haiku-4-5");
  });

  it("honours per-call model overrides", async () => {
    const { getAgentByName } = await import("agents");
    const testEnv = env as Env;
    const sessionId = `facet-explore-override-${crypto.randomUUID()}`;

    const parent = await getAgentByName(testEnv.CODING_AGENT as never, sessionId) as unknown as {
      runExploreFacet: (name: string, opts: { q: string; model?: string; parentSessionId?: string; parentConfig?: AppConfig }) => Promise<{ ok: true; facetName: string; summary: string }>;
    };

    const result = await parent.runExploreFacet("pool-explore-0", {
      q: "anything",
      model: "openai/gpt-4.1-mini",
      parentSessionId: sessionId,
      parentConfig: makeParentConfig(),
    });

    expect(result.summary).toContain("openai/gpt-4.1-mini");
  });

  it("different pool names produce independently-labelled summaries", async () => {
    const { getAgentByName } = await import("agents");
    const testEnv = env as Env;
    const sessionId = `facet-explore-pools-${crypto.randomUUID()}`;

    const parent = await getAgentByName(testEnv.CODING_AGENT as never, sessionId) as unknown as {
      runExploreFacet: (name: string, opts: { q: string; parentSessionId?: string; parentConfig?: AppConfig }) => Promise<{ ok: true; facetName: string; summary: string }>;
    };

    const a = await parent.runExploreFacet("pool-explore-0", {
      q: "a", parentSessionId: sessionId, parentConfig: makeParentConfig(),
    });
    const b = await parent.runExploreFacet("pool-explore-1", {
      q: "b", parentSessionId: sessionId, parentConfig: makeParentConfig(),
    });

    expect(a.facetName).toBe("pool-explore-0");
    expect(b.facetName).toBe("pool-explore-1");
    expect(a.summary).toContain("pool-explore-0");
    expect(b.summary).toContain("pool-explore-1");
  });
});
