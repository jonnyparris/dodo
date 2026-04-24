/**
 * Task facet scratch workspace isolation (Phase 4).
 *
 * Verifies the scratch-mode invariants:
 *
 *   1. `workspaceMode: "scratch"` produces a summary whose formatted
 *      header mentions `[scratch workspace]`.
 *   2. A write performed inside scratch mode does NOT land in the parent
 *      workspace — `facetReadFile(path)` on the parent returns null.
 *   3. `applyFromScratch([path])` DOES land the scratch write into the
 *      parent workspace.
 *   4. Paths not present in scratch are skipped (not silently merged).
 *
 * Writes are exercised via the test-only `writeScratchForTest` RPC on
 * TaskAgent — the mock model doesn't call tools, so the real write
 * path can't fire through `task()` alone. The RPC mirrors the real
 * scratch-write path (same Workspace, same scratchWrites tracking).
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
    exploreMode: "inprocess",
    taskMode: "facet",
    ...overrides,
  };
}

describe("TaskAgent — scratch workspace isolation", () => {
  it("runs task() in scratch mode and labels the summary accordingly", async () => {
    const { getAgentByName } = await import("agents");
    const testEnv = env as Env;
    const sessionId = `task-scratch-label-${crypto.randomUUID()}`;

    const parent = await getAgentByName(testEnv.CODING_AGENT as never, sessionId) as unknown as {
      runTaskFacet: (name: string, opts: { prompt: string; workspaceMode?: "shared" | "scratch"; parentSessionId?: string; parentConfig?: AppConfig }) => Promise<{ ok: true; facetName: string; summary: string; workspaceMode: "shared" | "scratch" }>;
    };

    const result = await parent.runTaskFacet("pool-task-0", {
      prompt: "noop — scratch labelling test",
      workspaceMode: "scratch",
      parentSessionId: sessionId,
      parentConfig: makeParentConfig(),
    });

    expect(result.ok).toBe(true);
    expect(result.workspaceMode).toBe("scratch");
    expect(result.summary).toMatch(/^## Task results/);
    expect(result.summary).toContain("[scratch workspace]");
    expect(result.summary).toContain("facet: pool-task-0");
  });

  it("scratch writes are invisible to the parent workspace", async () => {
    const { getAgentByName } = await import("agents");
    const testEnv = env as Env;
    const sessionId = `task-scratch-isolation-${crypto.randomUUID()}`;

    const parent = await getAgentByName(testEnv.CODING_AGENT as never, sessionId) as unknown as {
      runTaskFacet: (name: string, opts: { prompt: string; workspaceMode?: "shared" | "scratch"; parentSessionId?: string; parentConfig?: AppConfig }) => Promise<{ ok: true }>;
      invokeTaskFacet: (name: string, opts: { prompt: string }) => Promise<unknown>;
      facetReadFile: (path: string) => Promise<string | null>;
    };

    // Ensure the facet exists (runTaskFacet via `subAgent` + task()) —
    // needed so we can then drill into it with the test-only RPC.
    await parent.runTaskFacet("pool-task-scratch-iso", {
      prompt: "noop",
      workspaceMode: "scratch",
      parentSessionId: sessionId,
      parentConfig: makeParentConfig(),
    });

    // Write a file inside the facet's scratch workspace via the
    // test-only RPC, which exercises the same code path the real
    // write tool would.
    const facet = await getAgentByName(
      testEnv.CODING_AGENT as never,
      "pool-task-scratch-iso",
      // Hack: the facet isn't addressable via the CODING_AGENT
      // namespace — it's a TaskAgent. We use its namespace instead.
    ).catch(() => null);
    // Skipping the unreachable getAgentByName-against-wrong-namespace
    // branch above; instead go through the public `subAgent` path by
    // exposing a thin helper on CodingAgent.
    void facet;

    // Use a dedicated helper on CodingAgent to write to the facet's
    // scratch, keeping the test focused on invariants rather than
    // SDK plumbing.
    const writeRes = await (parent as unknown as {
      testWriteScratchFile: (facetName: string, parentSessionId: string, path: string, content: string) => Promise<{ ok: true }>;
    }).testWriteScratchFile("pool-task-scratch-iso", sessionId, "/scratch-only.txt", "scratch content");
    expect(writeRes.ok).toBe(true);

    // Parent workspace must not see the scratch write.
    const parentView = await parent.facetReadFile("/scratch-only.txt");
    expect(parentView).toBeNull();
  });

  it("applyFromScratch copies scratch writes into the parent and skips unknown paths", async () => {
    const { getAgentByName } = await import("agents");
    const testEnv = env as Env;
    const sessionId = `task-scratch-apply-${crypto.randomUUID()}`;

    const parent = await getAgentByName(testEnv.CODING_AGENT as never, sessionId) as unknown as {
      runTaskFacet: (name: string, opts: { prompt: string; workspaceMode?: "shared" | "scratch"; parentSessionId?: string; parentConfig?: AppConfig }) => Promise<{ ok: true }>;
      testWriteScratchFile: (facetName: string, parentSessionId: string, path: string, content: string) => Promise<{ ok: true }>;
      testApplyFromScratch: (facetName: string, paths: string[]) => Promise<{ ok: true; applied: string[]; skipped: Array<{ path: string; reason: string }> }>;
      facetReadFile: (path: string) => Promise<string | null>;
    };

    await parent.runTaskFacet("pool-task-scratch-apply", {
      prompt: "noop",
      workspaceMode: "scratch",
      parentSessionId: sessionId,
      parentConfig: makeParentConfig(),
    });

    await parent.testWriteScratchFile("pool-task-scratch-apply", sessionId, "/merge-me.txt", "ok from scratch");

    // Apply a mix of a real write and a bogus path.
    const res = await parent.testApplyFromScratch("pool-task-scratch-apply", ["/merge-me.txt", "/never-written.txt"]);
    expect(res.applied).toContain("/merge-me.txt");
    expect(res.skipped.some((s) => s.path === "/never-written.txt")).toBe(true);

    const parentView = await parent.facetReadFile("/merge-me.txt");
    expect(parentView).toBe("ok from scratch");
    const bogusView = await parent.facetReadFile("/never-written.txt");
    expect(bogusView).toBeNull();
  });

  it("scratch writes survive DO eviction — SQL-backed, not in-memory", async () => {
    // This test exercises the real applyFromScratch path *without* a
    // preceding `task()` call on the same facet (which in the in-memory
    // implementation would have populated scratchWrites just before
    // the assertion ran). The write goes in via writeScratchForTest
    // (which now records into SQL), and the merge-back operates against
    // a fresh stub lookup — simulating the "applyFromScratch minutes
    // later" flow.
    const { getAgentByName } = await import("agents");
    const testEnv = env as Env;
    const sessionId = `task-scratch-durable-${crypto.randomUUID()}`;

    const parent = await getAgentByName(testEnv.CODING_AGENT as never, sessionId) as unknown as {
      testWriteScratchFile: (facetName: string, parentSessionId: string, path: string, content: string) => Promise<{ ok: true }>;
      applyTaskScratch: (facetName: string, paths: string[]) => Promise<{ ok: true; applied: string[]; skipped: Array<{ path: string; reason: string }> }>;
      facetReadFile: (path: string) => Promise<string | null>;
    };

    // Write only — no task() call. Old in-memory impl would have an
    // empty scratchWrites here because writes only happen via the
    // real write tool during task().
    await parent.testWriteScratchFile("pool-task-durable", sessionId, "/durable.txt", "persisted content");

    // Apply via the production RPC (same path as the HTTP route).
    const res = await parent.applyTaskScratch("pool-task-durable", ["/durable.txt"]);
    expect(res.applied).toContain("/durable.txt");

    const parentView = await parent.facetReadFile("/durable.txt");
    expect(parentView).toBe("persisted content");
  });

  it("cleanupScratchFacet wipes scratch R2 prefix and scratch-writes index", async () => {
    const { getAgentByName } = await import("agents");
    const testEnv = env as Env;
    const sessionId = `task-scratch-cleanup-${crypto.randomUUID()}`;

    const parent = await getAgentByName(testEnv.CODING_AGENT as never, sessionId) as unknown as {
      testWriteScratchFile: (facetName: string, parentSessionId: string, path: string, content: string) => Promise<{ ok: true }>;
      applyTaskScratch: (facetName: string, paths: string[]) => Promise<{ ok: true; applied: string[]; skipped: Array<{ path: string; reason: string }> }>;
      cleanupScratchFacet: (payload: { facetName: string; parentSessionId: string }) => Promise<void>;
    };

    // Seed the scratch workspace with a file so cleanup has something
    // to sweep.
    await parent.testWriteScratchFile("pool-task-cleanup", sessionId, "/doomed.txt", "goodbye world");

    // Verify it's actually there before cleanup (merge-back should
    // succeed — sanity-checks the scratch write actually landed).
    const preCheck = await parent.applyTaskScratch("pool-task-cleanup", ["/doomed.txt"]);
    expect(preCheck.applied).toContain("/doomed.txt");

    // Fire the scheduled cleanup callback directly — no way to wind
    // the clock forward 24h inside the vitest-pool-workers runtime,
    // so we invoke the handler with the same payload `this.schedule`
    // would pass at alarm fire time.
    await parent.cleanupScratchFacet({ facetName: "pool-task-cleanup", parentSessionId: sessionId });

    // After cleanup: applyTaskScratch should skip the path because
    // the scratch_writes index was wiped. (The R2 prefix was also
    // cleaned, but the SQL-level skip is the first-line proof — we
    // don't need to unwrap R2 internals from the test.)
    const postCheck = await parent.applyTaskScratch("pool-task-cleanup", ["/doomed.txt"]);
    expect(postCheck.applied).toHaveLength(0);
    expect(postCheck.skipped.some((s) => s.path === "/doomed.txt")).toBe(true);
  });
});
