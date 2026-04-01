/**
 * Pure unit tests for onboarding state machine.
 * Extracted from onboarding.test.ts to avoid importing the main worker module,
 * which triggers the @cloudflare/think → ai ESM re-export chain that workerd
 * can't resolve. See: https://github.com/cloudflare/workers-sdk/issues/13191
 */
import { describe, expect, it } from "vitest";
import { advanceStep, canSkipStep, getInitialState, getNextStep } from "../src/onboarding";

describe("state machine: getNextStep()", () => {
  it("welcome → gateway", () => {
    expect(getNextStep("welcome", false)).toBe("gateway");
  });

  it("gateway → passkey", () => {
    expect(getNextStep("gateway", false)).toBe("passkey");
  });

  it("passkey → secrets", () => {
    expect(getNextStep("passkey", false)).toBe("secrets");
  });

  it("secrets → memory", () => {
    expect(getNextStep("secrets", false)).toBe("memory");
  });

  it("memory → integrations", () => {
    expect(getNextStep("memory", false)).toBe("integrations");
  });

  it("integrations → complete", () => {
    expect(getNextStep("integrations", false)).toBe("complete");
  });

  it("complete → complete (terminal)", () => {
    expect(getNextStep("complete", false)).toBe("complete");
  });
});

describe("state machine: canSkipStep()", () => {
  it("welcome is always skippable", () => {
    expect(canSkipStep("welcome", false)).toBe(true);
  });

  it("passkey is skippable only with key envelope", () => {
    expect(canSkipStep("passkey", false)).toBe(false);
    expect(canSkipStep("passkey", true)).toBe(true);
  });

  it("secrets is skippable", () => {
    expect(canSkipStep("secrets", false)).toBe(true);
  });

  it("memory is skippable", () => {
    expect(canSkipStep("memory", false)).toBe(true);
  });

  it("integrations is skippable", () => {
    expect(canSkipStep("integrations", false)).toBe(true);
  });

  it("complete is not skippable", () => {
    expect(canSkipStep("complete", false)).toBe(false);
  });
});

describe("state machine: getInitialState()", () => {
  it("returns welcome step with no completed steps", () => {
    const state = getInitialState();
    expect(state.currentStep).toBe("welcome");
    expect(state.completedSteps).toEqual([]);
    expect(state.startedAt).toBeTruthy();
    expect(state.completedAt).toBeNull();
  });
});

describe("state machine: advanceStep()", () => {
  it("advances from welcome to gateway", () => {
    const state = getInitialState();
    const next = advanceStep(state, "welcome", false, false);
    expect(next.currentStep).toBe("gateway");
    expect(next.completedSteps).toContain("welcome");
    expect(next.completedAt).toBeNull();
  });

  it("throws when step does not match current", () => {
    const state = getInitialState();
    expect(() => advanceStep(state, "passkey", false, false)).toThrow("current step is 'welcome'");
  });

  it("throws when skipping passkey without key envelope", () => {
    const state = { ...getInitialState(), currentStep: "passkey" as const, completedSteps: ["welcome" as const] };
    expect(() => advanceStep(state, "passkey", true, false)).toThrow("cannot be skipped");
  });

  it("allows skipping passkey with key envelope", () => {
    const state = { ...getInitialState(), currentStep: "passkey" as const, completedSteps: ["welcome" as const] };
    const next = advanceStep(state, "passkey", true, true);
    expect(next.currentStep).toBe("secrets");
    expect(next.completedSteps).toContain("passkey");
  });

  it("advances through all steps to complete", () => {
    let state = getInitialState();
    state = advanceStep(state, "welcome", false, false);
    state = advanceStep(state, "gateway", false, false);
    state = advanceStep(state, "passkey", false, true);
    state = advanceStep(state, "secrets", false, false);
    state = advanceStep(state, "memory", false, false);
    state = advanceStep(state, "integrations", false, false);
    expect(state.currentStep).toBe("complete");
    expect(state.completedAt).toBeTruthy();
    expect(state.completedSteps).toContain("complete");
  });

  it("returns same state when already complete", () => {
    let state = getInitialState();
    state = advanceStep(state, "welcome", false, false);
    state = advanceStep(state, "gateway", false, false);
    state = advanceStep(state, "passkey", true, true);
    state = advanceStep(state, "secrets", true, false);
    state = advanceStep(state, "memory", true, false);
    state = advanceStep(state, "integrations", true, false);
    expect(state.currentStep).toBe("complete");
    const again = advanceStep(state, "complete", false, false);
    expect(again).toEqual(state);
  });
});
