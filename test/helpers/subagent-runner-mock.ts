import { vi } from "vitest";

// Re-export constants verbatim so facet tests see the same budgets.
export const EXPLORE_MAX_STEPS = 16;
export const EXPLORE_TIMEOUT_MS = 60_000;
export const TASK_MAX_STEPS = 20;
export const TASK_TIMEOUT_MS = 180_000;
export const TASK_FACET_TIMEOUT_MS = 600_000;

export const EXPLORE_SYSTEM_PROMPT = "You are a search assistant (mock).";
export const TASK_SYSTEM_PROMPT = "You are a focused subagent (mock).";

// Re-export the hint verbatim so failure-path assertions work in tests
// that mock the runner. Keeping it identical to the real export ensures
// `expect(summary).toContain(EXPLORE_FALLBACK_HINT)` is a meaningful check.
export const EXPLORE_FALLBACK_HINT = [
  "",
  "Recovery: explore is unavailable on this call. Continue the task using `list`,",
  "`find`, `grep`, and `read` directly — they are always available. If the",
  "workspace appears empty, the repo has not been cloned yet; use `git_clone`",
  "or `git_clone_known` first. Do NOT report the task as impossible just",
  "because explore failed.",
].join("\n");

// Pass-through helpers — real behaviour is fine for tests since they
// touch no I/O.
export function capToolOutputs<T extends Record<string, unknown>>(tools: T): T {
  return tools;
}

export function subagentPrepareStep(_options?: { windowSize?: number }) {
  return () => ({});
}

export function pruneSubagentHistory<T extends Array<unknown>>(messages: T): T {
  return messages;
}

function getExploreModel(mainModel: string): string {
  if (mainModel.startsWith("anthropic/")) return "anthropic/claude-haiku-4-5";
  if (mainModel.startsWith("openai/")) return "openai/gpt-4.1-mini";
  return mainModel;
}

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
  [Symbol.toPrimitive]: () => "mock-provider",
}));

export const runSubagent = vi.fn().mockImplementation(async (input: {
  kind: "explore" | "task";
  prompt: string;
  model: string;
}) => {
  return {
    finalText: `${input.model}:${input.prompt}`,
    steps: 1,
    toolCalls: [],
    stoppedReason: "tool-call-final",
    transcript: [
      { role: "user", content: input.prompt },
      { role: "assistant", content: `${input.model}:${input.prompt}` },
    ],
    tokenInput: 1,
    tokenOutput: 1,
  };
});

// Profile-aware entry point — facet DOs and the in-process subagent
// tool factory both call `runSubagentForProfile(profile, input)`. The
// mock forwards to the same default shape used by `runSubagent` so
// existing assertions on the returned transcript still work.
export const runSubagentForProfile = vi.fn().mockImplementation(async (
  profile: { kind: "explore" | "task" },
  input: { prompt: string; model: string },
) => {
  return runSubagent({ kind: profile.kind, prompt: input.prompt, model: input.model });
});

// ─── Internal helpers copied from agentic-mock ───

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
