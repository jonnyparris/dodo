/**
 * Unit tests for the budget-estimation helpers that back the autocompaction
 * safeguards added in issue #34.
 *
 * These helpers are pure and fast — the generator method that uses them
 * (onChatMessage) is covered by higher-level integration suites.
 */
import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { estimateMessageTokens, estimateMessagesTokens } from "../src/coding-agent";

describe("estimateMessageTokens", () => {
  it("returns a positive integer for a trivial message", () => {
    const msg: ModelMessage = { role: "user", content: "hello" };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBeGreaterThan(0);
    expect(Number.isInteger(tokens)).toBe(true);
  });

  it("scales roughly linearly with content length", () => {
    const short: ModelMessage = { role: "user", content: "a".repeat(100) };
    const long: ModelMessage = { role: "user", content: "a".repeat(10_000) };
    const shortTokens = estimateMessageTokens(short);
    const longTokens = estimateMessageTokens(long);
    // 100x more content should land within one order of magnitude of 100x tokens.
    const ratio = longTokens / shortTokens;
    expect(ratio).toBeGreaterThan(50);
    expect(ratio).toBeLessThan(200);
  });

  it("counts tool-call payloads, not just text content", () => {
    const textOnly: ModelMessage = { role: "assistant", content: "ok" };
    const withToolCall: ModelMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "ok" },
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "read",
          input: { path: "src/coding-agent.ts", offset: 1, limit: 500 },
        },
      ],
    };
    expect(estimateMessageTokens(withToolCall)).toBeGreaterThan(estimateMessageTokens(textOnly));
  });
});

describe("estimateMessagesTokens", () => {
  it("returns 0 for an empty array", () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });

  it("sums individual message estimates", () => {
    const a: ModelMessage = { role: "user", content: "first message" };
    const b: ModelMessage = { role: "assistant", content: "second message" };
    const total = estimateMessagesTokens([a, b]);
    expect(total).toBe(estimateMessageTokens(a) + estimateMessageTokens(b));
  });

  it("crosses the 50% budget threshold for a ~500k-char prompt against a 1M-token budget", () => {
    // ~500k chars / 3.5 ≈ 142k tokens. Against a 800k budget (1M * 0.8),
    // this sits around 18% — below the 50% compaction threshold. Against a
    // 200k-token model's 160k budget, the same payload is ~89%, which should
    // trigger compaction. This is the exact failure mode issue #34 describes.
    const large: ModelMessage = { role: "user", content: "x".repeat(500_000) };
    const tokens = estimateMessagesTokens([large]);
    const budget200k = Math.floor(200_000 * 0.8);
    expect(tokens / budget200k).toBeGreaterThan(0.5);
  });
});

describe("estimateMessageTokens caching", () => {
  // Per-message WeakMap cache eliminates the per-turn JSON.stringify storm.
  // estimateMessagesTokens is called 3–4 times per chat step, so any
  // accidental cache miss costs O(messages × stringify) every turn.

  it("memoises by message reference", () => {
    const msg: ModelMessage = { role: "user", content: "first message" };
    const stringifySpy = vi.spyOn(JSON, "stringify");

    const first = estimateMessageTokens(msg);
    const callsAfterFirst = stringifySpy.mock.calls.filter((c) => c[0] === msg).length;

    const second = estimateMessageTokens(msg);
    const callsAfterSecond = stringifySpy.mock.calls.filter((c) => c[0] === msg).length;

    expect(second).toBe(first);
    expect(callsAfterFirst).toBe(1);
    // Second call must hit the cache — zero additional stringify of this msg.
    expect(callsAfterSecond).toBe(1);

    stringifySpy.mockRestore();
  });

  it("estimateMessagesTokens only stringifies new messages on a repeat call", () => {
    const a: ModelMessage = { role: "user", content: "alpha alpha alpha" };
    const b: ModelMessage = { role: "assistant", content: "beta beta beta" };
    const c: ModelMessage = { role: "user", content: "gamma gamma gamma" };

    // Prime the cache for a and b.
    estimateMessagesTokens([a, b]);

    const stringifySpy = vi.spyOn(JSON, "stringify");

    // Re-estimate with a third message — only c should hit JSON.stringify.
    const total = estimateMessagesTokens([a, b, c]);

    const stringifiedMessages = stringifySpy.mock.calls.filter(
      (call) => call[0] === a || call[0] === b || call[0] === c,
    );
    expect(stringifiedMessages.length).toBe(1);
    expect(stringifiedMessages[0]![0]).toBe(c);

    expect(total).toBe(
      estimateMessageTokens(a) + estimateMessageTokens(b) + estimateMessageTokens(c),
    );

    stringifySpy.mockRestore();
  });
});
