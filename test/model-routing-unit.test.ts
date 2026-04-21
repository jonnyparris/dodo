/**
 * Pure unit tests for gateway model routing.
 *
 * Covers:
 * - `resolveWireModelId`: translates user-facing model IDs (`@cf/…`) into the
 *   wire format that Cloudflare's AI Gateway unified API expects
 *   (`workers-ai/@cf/…`), and rejects Workers AI models on the opencode gateway.
 * - The `isRoutableByOpencodeGateway` helper used to filter `/api/models`
 *   responses so the UI never offers a model that will fail on first prompt.
 *
 * The second helper lives inside src/shared-index.ts and isn't exported; it's
 * re-implemented here to match (same pattern as permission-unit.test.ts).
 * Keep this file in sync with the canonical versions in src/.
 */
import { describe, expect, it } from "vitest";
import { resolveWireModelId } from "../src/agentic";

// ─── Mirror of isRoutableByOpencodeGateway from src/shared-index.ts ───

const OPENCODE_SUPPORTED_PROVIDER_PREFIXES = new Set(["openai", "anthropic", "google", "deepseek"]);
const OPENCODE_BAD_SLUG_PREFIXES = [
  "kimi", "glm", "qwen", "qwen3", "mimo", "minimax", "nemotron", "trinity", "grok-code", "big-pickle",
];

function isRoutableByOpencodeGateway(id: string): boolean {
  const slashIdx = id.indexOf("/");
  if (slashIdx === -1) return false;
  const providerPrefix = id.slice(0, slashIdx);
  const slug = id.slice(slashIdx + 1);
  if (id.startsWith("@cf/")) return false;
  if (!OPENCODE_SUPPORTED_PROVIDER_PREFIXES.has(providerPrefix)) return false;
  if (providerPrefix === "anthropic") {
    return !OPENCODE_BAD_SLUG_PREFIXES.some((bad) => slug.startsWith(bad));
  }
  return true;
}

// ─── Tests ───

describe("resolveWireModelId", () => {
  it("prefixes @cf/ models with workers-ai/ on the ai-gateway", () => {
    expect(resolveWireModelId("@cf/moonshotai/kimi-k2.6", "ai-gateway")).toBe(
      "workers-ai/@cf/moonshotai/kimi-k2.6",
    );
    expect(resolveWireModelId("@cf/meta/llama-4-scout-17b-16e-instruct", "ai-gateway")).toBe(
      "workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct",
    );
  });

  it("passes non-@cf/ models through unchanged on both gateways", () => {
    expect(resolveWireModelId("openai/gpt-5.4", "ai-gateway")).toBe("openai/gpt-5.4");
    expect(resolveWireModelId("openai/gpt-5.4", "opencode")).toBe("openai/gpt-5.4");
    expect(resolveWireModelId("anthropic/claude-sonnet-4-6", "opencode")).toBe("anthropic/claude-sonnet-4-6");
  });

  it("throws when a @cf/ model is used with the opencode gateway", () => {
    expect(() => resolveWireModelId("@cf/moonshotai/kimi-k2.6", "opencode")).toThrow(
      /requires the AI Gateway/,
    );
  });
});

describe("isRoutableByOpencodeGateway", () => {
  it("accepts real Anthropic, OpenAI, Google, DeepSeek models", () => {
    expect(isRoutableByOpencodeGateway("anthropic/claude-sonnet-4-6")).toBe(true);
    expect(isRoutableByOpencodeGateway("anthropic/claude-opus-4-7")).toBe(true);
    expect(isRoutableByOpencodeGateway("openai/gpt-5.4")).toBe(true);
    expect(isRoutableByOpencodeGateway("google/gemini-3-pro")).toBe(true);
    expect(isRoutableByOpencodeGateway("deepseek/deepseek-chat")).toBe(true);
  });

  it("rejects models falsely prefixed with anthropic/ by the models.dev fallback", () => {
    // These are the ones the original issue #30 reported as Bad Request.
    expect(isRoutableByOpencodeGateway("anthropic/kimi-k2.6")).toBe(false);
    expect(isRoutableByOpencodeGateway("anthropic/kimi-k2-thinking")).toBe(false);
    expect(isRoutableByOpencodeGateway("anthropic/glm-4.6")).toBe(false);
    expect(isRoutableByOpencodeGateway("anthropic/qwen3-coder")).toBe(false);
    expect(isRoutableByOpencodeGateway("anthropic/mimo-v2-flash-free")).toBe(false);
    expect(isRoutableByOpencodeGateway("anthropic/minimax-m2.7")).toBe(false);
    expect(isRoutableByOpencodeGateway("anthropic/grok-code")).toBe(false);
  });

  it("rejects Workers AI @cf/ models (ai-gateway only)", () => {
    expect(isRoutableByOpencodeGateway("@cf/moonshotai/kimi-k2.6")).toBe(false);
    expect(isRoutableByOpencodeGateway("@cf/meta/llama-4-scout-17b-16e-instruct")).toBe(false);
  });

  it("rejects unknown provider prefixes", () => {
    expect(isRoutableByOpencodeGateway("alibaba/qwen3.5-plus")).toBe(false);
    expect(isRoutableByOpencodeGateway("moonshotai/kimi-k2.6")).toBe(false);
    expect(isRoutableByOpencodeGateway("openrouter/kimi-k2.6")).toBe(false);
  });

  it("rejects malformed IDs without a provider prefix", () => {
    expect(isRoutableByOpencodeGateway("kimi-k2.6")).toBe(false);
    expect(isRoutableByOpencodeGateway("")).toBe(false);
  });
});
