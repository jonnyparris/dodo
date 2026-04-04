/**
 * Test the compaction summary pipeline: UIMessage → ModelMessage conversion.
 *
 * Verifies that compaction summaries (system messages injected by Think's
 * _applyCompactions) survive the convertToModelMessages + pruneMessages
 * pipeline and appear in the final ModelMessage array.
 */
import { describe, expect, it } from "vitest";
import { convertToModelMessages, pruneMessages } from "ai";
import type { UIMessage, ModelMessage } from "ai";

// Simulate what Think's _applyCompactions produces
function makeCompactionSummary(summary: string): UIMessage {
  return {
    id: "compaction_test-uuid",
    role: "system",
    parts: [
      {
        type: "text",
        text: `[Previous conversation summary]\n${summary}`,
      },
    ],
  };
}

function makeUserMessage(text: string): UIMessage {
  return {
    id: `user-${Math.random().toString(36).slice(2)}`,
    role: "user",
    parts: [{ type: "text", text }],
  };
}

function makeAssistantMessage(text: string): UIMessage {
  return {
    id: `asst-${Math.random().toString(36).slice(2)}`,
    role: "assistant",
    parts: [{ type: "text", text }],
  };
}

describe("Compaction summary pipeline", () => {
  it("convertToModelMessages preserves system messages from compaction", async () => {
    const messages: UIMessage[] = [
      makeCompactionSummary("The user asked about coding-agent.ts imports."),
      makeUserMessage("What was the first file we read?"),
      makeAssistantMessage("Based on the summary, we read coding-agent.ts."),
    ];

    const modelMessages = await convertToModelMessages(messages);

    console.log("=== convertToModelMessages output ===");
    for (const msg of modelMessages) {
      const preview = typeof msg.content === "string"
        ? msg.content.slice(0, 100)
        : JSON.stringify(msg.content).slice(0, 100);
      console.log(`  role=${msg.role}, content=${preview}`);
    }

    const systemMessages = modelMessages.filter((m) => m.role === "system");
    expect(systemMessages.length).toBeGreaterThanOrEqual(1);

    const summaryMsg = systemMessages.find((m) => {
      const text = typeof m.content === "string" ? m.content : "";
      return text.includes("[Previous conversation summary]");
    });
    expect(summaryMsg).toBeDefined();
  });

  it("pruneMessages preserves non-empty system messages", async () => {
    const messages: UIMessage[] = [
      makeCompactionSummary("Summary of prior turns."),
      makeUserMessage("Hello"),
      makeAssistantMessage("Hi there"),
      makeUserMessage("What did we do before?"),
    ];

    const modelMessages = await convertToModelMessages(messages);
    const pruned = pruneMessages({
      messages: modelMessages,
      toolCalls: "before-last-2-messages",
    });

    console.log("=== After pruneMessages ===");
    for (const msg of pruned) {
      const preview = typeof msg.content === "string"
        ? msg.content.slice(0, 100)
        : JSON.stringify(msg.content).slice(0, 100);
      console.log(`  role=${msg.role}, content=${preview}`);
    }

    const systemAfterPrune = pruned.filter((m) => m.role === "system");
    expect(systemAfterPrune.length).toBeGreaterThanOrEqual(1);
  });

  it("system message at position 0 survives the full pipeline", async () => {
    // This is the exact shape Think produces after compaction:
    // [compaction_summary, user_msg, assistant_msg, user_msg, assistant_msg, ...]
    const messages: UIMessage[] = [
      makeCompactionSummary("## Goal\nRead coding-agent.ts\n## Progress\n### Done\n- Read lines 1-50"),
      makeUserMessage("Continue reading lines 50-100"),
      makeAssistantMessage("Here are lines 50-100..."),
      makeUserMessage("What were the imports from the first read?"),
    ];

    const modelMessages = await convertToModelMessages(messages);
    const pruned = pruneMessages({
      messages: modelMessages,
      toolCalls: "before-last-2-messages",
    });

    // The summary should be the first message
    expect(pruned[0].role).toBe("system");
    const content = typeof pruned[0].content === "string" ? pruned[0].content : "";
    expect(content).toContain("[Previous conversation summary]");
    expect(content).toContain("Read coding-agent.ts");
  });

  it("system message mid-conversation survives", async () => {
    // Edge case: what if the compaction summary isn't at index 0?
    // (e.g. there's a user message before the compacted range)
    const messages: UIMessage[] = [
      makeUserMessage("Initial message before compaction range"),
      makeCompactionSummary("Summary of turns 2-8"),
      makeUserMessage("Turn 9 question"),
      makeAssistantMessage("Turn 9 answer"),
    ];

    const modelMessages = await convertToModelMessages(messages);

    console.log("=== Mid-conversation system message ===");
    for (const msg of modelMessages) {
      const preview = typeof msg.content === "string"
        ? msg.content.slice(0, 100)
        : JSON.stringify(msg.content).slice(0, 100);
      console.log(`  role=${msg.role}, content=${preview}`);
    }

    const systemMessages = modelMessages.filter((m) => m.role === "system");
    expect(systemMessages.length).toBeGreaterThanOrEqual(1);
  });

  it("empty system message IS removed by pruneMessages", async () => {
    // Verify that pruneMessages removes empty messages but keeps non-empty ones
    const messages: ModelMessage[] = [
      { role: "system", content: "" }, // empty — should be removed
      { role: "system", content: "[Previous conversation summary]\nReal content" }, // non-empty — should survive
      { role: "user", content: "Hello" },
    ];

    const pruned = pruneMessages({
      messages,
      toolCalls: "before-last-2-messages",
    });

    // Empty system message should be gone, non-empty should survive
    const systemMessages = pruned.filter((m) => m.role === "system");
    expect(systemMessages.length).toBe(1);
    expect(typeof systemMessages[0].content === "string" && systemMessages[0].content).toContain("Previous conversation summary");
  });
});
