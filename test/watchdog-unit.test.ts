import { describe, expect, it } from "vitest";
import {
  DEFAULT_NUDGE_PROMPT,
  decideWatchdog,
  formatStallBody,
  normaliseWatchdogConfig,
  WATCHDOG_LIMITS,
  type WatchdogConfig,
  type WatchdogObservation,
} from "../src/watchdog";

const baseConfig: WatchdogConfig = {
  stallSeconds: 600,
  action: "notify",
  checkCron: "*/5 * * * *",
};

const baseObs: WatchdogObservation = {
  nowEpoch: 10_000,
  status: "running",
  activePromptId: "prompt-1",
  updatedAtEpoch: 9_000,    // 1000s ago — past 600s threshold
  lastFiredForPromptId: null,
};

describe("normaliseWatchdogConfig", () => {
  it("fills in defaults", () => {
    const result = normaliseWatchdogConfig({});
    expect(result.stallSeconds).toBe(WATCHDOG_LIMITS.defaultStallSeconds);
    expect(result.action).toBe("notify");
    expect(result.checkCron).toBe(WATCHDOG_LIMITS.defaultCheckCron);
    expect(result.nudgePrompt).toBeUndefined();
  });

  it("accepts a complete config", () => {
    const result = normaliseWatchdogConfig({
      stallSeconds: 1200,
      action: "nudge",
      checkCron: "* * * * *",
      nudgePrompt: "do better",
    });
    expect(result).toEqual({
      stallSeconds: 1200,
      action: "nudge",
      checkCron: "* * * * *",
      nudgePrompt: "do better",
    });
  });

  it.each([
    [{ stallSeconds: 30 }, /stallSeconds must be between/],
    [{ stallSeconds: 90_000 }, /stallSeconds must be between/],
    [{ stallSeconds: 1.5 }, /must be an integer/],
    [{ action: "explode" }, /action must be one of/],
    [{ checkCron: "every five" }, /cron expression/],
    [{ nudgePrompt: "x".repeat(4001) }, /<= 4000/],
  ])("rejects %j", (raw, error) => {
    expect(() => normaliseWatchdogConfig(raw)).toThrow(error);
  });

  it("rejects non-objects", () => {
    expect(() => normaliseWatchdogConfig(null)).toThrow();
    expect(() => normaliseWatchdogConfig("not config")).toThrow();
    expect(() => normaliseWatchdogConfig(42)).toThrow();
  });
});

describe("decideWatchdog", () => {
  it("fires when stalled past threshold on running prompt", () => {
    const result = decideWatchdog(baseConfig, baseObs);
    expect(result).toEqual({ fire: true, stallSeconds: 1000, activePromptId: "prompt-1" });
  });

  it("returns null when not running", () => {
    expect(decideWatchdog(baseConfig, { ...baseObs, status: "idle" })).toBeNull();
  });

  it("returns null when no active prompt", () => {
    expect(decideWatchdog(baseConfig, { ...baseObs, activePromptId: null })).toBeNull();
  });

  it("returns null when no updated_at recorded", () => {
    expect(decideWatchdog(baseConfig, { ...baseObs, updatedAtEpoch: null })).toBeNull();
  });

  it("returns null when stall is below threshold", () => {
    // Only 500s old vs 600s threshold
    expect(decideWatchdog(baseConfig, { ...baseObs, updatedAtEpoch: 9_500 })).toBeNull();
  });

  it("returns null when already fired for this prompt", () => {
    expect(
      decideWatchdog(baseConfig, { ...baseObs, lastFiredForPromptId: "prompt-1" }),
    ).toBeNull();
  });

  it("fires again when the active prompt id changes", () => {
    // Previous stall was for prompt-1; new prompt is prompt-2 and stuck
    const result = decideWatchdog(baseConfig, {
      ...baseObs,
      activePromptId: "prompt-2",
      lastFiredForPromptId: "prompt-1",
    });
    expect(result).toEqual({ fire: true, stallSeconds: 1000, activePromptId: "prompt-2" });
  });
});

describe("formatStallBody", () => {
  it("renders a human-readable body", () => {
    const body = formatStallBody("sess-abc", { stallSeconds: 720, activePromptId: "p-1" }, "abort");
    expect(body).toContain("Session: sess-abc");
    expect(body).toContain("Prompt: p-1");
    expect(body).toContain("Stalled for: 12 minutes");
    expect(body).toContain("Action: abort");
  });

  it("singularises one minute", () => {
    const body = formatStallBody("s", { stallSeconds: 60, activePromptId: "p" }, "notify");
    expect(body).toContain("Stalled for: 1 minute");
    expect(body).not.toContain("1 minutes");
  });
});

describe("DEFAULT_NUDGE_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(DEFAULT_NUDGE_PROMPT.length).toBeGreaterThan(20);
  });
});
