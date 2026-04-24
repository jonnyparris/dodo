/**
 * Facet scaffold smoke test (Phase 1).
 *
 * Verifies:
 *   1. The Agents SDK accepts ExploreAgent + TaskAgent as facet classes
 *      (requires the `"experimental"` compat flag on wrangler.test.jsonc).
 *   2. A CodingAgent can spawn a named facet via `this.subAgent(...)`.
 *   3. The placeholder RPC round-trips and returns the expected shape.
 *
 * Phase 2+ will replace the placeholder bodies with real generateText()
 * calls; this test should continue to pass because the RPC contract is
 * stable — only the internal behaviour changes.
 */
import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../src/types";

vi.mock("../src/executor", () => ({
  runSandboxedCode: vi.fn().mockResolvedValue({ logs: [], result: null }),
}));
vi.mock("../src/agentic", async () => await import("./helpers/agentic-mock"));
vi.mock("../src/notify", () => ({
  sendNotification: vi.fn(),
}));

describe("facet scaffold", () => {
  it("CodingAgent can spawn ExploreAgent facet and round-trip query()", async () => {
    const { getAgentByName } = await import("agents");
    const testEnv = env as Env;
    const sessionId = `scaffold-explore-${crypto.randomUUID()}`;
    const agent = await getAgentByName(testEnv.CODING_AGENT as never, sessionId) as unknown as {
      invokeExploreFacet: (name: string, opts: { q: string; scope?: string; model?: string }) => Promise<{ ok: true; facetName: string; summary: string }>;
    };

    const result = await agent.invokeExploreFacet("pool-explore-0", { q: "hi" });

    // Placeholder path — no parentSessionId / parentConfig provided, so
    // the facet returns its canned placeholder summary instead of
    // trying to run a real generateText call.
    expect(result.ok).toBe(true);
    expect(result.facetName).toBe("pool-explore-0");
    expect(result.summary).toContain("placeholder");
  });

  it("CodingAgent can spawn TaskAgent facet and round-trip task()", async () => {
    const { getAgentByName } = await import("agents");
    const testEnv = env as Env;
    const sessionId = `scaffold-task-${crypto.randomUUID()}`;
    const agent = await getAgentByName(testEnv.CODING_AGENT as never, sessionId) as unknown as {
      invokeTaskFacet: (name: string, opts: { prompt: string; scope?: string; model?: string; workspaceMode?: "shared" | "scratch" }) => Promise<{ ok: true; facetName: string; summary: string; workspaceMode: "shared" | "scratch" }>;
    };

    const result = await agent.invokeTaskFacet("pool-task-0", {
      prompt: "noop",
      workspaceMode: "shared",
    });

    // Placeholder path: invokeTaskFacet is the raw passthrough and the
    // test calls it without parentSessionId / parentConfig, so the
    // facet returns its canned placeholder summary without touching
    // the model.
    expect(result.ok).toBe(true);
    expect(result.facetName).toBe("pool-task-0");
    expect(result.workspaceMode).toBe("shared");
    expect(result.summary).toContain("placeholder");
  });

  it("the same pooled name returns a reused facet (by-name semantics)", async () => {
    const { getAgentByName } = await import("agents");
    const testEnv = env as Env;
    const sessionId = `scaffold-reuse-${crypto.randomUUID()}`;
    const agent = await getAgentByName(testEnv.CODING_AGENT as never, sessionId) as unknown as {
      invokeExploreFacet: (name: string, opts: { q: string }) => Promise<{ ok: true; facetName: string; summary: string }>;
    };

    const first = await agent.invokeExploreFacet("pool-explore-0", { q: "first" });
    const second = await agent.invokeExploreFacet("pool-explore-0", { q: "second" });

    expect(first.facetName).toBe("pool-explore-0");
    expect(second.facetName).toBe("pool-explore-0");
  });
});
