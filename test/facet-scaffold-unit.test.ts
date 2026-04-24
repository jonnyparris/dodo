/**
 * Facet scaffold smoke test.
 *
 * Verifies the SDK plumbing that underlies every other facet test:
 *
 *   1. The `"experimental"` compat flag is on — without it,
 *      `this.subAgent(ExploreAgent, "…")` throws.
 *   2. The `new_sqlite_classes` migration registered both facet classes
 *      so they can be spawned — getAgentByName → subAgent → query
 *      round-trips successfully.
 *   3. The same pooled name returns a reused facet (by-name semantics
 *      are a core contract).
 *
 * This used to exercise a placeholder path on `invokeExploreFacet` /
 * `invokeTaskFacet`. Those are gone — the scaffold test now drives
 * the real `runExploreFacet` / `runTaskFacet` path, with the model
 * mocked via `helpers/agentic-mock`. The contract surface is:
 * "can we spawn a facet and get a well-formed result back?"
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
    taskMode: "facet",
    ...overrides,
  };
}

describe("facet scaffold", () => {
  it("CodingAgent can spawn ExploreAgent facet and round-trip query()", async () => {
    const { getAgentByName } = await import("agents");
    const testEnv = env as Env;
    const sessionId = `scaffold-explore-${crypto.randomUUID()}`;
    const parent = await getAgentByName(testEnv.CODING_AGENT as never, sessionId) as unknown as {
      runExploreFacet: (name: string, opts: { q: string; parentSessionId?: string; parentConfig?: AppConfig }) => Promise<{ ok: true; facetName: string; summary: string; tokenInput: number; tokenOutput: number }>;
    };

    const result = await parent.runExploreFacet("pool-explore-0", {
      q: "hi",
      parentSessionId: sessionId,
      parentConfig: makeParentConfig(),
    });

    expect(result.ok).toBe(true);
    expect(result.facetName).toBe("pool-explore-0");
    expect(result.summary).toMatch(/^## Explore results/);
  });

  it("CodingAgent can spawn TaskAgent facet and round-trip task()", async () => {
    const { getAgentByName } = await import("agents");
    const testEnv = env as Env;
    const sessionId = `scaffold-task-${crypto.randomUUID()}`;
    const parent = await getAgentByName(testEnv.CODING_AGENT as never, sessionId) as unknown as {
      runTaskFacet: (name: string, opts: { prompt: string; workspaceMode?: "shared" | "scratch"; parentSessionId?: string; parentConfig?: AppConfig }) => Promise<{ ok: true; facetName: string; summary: string; workspaceMode: "shared" | "scratch" }>;
    };

    const result = await parent.runTaskFacet("pool-task-0", {
      prompt: "noop",
      workspaceMode: "shared",
      parentSessionId: sessionId,
      parentConfig: makeParentConfig(),
    });

    expect(result.ok).toBe(true);
    expect(result.facetName).toBe("pool-task-0");
    expect(result.workspaceMode).toBe("shared");
    expect(result.summary).toMatch(/^## Task results/);
  });

  it("the same pooled name returns a reused facet (by-name semantics)", async () => {
    const { getAgentByName } = await import("agents");
    const testEnv = env as Env;
    const sessionId = `scaffold-reuse-${crypto.randomUUID()}`;
    const parent = await getAgentByName(testEnv.CODING_AGENT as never, sessionId) as unknown as {
      runExploreFacet: (name: string, opts: { q: string; parentSessionId?: string; parentConfig?: AppConfig }) => Promise<{ ok: true; facetName: string; summary: string }>;
    };

    const first = await parent.runExploreFacet("pool-explore-0", {
      q: "first", parentSessionId: sessionId, parentConfig: makeParentConfig(),
    });
    const second = await parent.runExploreFacet("pool-explore-0", {
      q: "second", parentSessionId: sessionId, parentConfig: makeParentConfig(),
    });

    expect(first.facetName).toBe("pool-explore-0");
    expect(second.facetName).toBe("pool-explore-0");
    // Different queries produce different summaries (the mock model
    // repeats the user prompt back, so we can tell them apart).
    expect(first.summary).toContain("first");
    expect(second.summary).toContain("second");
  });
});
