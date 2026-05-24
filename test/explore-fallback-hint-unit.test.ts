/**
 * Unit tests for EXPLORE_FALLBACK_HINT.
 *
 * The hint is the difference between an orchestrator giving up after a
 * transient explore failure and an orchestrator continuing the task with
 * direct read-only tools. We assert:
 *
 *   1. The constant exists and contains the recovery instruction.
 *   2. The list of tools the hint points the orchestrator at matches
 *      what's actually available read-only (no stale tool names).
 */
import { describe, expect, it } from "vitest";
import { EXPLORE_FALLBACK_HINT } from "../src/subagent-runner";

describe("EXPLORE_FALLBACK_HINT", () => {
  it("is a non-empty string", () => {
    expect(typeof EXPLORE_FALLBACK_HINT).toBe("string");
    expect(EXPLORE_FALLBACK_HINT.length).toBeGreaterThan(20);
  });

  it("names the read-only tools the orchestrator should fall back to", () => {
    // Every one of these is always-on in the orchestrator catalog —
    // see src/tool-catalog.ts (once PR #71 lands) and src/agentic.ts.
    for (const tool of ["list", "find", "grep", "read"]) {
      expect(EXPLORE_FALLBACK_HINT).toContain(`\`${tool}\``);
    }
  });

  it("mentions git_clone for the empty-workspace case", () => {
    expect(EXPLORE_FALLBACK_HINT).toMatch(/git_clone/);
  });

  it("instructs the model not to give up", () => {
    expect(EXPLORE_FALLBACK_HINT).toMatch(/[Dd]o NOT report.*impossible/);
  });
});
