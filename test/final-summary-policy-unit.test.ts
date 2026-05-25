/**
 * Unit tests for the final-summary turn decision logic.
 *
 * The behaviour grid:
 *
 *  - abort signal tripped → always false (user asked to stop)
 *  - exit reason isn't a stuck signal → false (natural finish or
 *    cost-runaway — no point spending more tokens)
 *  - exit reason is stuck AND model already wrote enough text → false
 *  - exit reason is stuck AND model wrote nothing meaningful → true
 *  - harness's own [Stopped: ...] / [Compacting ...] notices don't
 *    count as "model wrote text" — they get scrubbed first
 */
import { describe, expect, it } from "vitest";
import {
  shouldRunFinalSummary,
  stripHarnessNotices,
  STUCK_EXIT_REASONS,
} from "../src/final-summary-policy";

describe("stripHarnessNotices", () => {
  it("removes [Stopped: ...] notices", () => {
    const input = "Hello world.\n\n[Stopped: codemode called 10 times in a row]\n\nDone.";
    expect(stripHarnessNotices(input)).toBe("Hello world.\n\n\n\nDone.");
  });

  it("removes [Compacting context ...] markers", () => {
    const input = "Step 1.\n[Compacting context and continuing... (phase 2)]\nStep 2.";
    expect(stripHarnessNotices(input)).toBe("Step 1.\n\nStep 2.");
  });

  it("removes [Loop detected ...] markers", () => {
    const input = "[Loop detected — summarizing progress so far]\nFinal output.";
    expect(stripHarnessNotices(input)).toBe("Final output.");
  });

  it("trims whitespace from the result", () => {
    expect(stripHarnessNotices("\n\n  [Stopped: x]\n\n  ")).toBe("");
  });

  it("returns plain text unchanged", () => {
    const input = "I analyzed the codebase and found three bugs.";
    expect(stripHarnessNotices(input)).toBe(input);
  });
});

describe("STUCK_EXIT_REASONS", () => {
  it("contains exactly the loop-detection exit reasons", () => {
    expect(STUCK_EXIT_REASONS.has("doom-loop")).toBe(true);
    expect(STUCK_EXIT_REASONS.has("no-text-loop")).toBe(true);
    expect(STUCK_EXIT_REASONS.has("text-loop")).toBe(true);
    // Not stuck — model decided to stop or hit a resource limit.
    expect(STUCK_EXIT_REASONS.has("natural")).toBe(false);
    expect(STUCK_EXIT_REASONS.has("step-limit")).toBe(false);
    expect(STUCK_EXIT_REASONS.has("budget-limit")).toBe(false);
    expect(STUCK_EXIT_REASONS.has("abort")).toBe(false);
  });
});

describe("shouldRunFinalSummary", () => {
  const base = {
    exitReason: "doom-loop" as const,
    signalAborted: false,
    turnText: "",
  };

  it("returns true on a stuck exit when the model wrote nothing", () => {
    expect(shouldRunFinalSummary(base)).toBe(true);
  });

  it("returns true when the model only emitted a harness stop notice", () => {
    expect(
      shouldRunFinalSummary({
        ...base,
        turnText: "\n\n[Stopped: codemode called 10 times in a row]\n\n",
      }),
    ).toBe(true);
  });

  it("returns false when the model wrote a substantive conclusion", () => {
    const realAnswer =
      "I analyzed src/coding-agent.ts and found the auto-nudge feature " +
      "is implemented via the watchdog system. The runWatchdogCheck method " +
      "fires on a cron schedule and dispatches a nudge prompt when a session " +
      "has been stalled past the configured threshold. I verified the unit " +
      "tests cover the decision logic comprehensively.";
    expect(
      shouldRunFinalSummary({
        ...base,
        turnText: realAnswer,
      }),
    ).toBe(false);
  });

  it("returns false when the abort signal is tripped (user asked to stop)", () => {
    expect(
      shouldRunFinalSummary({
        ...base,
        signalAborted: true,
        turnText: "",
      }),
    ).toBe(false);
  });

  it("returns false on a natural exit (model already wrapped up)", () => {
    expect(
      shouldRunFinalSummary({
        ...base,
        exitReason: "natural",
      }),
    ).toBe(false);
  });

  it("returns false on a step-limit exit (auto-continuation handles it)", () => {
    expect(
      shouldRunFinalSummary({
        ...base,
        exitReason: "step-limit",
      }),
    ).toBe(false);
  });

  it("returns false on a budget-limit exit (cost-runaway, no point spending more)", () => {
    expect(
      shouldRunFinalSummary({
        ...base,
        exitReason: "budget-limit",
      }),
    ).toBe(false);
  });

  it("returns false on an abort exit", () => {
    expect(
      shouldRunFinalSummary({
        ...base,
        exitReason: "abort",
      }),
    ).toBe(false);
  });

  it("respects a custom minExistingTextChars threshold", () => {
    // 50 chars — below the default 200 threshold, above a custom 20.
    const shortAnswer = "Done. Found the bug in line 42. Easy fix.";
    expect(
      shouldRunFinalSummary({
        ...base,
        turnText: shortAnswer,
        minExistingTextChars: 200,
      }),
    ).toBe(true);
    expect(
      shouldRunFinalSummary({
        ...base,
        turnText: shortAnswer,
        minExistingTextChars: 20,
      }),
    ).toBe(false);
  });

  it("scrubs harness notices BEFORE measuring length", () => {
    // The harness stop notice is ~60 chars; the real text is ~30.
    // With default 200 minimum, both should fail to clear. We're
    // confirming the scrubber runs (i.e. the notice doesn't get
    // counted).
    const mixed =
      "Found it.\n\n[Stopped: codemode called 10 times in a row without producing a text answer — write your conclusion from what you have so far.]";
    const stripped = stripHarnessNotices(mixed);
    expect(stripped.length).toBeLessThan(mixed.length);
    // With min=20, stripped="Found it." (9 chars) is still below
    // threshold → true.
    expect(
      shouldRunFinalSummary({
        ...base,
        turnText: mixed,
        minExistingTextChars: 20,
      }),
    ).toBe(true);
    // With min=5, stripped clears → false.
    expect(
      shouldRunFinalSummary({
        ...base,
        turnText: mixed,
        minExistingTextChars: 5,
      }),
    ).toBe(false);
  });
});
