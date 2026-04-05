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
