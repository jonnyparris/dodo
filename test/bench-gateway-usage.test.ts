/**
 * bench/model-ab.ts sums AI Gateway `tokens_in` per session. Anthropic's
 * native Messages API reports only uncached input there, OpenAI-style APIs
 * report the whole prompt. These fixtures are real log shapes from jp-gw
 * (2026-10-21).
 */
import { describe, expect, it } from "vitest";
import { inputTokens, isAnthropicMessages } from "../bench/gateway-usage";

describe("inputTokens", () => {
  it("adds cache reads and writes back for native Anthropic Messages", () => {
    const read = {
      provider: "anthropic",
      path: "v1/messages?beta=true",
      tokens_in: 3,
      usage_metadata: { input_tokens: 3, input_cache_creation_tokens: 12, input_cached_tokens: 24632 },
    };
    expect(inputTokens(read)).toEqual({ total: 24647, cached: 24632, cacheWrite: 12 });
    const write = { ...read, path: "v1/messages", usage_metadata: { input_tokens: 3, input_cache_creation_tokens: 24632, input_cached_tokens: 0 } };
    expect(inputTokens(write)).toEqual({ total: 24635, cached: 0, cacheWrite: 24632 });
  });

  it("does not double-count OpenAI-style logs, where input already includes the cached part", () => {
    const wai = {
      provider: "workers-ai",
      path: "chat/completions",
      tokens_in: 53979,
      usage_metadata: { input_tokens: 53979, input_cached_tokens: 53696 },
    };
    expect(inputTokens(wai)).toEqual({ total: 53979, cached: 53696, cacheWrite: 0 });
  });

  // AI Gateway's /compat strips cache_control markers today, so this fixture has no cache fields.
  it("treats Anthropic via /compat chat/completions as OpenAI-style", () => {
    const compat = { provider: "anthropic", path: "chat/completions", tokens_in: 15449, usage_metadata: { input_tokens: 15449 } };
    expect(isAnthropicMessages(compat)).toBe(false);
    expect(inputTokens(compat)).toEqual({ total: 15449, cached: 0, cacheWrite: 0 });
  });

  it("handles missing usage and null tokens", () => {
    expect(inputTokens({ provider: "linkup", path: "/websearch", tokens_in: 0 })).toEqual({ total: 0, cached: 0, cacheWrite: 0 });
    expect(inputTokens({ provider: "anthropic", path: "v1/messages", tokens_in: null, usage_metadata: null })).toEqual({ total: 0, cached: 0, cacheWrite: 0 });
  });

  it("falls back to usage_metadata.input_tokens when tokens_in is null", () => {
    const l = { provider: "anthropic", path: "v1/messages", tokens_in: null, usage_metadata: { input_tokens: 5, input_cached_tokens: 100 } };
    expect(inputTokens(l)).toEqual({ total: 105, cached: 100, cacheWrite: 0 });
    const wai = { provider: "workers-ai", path: "chat/completions", tokens_in: null, usage_metadata: { input_tokens: 50, input_cached_tokens: 40 } };
    expect(inputTokens(wai)).toEqual({ total: 50, cached: 40, cacheWrite: 0 });
  });
});
