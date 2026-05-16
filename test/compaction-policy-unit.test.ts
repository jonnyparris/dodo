import { describe, expect, it } from "vitest";
import { shouldCompact, pickCutoff } from "../src/compaction-policy";

describe("shouldCompact", () => {
  it("returns false when threshold is not reached", () => {
    const result = shouldCompact({
      messageCount: 10,
      realMessageCount: 10,
      estimatedTokens: 100,
      modelContextWindow: 10_000,
      thresholdRatio: 0.6,
    });
    expect(result).toBe(false);
  });

  it("returns true when threshold is reached", () => {
    const result = shouldCompact({
      messageCount: 10,
      realMessageCount: 10,
      estimatedTokens: 5_000,
      modelContextWindow: 10_000,
      thresholdRatio: 0.6,
    });
    expect(result).toBe(true);
  });

  it("returns false when message count is below minimum", () => {
    const result = shouldCompact({
      messageCount: 3,
      realMessageCount: 3,
      estimatedTokens: 10_000,
      modelContextWindow: 10_000,
      thresholdRatio: 0.1,
    });
    expect(result).toBe(false);
  });

  it("returns true when forced, even below threshold", () => {
    const result = shouldCompact({
      messageCount: 10,
      realMessageCount: 10,
      estimatedTokens: 100,
      modelContextWindow: 10_000,
      thresholdRatio: 0.6,
      force: true,
    });
    expect(result).toBe(true);
  });

  it("returns true when context was truncated", () => {
    const result = shouldCompact({
      messageCount: 10,
      realMessageCount: 10,
      estimatedTokens: 100,
      modelContextWindow: 10_000,
      thresholdRatio: 0.6,
      contextWasTruncated: true,
    });
    expect(result).toBe(true);
  });
});

describe("pickCutoff", () => {
  it("returns cutoffIndex 0 when budget is not exceeded", () => {
    const result = pickCutoff({
      messages: [
        { role: "user", tokens: 10 },
        { role: "assistant", tokens: 20 },
      ],
      targetTokenBudget: 100,
    });
    expect(result.cutoffIndex).toBe(0);
    expect(result.evictedTokens).toBe(0);
  });

  it("evicts oldest messages when budget is exceeded", () => {
    const result = pickCutoff({
      messages: [
        { role: "user", tokens: 50 },
        { role: "assistant", tokens: 40 },
        { role: "user", tokens: 30 },
      ],
      targetTokenBudget: 60,
    });
    // Keeps user(30) + assistant(40) = 70 > 60, so only user(30) stays.
    expect(result.cutoffIndex).toBe(2);
  });

  it("preserves pinned messages", () => {
    const result = pickCutoff({
      messages: [
        { role: "system", tokens: 50, pinned: true },
        { role: "user", tokens: 40 },
        { role: "assistant", tokens: 30 },
      ],
      targetTokenBudget: 60,
    });
    // Pinned system message at index 0 must survive, so cutoff moves to 1.
    expect(result.cutoffIndex).toBe(1);
  });

  it("respects cutoffFloor", () => {
    const result = pickCutoff({
      messages: [
        { role: "system", tokens: 100 },
        { role: "user", tokens: 10 },
        { role: "assistant", tokens: 10 },
      ],
      targetTokenBudget: 15,
      cutoffFloor: 1,
    });
    // Budget allows only assistant(10), user(10) would exceed.
    // floor=1 prevents dropping below index 1, so cutoff is 2.
    expect(result.cutoffIndex).toBe(2);
  });

  it("handles empty message list", () => {
    const result = pickCutoff({
      messages: [],
      targetTokenBudget: 100,
    });
    expect(result.cutoffIndex).toBe(0);
    expect(result.evictedTokens).toBe(0);
  });

  it("uses anchorTokens when provided", () => {
    const result = pickCutoff({
      messages: [
        { role: "user", tokens: 10 },
        { role: "assistant", tokens: 20 },
        { role: "user", tokens: 30 },
      ],
      targetTokenBudget: 40,
      anchorTokens: 20, // anchor on assistant message at index 1
    });
    // anchorTokens=20 covers the assistant message.
    // trailing = 30 (user at index 2).
    // total = 50 > 40, so we need to cut.
    // budget for pre-anchor = 40 - 30 = 10.
    // Walk backwards from anchor (i=1): assistant has 20 tokens.
    // budget - 20 = -10 < 0 → cutoff at i+1 = 2.
    // This means even the anchor message is effectively dropped from
    // the budget walk — the anchorTokens are treated as a fixed cost
    // and the walk starts at the anchor position.
    expect(result.cutoffIndex).toBe(2);
  });
});
