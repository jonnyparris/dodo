import { describe, expect, it } from "vitest";
import { evaluateSession } from "../src/watchdog-policy";
import type { WatchdogConfig } from "../src/watchdog";

const baseConfig: WatchdogConfig = {
  stallSeconds: 600,
  action: "notify",
  checkCron: "*/5 * * * *",
};

describe("evaluateSession", () => {
  it("returns healthy when session is idle", () => {
    const result = evaluateSession(
      {
        status: "idle",
        activePromptId: null,
        lastActivityAt: 1_000,
        lastFiredForPromptId: null,
        config: baseConfig,
      },
      10_000 * 1000,
    );
    expect(result.kind).toBe("healthy");
  });

  it("returns healthy when no active prompt", () => {
    const result = evaluateSession(
      {
        status: "running",
        activePromptId: null,
        lastActivityAt: 1_000,
        lastFiredForPromptId: null,
        config: baseConfig,
      },
      10_000 * 1000,
    );
    expect(result.kind).toBe("healthy");
  });

  it("returns healthy when stall is below threshold", () => {
    const result = evaluateSession(
      {
        status: "running",
        activePromptId: "prompt-1",
        lastActivityAt: 9_500, // 500s ago, below 600s threshold
        lastFiredForPromptId: null,
        config: baseConfig,
      },
      10_000 * 1000,
    );
    expect(result.kind).toBe("healthy");
  });

  it("returns stalled when threshold exceeded", () => {
    const result = evaluateSession(
      {
        status: "running",
        activePromptId: "prompt-1",
        lastActivityAt: 9_000, // 1000s ago, above 600s threshold
        lastFiredForPromptId: null,
        config: baseConfig,
      },
      10_000 * 1000,
    );
    expect(result.kind).toBe("stalled");
    expect((result as { stallSeconds: number }).stallSeconds).toBe(1000);
    expect((result as { recommend: string }).recommend).toBe("wait"); // notify maps to wait
  });

  it("returns healthy when already fired for this prompt", () => {
    const result = evaluateSession(
      {
        status: "running",
        activePromptId: "prompt-1",
        lastActivityAt: 1_000,
        lastFiredForPromptId: "prompt-1",
        config: baseConfig,
      },
      10_000 * 1000,
    );
    expect(result.kind).toBe("healthy");
  });

  it("recommends abort when config.action is abort", () => {
    const result = evaluateSession(
      {
        status: "running",
        activePromptId: "prompt-1",
        lastActivityAt: 1_000,
        lastFiredForPromptId: null,
        config: { ...baseConfig, action: "abort" },
      },
      10_000 * 1000,
    );
    expect(result.kind).toBe("stalled");
    expect((result as { recommend: string }).recommend).toBe("abort");
  });

  it("recommends nudge when config.action is nudge", () => {
    const result = evaluateSession(
      {
        status: "running",
        activePromptId: "prompt-1",
        lastActivityAt: 1_000,
        lastFiredForPromptId: null,
        config: { ...baseConfig, action: "nudge" },
      },
      10_000 * 1000,
    );
    expect(result.kind).toBe("stalled");
    expect((result as { recommend: string }).recommend).toBe("nudge");
  });

  it("fires again when active prompt changes", () => {
    const result = evaluateSession(
      {
        status: "running",
        activePromptId: "prompt-2",
        lastActivityAt: 1_000,
        lastFiredForPromptId: "prompt-1",
        config: baseConfig,
      },
      10_000 * 1000,
    );
    expect(result.kind).toBe("stalled");
    expect((result as { activePromptId: string }).activePromptId).toBe("prompt-2");
  });
});
