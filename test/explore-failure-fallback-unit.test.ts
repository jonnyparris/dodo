/**
 * Failure-path tests for the explore subagent. Asserts that when the
 * underlying runSubagent call throws, the formatted failure summary
 * includes EXPLORE_FALLBACK_HINT so the orchestrator doesn't give up.
 *
 * The mock's `shouldFail` heuristic throws for prompts containing
 * "This should fail" / "This will fail".
 */
import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { Env, AppConfig } from "../src/types";
import { EXPLORE_FALLBACK_HINT } from "../src/subagent-runner";

vi.mock("@cloudflare/codemode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cloudflare/codemode")>();
  return {
    ...actual,
    DynamicWorkerExecutor: vi.fn(function () {
      return { execute: vi.fn().mockResolvedValue({ logs: [], result: null }) };
    }) as unknown as typeof import("@cloudflare/codemode").DynamicWorkerExecutor,
  };
});
vi.mock("../src/agentic", async () => await import("./helpers/agentic-mock"));
vi.mock("../src/subagent-runner", async () => await import("./helpers/subagent-runner-mock"));
vi.mock("../src/notify", () => ({
  dispatchNotification: vi.fn(),
}));

// Override the subagent runner entry points to throw — covers the catch
// block in ExploreAgent.query() which formats the EXPLORE_FALLBACK_HINT
// into the summary. The facet calls `runSubagentForProfile`; the legacy
// `runSubagent` is mocked too so tests that hit either path still see
// the failure surfaced as a fallback hint.
vi.mock("../src/subagent-runner", async () => {
  const base = await import("./helpers/subagent-runner-mock");
  return {
    ...base,
    runSubagent: vi.fn().mockRejectedValue(new Error("internal API error")),
    runSubagentForProfile: vi.fn().mockRejectedValue(new Error("internal API error")),
  };
});

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

describe("ExploreAgent.query — failure produces a fallback hint", () => {
  it("appends EXPLORE_FALLBACK_HINT to the summary when runSubagent throws", async () => {
    const { getAgentByName } = await import("agents");
    const testEnv = env as Env;
    const sessionId = `facet-explore-fail-${crypto.randomUUID()}`;

    const parent = await getAgentByName(testEnv.CODING_AGENT as never, sessionId) as unknown as {
      runExploreFacet: (
        name: string,
        opts: { q: string; parentSessionId?: string; parentConfig?: AppConfig },
      ) => Promise<{ ok: true; facetName: string; summary: string }>;
    };

    const result = await parent.runExploreFacet("pool-explore-0", {
      q: "anything triggers failure",
      parentSessionId: sessionId,
      parentConfig: makeParentConfig(),
    });

    // The facet always returns ok:true — errors surface via `summary`.
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("Explore failed");
    expect(result.summary).toContain("internal API error");
    // The recovery hint must be attached so the orchestrator knows to
    // continue with direct read-only tools instead of giving up.
    expect(result.summary).toContain(EXPLORE_FALLBACK_HINT);
    // Sanity check: every fallback tool name appears in the summary.
    for (const tool of ["list", "find", "grep", "read"]) {
      expect(result.summary).toContain(`\`${tool}\``);
    }
  });
});
