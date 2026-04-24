/**
 * Unit tests for subagent model resolution.
 *
 * Precedence: per-call > session default > heuristic.
 * The resolver is pure, so these tests exercise every branch without
 * spinning up a provider / real LLM.
 */
import { describe, expect, it } from "vitest";
import { resolveSubagentModel } from "../src/agentic";

const MAIN_ANTHROPIC = "anthropic/claude-opus-4-7";
const MAIN_OPENAI = "openai/gpt-5.4";

describe("resolveSubagentModel — precedence", () => {
  it("per-call override wins over session default and heuristic", () => {
    const result = resolveSubagentModel(
      { model: "@cf/moonshotai/kimi-k2.6" },
      "anthropic/claude-haiku-4-5", // session default
      MAIN_ANTHROPIC,
    );
    expect(result).toBe("@cf/moonshotai/kimi-k2.6");
  });

  it("session default wins when no per-call override", () => {
    const result = resolveSubagentModel(
      {},
      "@cf/moonshotai/kimi-k2.6",
      MAIN_ANTHROPIC,
    );
    expect(result).toBe("@cf/moonshotai/kimi-k2.6");
  });

  it("falls back to heuristic when neither per-call nor session default set", () => {
    const result = resolveSubagentModel({}, undefined, MAIN_ANTHROPIC);
    // getExploreModel picks Haiku for anthropic/ family
    expect(result).toBe("anthropic/claude-haiku-4-5");
  });

  it("heuristic picks gpt-4.1-mini for openai family", () => {
    const result = resolveSubagentModel({}, undefined, MAIN_OPENAI);
    expect(result).toBe("openai/gpt-4.1-mini");
  });

  it("heuristic falls back to main model when provider family is unknown", () => {
    const result = resolveSubagentModel({}, undefined, "mystery/weird-model");
    expect(result).toBe("mystery/weird-model");
  });
});

describe("resolveSubagentModel — edge cases", () => {
  it("empty string per-call model is treated as 'not set' (session default wins)", () => {
    const result = resolveSubagentModel(
      { model: "" },
      "@cf/moonshotai/kimi-k2.6",
      MAIN_ANTHROPIC,
    );
    expect(result).toBe("@cf/moonshotai/kimi-k2.6");
  });

  it("whitespace-only per-call model is treated as 'not set'", () => {
    const result = resolveSubagentModel(
      { model: "   " },
      "@cf/moonshotai/kimi-k2.6",
      MAIN_ANTHROPIC,
    );
    expect(result).toBe("@cf/moonshotai/kimi-k2.6");
  });

  it("empty string session default is treated as 'not set' (falls back to heuristic)", () => {
    const result = resolveSubagentModel({}, "", MAIN_ANTHROPIC);
    expect(result).toBe("anthropic/claude-haiku-4-5");
  });

  it("non-string per-call model is ignored", () => {
    const result = resolveSubagentModel(
      { model: 42 as unknown as string },
      "@cf/moonshotai/kimi-k2.6",
      MAIN_ANTHROPIC,
    );
    expect(result).toBe("@cf/moonshotai/kimi-k2.6");
  });

  it("trims whitespace from per-call override", () => {
    const result = resolveSubagentModel(
      { model: "  @cf/moonshotai/kimi-k2.6  " },
      undefined,
      MAIN_ANTHROPIC,
    );
    expect(result).toBe("@cf/moonshotai/kimi-k2.6");
  });
});

describe("resolveSubagentModel — cross-gateway scenarios", () => {
  // The key use case: main model is anthropic/ (opencode gateway) but
  // subagent picks a @cf/* model (Workers AI via ai-gateway).
  // The resolver just returns the ID — gateway routing happens downstream
  // in buildProviderForModel. This test confirms the resolver doesn't
  // filter Workers AI IDs based on the main model's gateway.
  it("allows @cf/* subagent model even when main model is on opencode gateway", () => {
    const result = resolveSubagentModel(
      {},
      "@cf/moonshotai/kimi-k2.6",
      MAIN_ANTHROPIC, // opencode gateway model
    );
    expect(result).toBe("@cf/moonshotai/kimi-k2.6");
  });

  it("allows anthropic/ subagent model even when main model is on ai-gateway", () => {
    const result = resolveSubagentModel(
      {},
      "anthropic/claude-haiku-4-5",
      "@cf/moonshotai/kimi-k2.6", // ai-gateway model
    );
    expect(result).toBe("anthropic/claude-haiku-4-5");
  });
});
