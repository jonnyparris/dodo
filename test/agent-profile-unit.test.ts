/**
 * Drift test for agent profiles.
 *
 * The two profile constants (`EXPLORE_PROFILE`, `TASK_PROFILE`) are the
 * single source of truth for each subagent's prompt, step count,
 * timeouts, and model resolution. Both the in-process runner and the
 * facet DO classes consume them — if a field drifts, both ends of the
 * subagent contract drift together, and the runtime invariants this
 * file asserts catch it.
 *
 * Equivalent role to `test/tool-catalog-unit.test.ts` for the tool
 * catalog: lightweight static assertions that fail the build when a
 * profile gets edited in a way that violates a documented invariant.
 */
import { describe, expect, it } from "vitest";
import {
  EXPLORE_PROFILE,
  TASK_PROFILE,
  getSubagentFamilyModel,
  resolveProfileModel,
} from "../src/agent-profile";

describe("EXPLORE_PROFILE", () => {
  it("declares the explore identity", () => {
    expect(EXPLORE_PROFILE.kind).toBe("explore");
    expect(EXPLORE_PROFILE.name).toBe("Explore");
  });

  it("ships a non-empty system prompt that references its own step budget", () => {
    // The prompt embeds `${EXPLORE_MAX_STEPS}` so editing one field
    // without the other immediately produces a wrong instruction
    // ("Reserve the last 2 steps for your summary" off-by-one). This
    // catches both directions of the drift.
    expect(EXPLORE_PROFILE.systemPrompt.length).toBeGreaterThan(100);
    expect(EXPLORE_PROFILE.systemPrompt).toContain(
      `budget of ${EXPLORE_PROFILE.maxSteps} steps`,
    );
    expect(EXPLORE_PROFILE.systemPrompt).toContain(
      `at step ${EXPLORE_PROFILE.maxSteps - 2}`,
    );
  });

  it("ships a fallback hint pointing at the read-only tools", () => {
    expect(typeof EXPLORE_PROFILE.fallbackHint).toBe("string");
    const hint = EXPLORE_PROFILE.fallbackHint as string;
    for (const tool of ["list", "find", "grep", "read"]) {
      expect(hint).toContain(`\`${tool}\``);
    }
    expect(hint).toMatch(/git_clone/);
    expect(hint).toMatch(/[Dd]o NOT report.*impossible/);
  });

  it("caps wall-clock time below the parent's turn budget", () => {
    // Explore runs in-process by default. A timeout larger than the
    // parent's typical turn budget would defeat the whole point of the
    // tool — bounded, fast searches.
    expect(EXPLORE_PROFILE.timeoutMs).toBeLessThanOrEqual(120_000);
  });
});

describe("TASK_PROFILE", () => {
  it("declares the task identity", () => {
    expect(TASK_PROFILE.kind).toBe("task");
    expect(TASK_PROFILE.name).toBe("Task");
  });

  it("ships a non-empty system prompt that references its own step budget", () => {
    expect(TASK_PROFILE.systemPrompt.length).toBeGreaterThan(100);
    expect(TASK_PROFILE.systemPrompt).toContain(
      `budget of ${TASK_PROFILE.maxSteps} steps`,
    );
    expect(TASK_PROFILE.systemPrompt).toContain(
      `at step ${TASK_PROFILE.maxSteps - 2}`,
    );
  });

  it("does not declare a fallback hint", () => {
    // Task writes — there's no clean fallback the orchestrator could
    // substitute. The plan calls this out explicitly: only explore
    // gets a hint.
    expect(TASK_PROFILE.fallbackHint).toBeUndefined();
  });

  it("declares a facet timeout strictly larger than the inprocess timeout", () => {
    // The facet DO exists to escape the parent's turn budget — if the
    // facet timeout were equal or shorter, moving task into a facet
    // would buy nothing.
    expect(TASK_PROFILE.facetTimeoutMs).toBeDefined();
    expect(TASK_PROFILE.facetTimeoutMs as number).toBeGreaterThan(
      TASK_PROFILE.timeoutMs,
    );
  });
});

describe("getSubagentFamilyModel", () => {
  it("routes Anthropic main models to Haiku 4.5", () => {
    expect(getSubagentFamilyModel("anthropic/claude-sonnet-4")).toBe(
      "anthropic/claude-haiku-4-5",
    );
    expect(getSubagentFamilyModel("anthropic/claude-opus-4")).toBe(
      "anthropic/claude-haiku-4-5",
    );
  });

  it("routes OpenAI main models to gpt-4.1-mini", () => {
    expect(getSubagentFamilyModel("openai/gpt-5")).toBe("openai/gpt-4.1-mini");
  });

  it("falls back to the main model id when no family prefix matches", () => {
    expect(getSubagentFamilyModel("@cf/moonshotai/kimi-k2.6")).toBe(
      "@cf/moonshotai/kimi-k2.6",
    );
    expect(getSubagentFamilyModel("mystery/weird-model")).toBe(
      "mystery/weird-model",
    );
  });
});

describe("resolveProfileModel", () => {
  it("prefers per-call args over session default and family heuristic", () => {
    const model = resolveProfileModel(
      EXPLORE_PROFILE,
      { model: "custom/per-call" },
      "session-default/model",
      "anthropic/claude-sonnet-4",
    );
    expect(model).toBe("custom/per-call");
  });

  it("falls back to session default when args have no model", () => {
    const model = resolveProfileModel(
      EXPLORE_PROFILE,
      {},
      "session-default/model",
      "anthropic/claude-sonnet-4",
    );
    expect(model).toBe("session-default/model");
  });

  it("falls back to the profile's family resolver when neither args nor session default supplies one", () => {
    const model = resolveProfileModel(
      EXPLORE_PROFILE,
      {},
      undefined,
      "anthropic/claude-sonnet-4",
    );
    expect(model).toBe("anthropic/claude-haiku-4-5");
  });

  it("trims whitespace on per-call args before checking presence", () => {
    const model = resolveProfileModel(
      EXPLORE_PROFILE,
      { model: "   " },
      "session-default/model",
      "anthropic/claude-sonnet-4",
    );
    // Whitespace-only args fall through to the session default.
    expect(model).toBe("session-default/model");
  });
});
