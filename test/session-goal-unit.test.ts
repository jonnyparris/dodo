import { describe, expect, it } from "vitest";
import {
  buildContinuePrompt,
  DEFAULT_GOAL_MAX_TURNS,
  type GoalState,
  HARD_GOAL_MAX_TURNS,
  isTerminalStatus,
  renderGoalSystemPromptSection,
  shouldAutoContinue,
} from "../src/session-goal";

function state(overrides: Partial<GoalState> = {}): GoalState {
  return {
    text: "Investigate logs and fix one bug.",
    status: "active",
    setAt: 1_700_000_000,
    turnsUsed: 0,
    maxTurns: DEFAULT_GOAL_MAX_TURNS,
    summary: null,
    role: null,
    ...overrides,
  };
}

describe("shouldAutoContinue", () => {
  it("is true only for active goals", () => {
    expect(shouldAutoContinue("active")).toBe(true);
    expect(shouldAutoContinue("none")).toBe(false);
    expect(shouldAutoContinue("done")).toBe(false);
    expect(shouldAutoContinue("blocked")).toBe(false);
    expect(shouldAutoContinue("needs_input")).toBe(false);
    expect(shouldAutoContinue("exhausted")).toBe(false);
  });
});

describe("isTerminalStatus", () => {
  it("flags done/blocked/needs_input/exhausted", () => {
    expect(isTerminalStatus("done")).toBe(true);
    expect(isTerminalStatus("blocked")).toBe(true);
    expect(isTerminalStatus("needs_input")).toBe(true);
    expect(isTerminalStatus("exhausted")).toBe(true);
    expect(isTerminalStatus("active")).toBe(false);
    expect(isTerminalStatus("none")).toBe(false);
  });
});

describe("renderGoalSystemPromptSection", () => {
  it("returns null when no goal is set", () => {
    expect(renderGoalSystemPromptSection(state({ status: "none" }))).toBeNull();
    expect(renderGoalSystemPromptSection(state({ status: "active", text: null }))).toBeNull();
  });

  it("includes goal text and turn count when active", () => {
    const section = renderGoalSystemPromptSection(state({ turnsUsed: 3, maxTurns: 10 }));
    expect(section).toContain("Investigate logs and fix one bug.");
    expect(section).toContain("Turn 4 of 10");
    expect(section).toContain("active");
  });

  it("mentions set_goal_status only for active goals", () => {
    const active = renderGoalSystemPromptSection(state({ status: "active" }));
    expect(active).toContain("set_goal_status");
    const done = renderGoalSystemPromptSection(state({ status: "done" }));
    // For a terminal status, the snippet still renders (so the model
    // can see context) but doesn't push the call-set_goal_status nag.
    expect(done).not.toContain("After each turn");
  });
});

describe("buildContinuePrompt", () => {
  it("warns when budget is nearly exhausted", () => {
    const prompt = buildContinuePrompt(state({ turnsUsed: 47, maxTurns: 50 }));
    expect(prompt).toContain("3 turns left");
    expect(prompt).toContain("wrap up");
  });

  it("is a short nudge when budget is healthy", () => {
    const prompt = buildContinuePrompt(state({ turnsUsed: 5, maxTurns: 50 }));
    expect(prompt).not.toContain("turns left");
    expect(prompt.length).toBeLessThan(160);
  });

  it("handles singular vs plural", () => {
    const one = buildContinuePrompt(state({ turnsUsed: 49, maxTurns: 50 }));
    expect(one).toContain("1 turn left");
    const zero = buildContinuePrompt(state({ turnsUsed: 50, maxTurns: 50 }));
    expect(zero).toContain("0 turns left");
  });
});

describe("constants", () => {
  it("default budget is reasonable", () => {
    expect(DEFAULT_GOAL_MAX_TURNS).toBeGreaterThanOrEqual(10);
    expect(DEFAULT_GOAL_MAX_TURNS).toBeLessThanOrEqual(HARD_GOAL_MAX_TURNS);
  });
});
