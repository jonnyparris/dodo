import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createAllowlistFetcher } from "./outbound";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { stateTools } from "@cloudflare/shell/workers";
import { generateText, streamText, stepCountIs, type ModelMessage } from "ai";
import type { Workspace } from "@cloudflare/shell";
import type { AppConfig, Env } from "./types";

const MAX_TOOL_STEPS = 10;

export interface AgenticResult {
  gateway: string;
  model: string;
  steps: number;
  text: string;
  tokenInput: number;
  tokenOutput: number;
  toolCalls: Array<{ code: string; result: unknown }>;
}

function trimBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function buildProvider(config: AppConfig, env: Env) {
  const isOpencode = config.activeGateway === "opencode";
  const baseURL = isOpencode
    ? `${trimBaseUrl(config.opencodeBaseURL)}`
    : `${trimBaseUrl(config.aiGatewayBaseURL)}`;

  const headers: Record<string, string> = isOpencode
    ? { "cf-access-token": env.OPENCODE_GATEWAY_TOKEN ?? "" }
    : { "x-api-key": env.AI_GATEWAY_KEY ?? "" };

  return createOpenAICompatible({
    baseURL,
    headers,
    includeUsage: true,
    name: config.activeGateway,
  });
}

function buildTools(env: Env, workspace: Workspace): Record<string, ReturnType<typeof createCodeTool>> {
  const tools: Record<string, ReturnType<typeof createCodeTool>> = {};

  if (env.LOADER) {
    const executor = new DynamicWorkerExecutor({
      globalOutbound: createAllowlistFetcher(env),
      loader: env.LOADER,
      timeout: 30_000,
    });

    tools.codemode = createCodeTool({
      executor,
      tools: [stateTools(workspace)],
    });
  }

  return tools;
}

function buildMessages(messages: Array<{ content: string; role: string }>): ModelMessage[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ content: m.content, role: m.role as "user" | "assistant" }));
}

function extractToolCalls(steps: Array<{ toolCalls: unknown[]; toolResults: unknown[] }>): AgenticResult["toolCalls"] {
  const toolCalls: AgenticResult["toolCalls"] = [];
  for (const step of steps) {
    for (const call of step.toolCalls) {
      const args = "args" in (call as Record<string, unknown>) ? ((call as Record<string, unknown>).args as unknown) : undefined;
      const code = typeof args === "object" && args !== null && "code" in args ? String((args as { code: string }).code) : "";
      const toolCallId = "toolCallId" in (call as Record<string, unknown>) ? (call as Record<string, unknown>).toolCallId : undefined;
      const toolResult = step.toolResults.find((r) => "toolCallId" in (r as Record<string, unknown>) && (r as Record<string, unknown>).toolCallId === toolCallId);
      const resultValue = toolResult && "result" in (toolResult as Record<string, unknown>) ? (toolResult as Record<string, unknown>).result : null;
      toolCalls.push({ code, result: resultValue });
    }
  }
  return toolCalls;
}

/**
 * Non-streaming agentic chat. Used for async prompts and cron callbacks.
 */
export async function runAgenticChat(input: {
  config: AppConfig;
  env: Env;
  messages: Array<{ content: string; role: "assistant" | "system" | "tool" | "user" }>;
  signal?: AbortSignal;
  systemPrompt: string;
  workspace: Workspace;
}): Promise<AgenticResult> {
  const provider = buildProvider(input.config, input.env);
  const model = provider.chatModel(input.config.model);
  const tools = buildTools(input.env, input.workspace);

  const result = await generateText({
    abortSignal: input.signal,
    stopWhen: stepCountIs(MAX_TOOL_STEPS),
    system: input.systemPrompt,
    messages: buildMessages(input.messages),
    model,
    temperature: 0.2,
    tools,
  });

  return {
    gateway: input.config.activeGateway,
    model: input.config.model,
    steps: result.steps.length,
    text: result.text,
    tokenInput: result.usage?.inputTokens ?? 0,
    tokenOutput: result.usage?.outputTokens ?? 0,
    toolCalls: extractToolCalls(result.steps as Array<{ toolCalls: unknown[]; toolResults: unknown[] }>),
  };
}

/**
 * Streaming agentic chat. Used for synchronous /message endpoint.
 * Calls onTextDelta for each token chunk and onToolCall for each tool invocation.
 * Returns the full AgenticResult once the stream is consumed.
 */
export async function streamAgenticChat(input: {
  config: AppConfig;
  env: Env;
  messages: Array<{ content: string; role: "assistant" | "system" | "tool" | "user" }>;
  onTextDelta: (delta: string) => void;
  onToolCall: (tc: { code: string; result: unknown }) => void;
  signal?: AbortSignal;
  systemPrompt: string;
  workspace: Workspace;
}): Promise<AgenticResult> {
  const provider = buildProvider(input.config, input.env);
  const model = provider.chatModel(input.config.model);
  const tools = buildTools(input.env, input.workspace);

  const result = streamText({
    abortSignal: input.signal,
    stopWhen: stepCountIs(MAX_TOOL_STEPS),
    system: input.systemPrompt,
    messages: buildMessages(input.messages),
    model,
    temperature: 0.2,
    tools,
    onStepFinish: (event) => {
      const stepToolCalls = extractToolCalls([event as unknown as { toolCalls: unknown[]; toolResults: unknown[] }]);
      for (const tc of stepToolCalls) {
        input.onToolCall(tc);
      }
    },
  });

  for await (const delta of result.textStream) {
    input.onTextDelta(delta);
  }

  const [text, totalUsage, steps] = await Promise.all([result.text, result.totalUsage, result.steps]);

  return {
    gateway: input.config.activeGateway,
    model: input.config.model,
    steps: steps.length,
    text,
    tokenInput: totalUsage?.inputTokens ?? 0,
    tokenOutput: totalUsage?.outputTokens ?? 0,
    toolCalls: extractToolCalls(steps as Array<{ toolCalls: unknown[]; toolResults: unknown[] }>),
  };
}
