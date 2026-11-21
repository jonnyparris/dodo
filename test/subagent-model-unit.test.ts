/**
 * Unit tests for subagent model resolution.
 *
 * Precedence: per-call > session default > heuristic.
 * The resolver is pure, so these tests exercise every branch without
 * spinning up a provider / real LLM.
 */
import { describe, expect, it } from "vitest";
import { coercionTimeoutMs, resolveSubagentModel, subagentMaxRetries } from "../src/subagent-runner";

const MAIN_ANTHROPIC = "anthropic/claude-opus-4-7";
const MAIN_OPENAI = "openai/gpt-5.4";

describe("resolveSubagentModel — precedence", () => {
  it("per-call override wins over session default and heuristic", () => {
    const result = resolveSubagentModel(
      { model: "@cf/google/gemma-4-26b-a4b-it" },
      "anthropic/claude-haiku-4-5", // session default
      MAIN_ANTHROPIC,
    );
    expect(result).toBe("@cf/google/gemma-4-26b-a4b-it");
  });

  it("session default wins when no per-call override", () => {
    const result = resolveSubagentModel(
      {},
      "@cf/google/gemma-4-26b-a4b-it",
      MAIN_ANTHROPIC,
    );
    expect(result).toBe("@cf/google/gemma-4-26b-a4b-it");
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
      "@cf/google/gemma-4-26b-a4b-it",
      MAIN_ANTHROPIC,
    );
    expect(result).toBe("@cf/google/gemma-4-26b-a4b-it");
  });

  it("whitespace-only per-call model is treated as 'not set'", () => {
    const result = resolveSubagentModel(
      { model: "   " },
      "@cf/google/gemma-4-26b-a4b-it",
      MAIN_ANTHROPIC,
    );
    expect(result).toBe("@cf/google/gemma-4-26b-a4b-it");
  });

  it("empty string session default is treated as 'not set' (falls back to heuristic)", () => {
    const result = resolveSubagentModel({}, "", MAIN_ANTHROPIC);
    expect(result).toBe("anthropic/claude-haiku-4-5");
  });

  it("non-string per-call model is ignored", () => {
    const result = resolveSubagentModel(
      { model: 42 as unknown as string },
      "@cf/google/gemma-4-26b-a4b-it",
      MAIN_ANTHROPIC,
    );
    expect(result).toBe("@cf/google/gemma-4-26b-a4b-it");
  });

  it("trims whitespace from per-call override", () => {
    const result = resolveSubagentModel(
      { model: "  @cf/google/gemma-4-26b-a4b-it  " },
      undefined,
      MAIN_ANTHROPIC,
    );
    expect(result).toBe("@cf/google/gemma-4-26b-a4b-it");
  });
});

describe("resolveSubagentModel — removed Workers AI models", () => {
  it("remaps a per-call or session-default id removed on 2026-11-15 to its replacement", () => {
    expect(resolveSubagentModel({ model: "@cf/moonshotai/kimi-k2.6" }, undefined, MAIN_ANTHROPIC)).toBe(
      "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
    );
    expect(resolveSubagentModel({}, " @cf/zai-org/glm-5.3-flash ", MAIN_ANTHROPIC)).toBe(
      "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
    );
    expect(resolveSubagentModel({}, "@cf/qwen/qwen3-30b-a3b-fp8", MAIN_ANTHROPIC)).toBe(
      "@cf/google/gemma-4-26b-a4b-it",
    );
    // No per-call or session default: the family fallback returns the main
    // model for @cf/ ids, and that is remapped too.
    expect(resolveSubagentModel({}, undefined, "@cf/moonshotai/kimi-k2.6")).toBe(
      "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
    );
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
      "@cf/google/gemma-4-26b-a4b-it",
      MAIN_ANTHROPIC, // opencode gateway model
    );
    expect(result).toBe("@cf/google/gemma-4-26b-a4b-it");
  });

  it("allows anthropic/ subagent model even when main model is on ai-gateway", () => {
    const result = resolveSubagentModel(
      {},
      "anthropic/claude-haiku-4-5",
      "@cf/google/gemma-4-26b-a4b-it", // ai-gateway model
    );
    expect(result).toBe("anthropic/claude-haiku-4-5");
  });
});

describe("subagentMaxRetries", () => {
  it("gives Workers AI models enough retries to outlast a per-minute 429 window", () => {
    expect(subagentMaxRetries("@cf/deepseek-ai/deepseek-v4.1-flash-1017")).toBe(5);
    expect(subagentMaxRetries("@cf/zai-org/glm-5.3-flash")).toBe(5);
  });

  it("keeps the AI SDK default for hosted third-party models", () => {
    expect(subagentMaxRetries("anthropic/claude-haiku-4-5")).toBe(2);
    expect(subagentMaxRetries("openai/gpt-4.1-mini")).toBe(2);
  });
});

describe("coercionTimeoutMs", () => {
  it("gives Workers AI models room for slow reasoning passes", () => {
    // Measured 2026-10-28 on jp-gw: one GLM-5.3 Flash pass 10-25s, kimi-k2.6 64s, gemma-4 81s.
    expect(coercionTimeoutMs("@cf/zai-org/glm-5.3-flash")).toBe(120_000);
    expect(coercionTimeoutMs("@cf/moonshotai/kimi-k2.6")).toBe(120_000);
  });

  it("keeps the tight budget for hosted models", () => {
    expect(coercionTimeoutMs("anthropic/claude-haiku-4-5")).toBe(30_000);
    expect(coercionTimeoutMs("openai/gpt-4.1-mini")).toBe(30_000);
  });
});
