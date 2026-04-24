/**
 * Unit tests for Anthropic prompt-caching request-body transform.
 *
 * The transform is pure: it takes an OpenAI-compatible request body and
 * returns a new one with cache_control markers in three places (system,
 * last tool, last user message). Non-Anthropic providers ignore the extra
 * fields; Anthropic (via either gateway) honours them for ~90% input-cost
 * reduction on multi-turn sessions with stable system prompt + tools.
 */
import { describe, expect, it } from "vitest";
import { addAnthropicCacheMarkers } from "../src/agentic";

describe("addAnthropicCacheMarkers", () => {
  it("upgrades a string system prompt to array-of-blocks with cache_control", () => {
    const out = addAnthropicCacheMarkers({
      system: "You are Dodo.",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(Array.isArray(out.system)).toBe(true);
    const system = out.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(1);
    expect(system[0].type).toBe("text");
    expect(system[0].text).toBe("You are Dodo.");
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("does not double-mark an already-marked system prompt", () => {
    const input = {
      system: [
        { type: "text", text: "rules", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    };
    const out = addAnthropicCacheMarkers(input);
    // Equal reference to the same marker object
    const system = out.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(1);
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("adds cache_control to the last tool definition when no marker exists", () => {
    const out = addAnthropicCacheMarkers({
      system: "x",
      tools: [
        { type: "function", function: { name: "read" } },
        { type: "function", function: { name: "edit" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    const tools = out.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(2);
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("leaves tools alone if any already has cache_control", () => {
    const existing = {
      type: "function",
      function: { name: "edit" },
      cache_control: { type: "ephemeral" },
    };
    const out = addAnthropicCacheMarkers({
      system: "x",
      tools: [{ type: "function", function: { name: "read" } }, existing],
      messages: [{ role: "user", content: "hi" }],
    });
    const tools = out.tools as Array<Record<string, unknown>>;
    expect(tools[1]).toEqual(existing);
    expect(tools[0].cache_control).toBeUndefined();
  });

  it("adds cache_control to the last user message (string content)", () => {
    const out = addAnthropicCacheMarkers({
      system: "x",
      messages: [
        { role: "user", content: "old" },
        { role: "assistant", content: "ack" },
        { role: "user", content: "latest" },
      ],
    });
    const msgs = out.messages as Array<Record<string, unknown>>;
    expect(msgs[0].content).toBe("old"); // untouched
    expect(msgs[1].content).toBe("ack"); // untouched
    const latest = msgs[2];
    expect(Array.isArray(latest.content)).toBe(true);
    const content = latest.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe("text");
    expect(content[0].text).toBe("latest");
    expect(content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("does not touch non-string (multimodal) user message content", () => {
    const multimodal = [
      { type: "text", text: "describe this" },
      { type: "image", image: "..." },
    ];
    const out = addAnthropicCacheMarkers({
      system: "x",
      messages: [{ role: "user", content: multimodal }],
    });
    const msgs = out.messages as Array<Record<string, unknown>>;
    expect(msgs[0].content).toBe(multimodal);
  });

  it("does not mutate the input body", () => {
    const input = {
      system: "rules",
      tools: [{ type: "function", function: { name: "read" } }],
      messages: [{ role: "user", content: "hi" }],
    };
    const snapshot = JSON.stringify(input);
    addAnthropicCacheMarkers(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("handles a body with no tools or messages gracefully", () => {
    const out = addAnthropicCacheMarkers({ system: "rules" });
    expect(Array.isArray(out.system)).toBe(true);
    expect(out.tools).toBeUndefined();
    expect(out.messages).toBeUndefined();
  });
});
