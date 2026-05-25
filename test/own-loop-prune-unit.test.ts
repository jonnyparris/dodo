/**
 * Unit tests for `pruneOversizedToolResults` — the harness-level safety
 * net that keeps the own-loop's in-memory messages array under the token
 * budget on first-turn explorations.
 */
import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { pruneOversizedToolResults } from "../src/own-loop-prune";

// Deterministic estimator for tests: 1 token per 4 chars of JSON, rounded up.
function estimate(messages: ModelMessage[]): number {
  let total = 0;
  for (const m of messages) total += Math.ceil(JSON.stringify(m).length / 4);
  return total;
}

function userMsg(text: string): ModelMessage {
  return { role: "user", content: text };
}

function assistantToolCall(toolName: string, toolCallId: string): ModelMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId,
        toolName,
        input: {},
      } as unknown as never,
    ],
  };
}

function toolResult(toolName: string, toolCallId: string, payload: string): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolName,
        toolCallId,
        output: { type: "text", value: payload },
      } as unknown as never,
    ],
  };
}

describe("pruneOversizedToolResults", () => {
  it("returns pruned=false when already under budget", () => {
    const messages: ModelMessage[] = [userMsg("hi"), toolResult("read", "t1", "small")];
    const result = pruneOversizedToolResults(messages, {
      targetTokens: 1_000,
      estimate,
    });
    expect(result.pruned).toBe(false);
    expect(result.partsPruned).toBe(0);
    expect(messages[1].content).toMatchObject([
      { type: "tool-result", output: { value: "small" } },
    ]);
  });

  it("prunes the oldest large tool-result first", () => {
    const big = "X".repeat(40_000); // ~10k tokens with the test estimator
    const small = "Y".repeat(40); // tiny
    const messages: ModelMessage[] = [
      userMsg("explore"),
      assistantToolCall("read", "t1"),
      toolResult("read", "t1", big),
      assistantToolCall("read", "t2"),
      toolResult("read", "t2", small),
    ];
    const before = estimate(messages);
    expect(before).toBeGreaterThan(5_000);

    const result = pruneOversizedToolResults(messages, {
      targetTokens: 500,
      estimate,
      preserveRecentToolMessages: 0,
      minPrunablePayloadChars: 1_000,
    });

    expect(result.pruned).toBe(true);
    expect(result.partsPruned).toBe(1);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    // The big one is now a placeholder; the small one is untouched.
    expect((messages[2].content as Array<{ output?: { value: string } }>)[0].output?.value)
      .toMatch(/pruned by the harness/);
    expect((messages[4].content as Array<{ output?: { value: string } }>)[0].output?.value)
      .toBe(small);
  });

  it("preserves the most recent N tool messages regardless of size", () => {
    const huge = "Z".repeat(80_000);
    const messages: ModelMessage[] = [
      userMsg("explore"),
      assistantToolCall("read", "t1"),
      toolResult("read", "t1", huge),
      assistantToolCall("read", "t2"),
      toolResult("read", "t2", huge),
    ];

    const result = pruneOversizedToolResults(messages, {
      targetTokens: 1_000, // impossible to hit while preserving both
      estimate,
      preserveRecentToolMessages: 2,
      minPrunablePayloadChars: 1_000,
    });

    // Both recent tool messages are preserved, so nothing is pruned.
    expect(result.pruned).toBe(false);
    expect(result.partsPruned).toBe(0);
    const lastToolValue = (messages[4].content as Array<{ output?: { value: string } }>)[0].output?.value;
    expect(lastToolValue).toBe(huge);
  });

  it("preserves tool-call envelope (toolName, toolCallId) when pruning", () => {
    const big = "Q".repeat(40_000);
    const messages: ModelMessage[] = [
      userMsg("explore"),
      assistantToolCall("grep", "abc-123"),
      toolResult("grep", "abc-123", big),
    ];

    pruneOversizedToolResults(messages, {
      targetTokens: 100,
      estimate,
      preserveRecentToolMessages: 0,
      minPrunablePayloadChars: 1_000,
    });

    const part = (messages[2].content as Array<{ type: string; toolName?: string; toolCallId?: string }>)[0];
    // toolName + toolCallId must survive so the model's prior tool-call still resolves.
    expect(part.toolName).toBe("grep");
    expect(part.toolCallId).toBe("abc-123");
    expect(part.type).toBe("tool-result");
  });

  it("skips payloads smaller than minPrunablePayloadChars", () => {
    // Three tool messages, each ~500 chars — below the default 2000 floor.
    const messages: ModelMessage[] = [
      userMsg("hi"),
      toolResult("read", "t1", "a".repeat(500)),
      toolResult("read", "t2", "b".repeat(500)),
      toolResult("read", "t3", "c".repeat(500)),
    ];

    const result = pruneOversizedToolResults(messages, {
      targetTokens: 1,
      estimate,
      preserveRecentToolMessages: 0,
    });

    expect(result.partsPruned).toBe(0);
    // Originals intact.
    expect((messages[1].content as Array<{ output?: { value: string } }>)[0].output?.value)
      .toHaveLength(500);
  });

  it("stops pruning once budget is back under target", () => {
    const big1 = "1".repeat(20_000);
    const big2 = "2".repeat(20_000);
    const big3 = "3".repeat(20_000);
    const messages: ModelMessage[] = [
      userMsg("explore"),
      toolResult("read", "t1", big1),
      toolResult("read", "t2", big2),
      toolResult("read", "t3", big3),
    ];

    const result = pruneOversizedToolResults(messages, {
      // Roughly enough budget that pruning ONE message gets us back under.
      targetTokens: Math.ceil(estimate(messages) / 2),
      estimate,
      preserveRecentToolMessages: 0,
      minPrunablePayloadChars: 1_000,
    });

    // Should have pruned at least one but not all three.
    expect(result.partsPruned).toBeGreaterThan(0);
    expect(result.partsPruned).toBeLessThan(3);
    expect(result.tokensAfter).toBeLessThanOrEqual(
      Math.ceil(estimate(messages) * 1.05), // tiny slack for rounding
    );
  });

  it("is a no-op when there are no tool messages", () => {
    const messages: ModelMessage[] = [
      userMsg("hello"),
      { role: "assistant", content: "world" },
    ];
    const before = JSON.stringify(messages);
    const result = pruneOversizedToolResults(messages, {
      targetTokens: 1,
      estimate,
    });
    expect(result.pruned).toBe(false);
    expect(JSON.stringify(messages)).toBe(before);
  });
});
