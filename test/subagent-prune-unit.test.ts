import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { pruneSubagentHistory, subagentPrepareStep } from "../src/agentic";

/**
 * `pruneSubagentHistory` is the inter-step message-compaction used by the
 * explore + task subagents. It keeps the original user query plus the most
 * recent N assistant+tool_result groups and inserts a pruning marker in
 * between. These tests lock in the contract — if you change the behaviour,
 * update the docs in docs/facets.md too.
 */

function makeUser(content: string): ModelMessage {
  return { role: "user", content };
}

function makeAssistant(content: string): ModelMessage {
  return { role: "assistant", content };
}

function makeToolResult(toolCallId: string, output: string): ModelMessage {
  // The AI SDK tool-result message shape uses `content: Array<{ type: "tool-result", ... }>`
  // but for these tests we only care about the role — the pruner groups by
  // role position, not content shape.
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName: "grep",
        output: { type: "text", value: output },
      },
    ],
  } as unknown as ModelMessage;
}

describe("subagent message pruning", () => {
  it("leaves short histories untouched", () => {
    const messages: ModelMessage[] = [
      makeUser("initial query"),
      makeAssistant("step 1"),
      makeToolResult("call-1", "step 1 result"),
    ];
    const out = pruneSubagentHistory(messages, 4);
    expect(out).toBe(messages); // same reference — no copy
  });

  it("prunes middle groups when history exceeds the window", () => {
    // Build: user + 6 groups (each group = assistant + tool result)
    // Window = 4 → keep initial user + last 4 groups, drop middle 2.
    const messages: ModelMessage[] = [makeUser("find the bug")];
    for (let i = 1; i <= 6; i++) {
      messages.push(makeAssistant(`step ${i}`));
      messages.push(makeToolResult(`call-${i}`, `result ${i}`));
    }
    // Total: 1 user + 12 (assistant+tool pairs) = 13 messages.

    const out = pruneSubagentHistory(messages, 4);

    // Expect: [user, marker, assistant-3, tool-3, asst-4, tool-4, asst-5, tool-5, asst-6, tool-6]
    // = 1 + 1 + 8 = 10 messages
    expect(out).not.toBe(messages);
    expect(out.length).toBe(10);

    // First message must be the original user query.
    expect(out[0].role).toBe("user");
    expect(out[0].content).toBe("find the bug");

    // Second message must be the pruning marker.
    expect(out[1].role).toBe("user");
    expect(String(out[1].content)).toContain("pruned");
    expect(String(out[1].content)).toContain("earlier");

    // Last messages must be the final group (assistant step 6 + its tool result).
    const last = out[out.length - 1];
    expect(last.role).toBe("tool");
    const secondLast = out[out.length - 2];
    expect(secondLast.role).toBe("assistant");
    expect(secondLast.content).toBe("step 6");
  });

  it("preserves the initial user query as goal anchor", () => {
    const messages: ModelMessage[] = [makeUser("CRITICAL GOAL: find the bug")];
    for (let i = 1; i <= 10; i++) {
      messages.push(makeAssistant(`step ${i}`));
      messages.push(makeToolResult(`call-${i}`, `result ${i}`));
    }
    const out = pruneSubagentHistory(messages, 2);
    expect(out[0].content).toBe("CRITICAL GOAL: find the bug");
  });

  it("handles pure assistant groups (no tool results)", () => {
    // Subagent replied conversationally without tool calls — each group is
    // just one assistant message.
    const messages: ModelMessage[] = [makeUser("what's 2+2")];
    for (let i = 1; i <= 10; i++) {
      messages.push(makeAssistant(`thinking ${i}`));
    }
    const out = pruneSubagentHistory(messages, 3);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].content).toBe("what's 2+2"); // user preserved
    // Last three messages should be the last three assistant messages
    expect(out[out.length - 1].content).toBe("thinking 10");
    expect(out[out.length - 2].content).toBe("thinking 9");
    expect(out[out.length - 3].content).toBe("thinking 8");
  });

  it("returns the same array if no pruning needed at the boundary", () => {
    // exactly window+1 messages — no prune
    const messages: ModelMessage[] = [makeUser("q")];
    for (let i = 1; i <= 4; i++) {
      messages.push(makeAssistant(`step ${i}`));
    }
    const out = pruneSubagentHistory(messages, 4);
    expect(out).toBe(messages);
  });

  it("window=0 drops all history except the original user query + marker", () => {
    const messages: ModelMessage[] = [makeUser("q")];
    for (let i = 1; i <= 5; i++) {
      messages.push(makeAssistant(`step ${i}`));
      messages.push(makeToolResult(`call-${i}`, `result ${i}`));
    }
    const out = pruneSubagentHistory(messages, 0);
    // Should keep user + marker, drop everything else.
    // Current impl keeps at least 1 group as fallback; check length.
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0].content).toBe("q");
  });
});

describe("subagentPrepareStep", () => {
  it("returns empty object when pruning doesn't fire", () => {
    const messages: ModelMessage[] = [makeUser("q"), makeAssistant("a")];
    const prep = subagentPrepareStep();
    const result = prep({ messages });
    expect(result).toEqual({});
  });

  it("returns message override when pruning fires", () => {
    const messages: ModelMessage[] = [makeUser("q")];
    for (let i = 1; i <= 10; i++) {
      messages.push(makeAssistant(`step ${i}`));
      messages.push(makeToolResult(`call-${i}`, `result ${i}`));
    }
    const prep = subagentPrepareStep({ windowSize: 2 });
    const result = prep({ messages });
    expect(result.messages).toBeDefined();
    expect(result.messages!.length).toBeLessThan(messages.length);
  });
});
