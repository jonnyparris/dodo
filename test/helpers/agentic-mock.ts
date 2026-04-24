import { vi } from "vitest";

type PromptPart = { type?: string; text?: string };
type PromptMessage = { role?: string; content?: unknown };

function extractUserText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  const messages = prompt as PromptMessage[];
  const lastUser = [...messages].reverse().find((msg) => msg.role === "user");
  if (!lastUser) return "";
  if (!Array.isArray(lastUser.content)) return "";
  return (lastUser.content as PromptPart[])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join(" ")
    .trim();
}

function makeText(gateway: string, prompt: string): string {
  return `${gateway}:${prompt}`;
}

function shouldFail(prompt: string): boolean {
  return prompt.includes("This should fail") || prompt.includes("This will fail");
}

function makeStream(text: string): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "t1" });
      controller.enqueue({ type: "text-delta", id: "t1", delta: text });
      controller.enqueue({ type: "text-end", id: "t1" });
      controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
      controller.close();
    },
  });
}

let releaseSlowPrompt: (() => void) | null = null;

async function waitForSlowPrompt(_abortSignal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    releaseSlowPrompt = () => {
      resolve();
    };
  });
  releaseSlowPrompt = null;
}

export function releaseMockSlowPrompt(): void {
  releaseSlowPrompt?.();
  releaseSlowPrompt = null;
}

export function resetMockAgentic(): void {
  releaseSlowPrompt = null;
  buildProvider.mockClear();
  buildToolsForThink.mockClear();
}

export const buildProvider = vi.fn().mockImplementation((config: { activeGateway?: string }) => ({
  chatModel: vi.fn().mockImplementation((modelId: string) => ({
    specificationVersion: "v2" as const,
    provider: "mock-provider",
    modelId,
    supportedUrls: {},
    doGenerate: async (options: { prompt: unknown }) => {
      const prompt = extractUserText(options.prompt);
      if (shouldFail(prompt)) {
        throw new Error("Gateway timeout");
      }
      return {
        content: [{ type: "text", text: makeText(config.activeGateway ?? "opencode", prompt) }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    doStream: async (options: { prompt: unknown; abortSignal?: AbortSignal }) => {
      const prompt = extractUserText(options.prompt);
      if (shouldFail(prompt)) {
        // Return an error stream part instead of throwing — avoids DO I/O
        // isolation errors in vitest-pool-workers when an exception crosses
        // Durable Object boundaries.
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "error", error: "Gateway timeout" });
              controller.enqueue({ type: "finish", finishReason: "error", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
              controller.close();
            },
          }),
        };
      }
      if (prompt.includes("slow async prompt")) {
        await waitForSlowPrompt(options.abortSignal);
      }
      return {
        stream: makeStream(makeText(config.activeGateway ?? "opencode", prompt)),
      };
    },
  })),
}));

export const buildToolsForThink = vi.fn().mockReturnValue({});

// ─── Phase 2 additions — facet path exports ─────────────────────────────
//
// The ExploreAgent facet imports these symbols directly from "../agentic".
// When a test mocks the whole agentic module, every symbol the facet
// imports must exist on the mock; otherwise the facet ends up with
// `undefined` functions and crashes at call time inside the DO, which
// surfaces as opaque I/O errors in vitest-pool-workers.
//
// `buildProviderForModel` returns the same mock chat model as
// `buildProvider` so facet `generateText` calls produce deterministic,
// test-shaped text without touching any network.

export const buildProviderForModel = vi.fn().mockImplementation((modelId: string, config: { activeGateway?: string }) => ({
  chatModel: (id: string) => ({
    specificationVersion: "v2" as const,
    provider: "mock-provider",
    modelId: id,
    supportedUrls: {},
    doGenerate: async (options: { prompt: unknown }) => {
      const prompt = extractUserText(options.prompt);
      if (shouldFail(prompt)) {
        throw new Error("Gateway timeout");
      }
      return {
        content: [{ type: "text", text: makeText(config.activeGateway ?? "opencode", prompt) }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    doStream: async (options: { prompt: unknown }) => {
      const prompt = extractUserText(options.prompt);
      return {
        stream: makeStream(makeText(config.activeGateway ?? "opencode", prompt)),
      };
    },
  }),
  chat: () => ({}),
  completion: () => ({}),
  textEmbedding: () => ({}),
  image: () => ({}),
  languageModel: () => ({}),
  // Also satisfy the provider "callable" shape used by the openai-compat
  // wrapper so downstream code that probes for `provider(modelId)` doesn't
  // crash.
  [Symbol.toPrimitive]: () => "mock-provider",
}));

// Explore tool constants — re-exported verbatim so the facet sees the
// same system prompt / step budget / timeout values it would see in
// production. Kept inline rather than re-imported because this mock
// deliberately severs the link to the real agentic module.
export const EXPLORE_SYSTEM_PROMPT = "You are a search assistant (mock).";
export const EXPLORE_MAX_STEPS = 16;
export const EXPLORE_TIMEOUT_MS = 60_000;

export const TASK_SYSTEM_PROMPT = "You are a focused subagent (mock).";
export const TASK_MAX_STEPS = 20;
export const TASK_TIMEOUT_MS = 180_000;
export const TASK_FACET_TIMEOUT_MS = 600_000;

// Pass-through helpers — real behaviour is fine for tests since they
// touch no I/O.
export function capToolOutputs<T extends Record<string, unknown>>(tools: T): T {
  return tools;
}

// Prune-step helper — the mock uses a pass-through that never prunes so
// tests remain deterministic regardless of message-history size. The real
// pruning logic is covered directly in test/subagent-prune-unit.test.ts.
export function subagentPrepareStep(_options?: { windowSize?: number }) {
  return () => ({});
}

export function getExploreModel(mainModel: string): string {
  if (mainModel.startsWith("anthropic/")) return "anthropic/claude-haiku-4-5";
  if (mainModel.startsWith("openai/")) return "openai/gpt-4.1-mini";
  return mainModel;
}

// Keep the production resolver semantics in the mock so facet tests see
// the same precedence as the real path (per-call > session default >
// heuristic).
export function resolveSubagentModel(
  args: Record<string, unknown>,
  sessionDefault: string | undefined,
  mainModel: string,
): string {
  const rawArgModel = args.model;
  if (typeof rawArgModel === "string" && rawArgModel.trim().length > 0) {
    return rawArgModel.trim();
  }
  if (typeof sessionDefault === "string" && sessionDefault.trim().length > 0) {
    return sessionDefault.trim();
  }
  return getExploreModel(mainModel);
}
