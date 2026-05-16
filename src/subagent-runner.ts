import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import type { AppConfig, Env } from "./types";

// ─── Tool Output Caps (OpenCode Pattern #1) ───
// Cap tool output AT THE TOOL LEVEL before it enters the AI SDK message history.

const TOOL_OUTPUT_CAPS: Record<string, { maxLines?: number; maxBytes?: number; maxEntries?: number }> = {
  grep:   { maxEntries: 100 },
  find:   { maxEntries: 100 },
  list:   { maxEntries: 100 },
  read:   { maxLines: 200 },
  codemode: { maxBytes: 32_000 },
};

/** Max bytes for a codemode `logs` field; kept separate from result. */
const CODEMODE_LOGS_MAX_BYTES = 4_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = any;

export function capToolOutputs(tools: Record<string, AnyTool>): Record<string, AnyTool> {
  const wrapped: Record<string, AnyTool> = {};
  for (const [name, t] of Object.entries(tools)) {
    const caps = TOOL_OUTPUT_CAPS[name];
    if (!caps) {
      wrapped[name] = t;
      continue;
    }
    const original = t as AnyTool & { execute?: (...args: unknown[]) => unknown };
    if (!original.execute) {
      wrapped[name] = t;
      continue;
    }
    const origExecute = original.execute;
    wrapped[name] = {
      ...original,
      execute: async (...args: unknown[]) => {
        const result = await (origExecute as (...a: unknown[]) => Promise<unknown>)(...args);
        return capResult(name, result, caps);
      },
    } as AnyTool;
  }
  return wrapped;
}

function capResult(
  toolName: string,
  result: unknown,
  caps: { maxLines?: number; maxBytes?: number; maxEntries?: number },
): unknown {
  if (result === null || result === undefined) return result;

  if (typeof result === "object" && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;

    if (caps.maxEntries) {
      for (const key of ["entries", "matches", "files"]) {
        if (Array.isArray(obj[key]) && (obj[key] as unknown[]).length > caps.maxEntries) {
          const original = obj[key] as unknown[];
          const capped = original.slice(0, caps.maxEntries);
          return {
            ...obj,
            [key]: capped,
            _truncated: `Showing ${caps.maxEntries} of ${original.length} results. Use a more specific pattern to narrow results.`,
          };
        }
      }
    }

    if (caps.maxLines || caps.maxBytes) {
      const content = typeof obj.content === "string" ? obj.content : null;
      if (content) {
        const capped = capText(content, caps.maxLines ?? Infinity, caps.maxBytes ?? Infinity);
        if (capped !== content) {
          const lines = content.split("\n").length;
          return {
            ...obj,
            content: capped,
            _truncated: `Output capped. Showing partial content of ${lines} total lines. Use read with offset/limit to view specific sections.`,
          };
        }
      }
    }
  }

  if (typeof result === "string" && (caps.maxLines || caps.maxBytes)) {
    const capped = capText(result, caps.maxLines ?? Infinity, caps.maxBytes ?? Infinity);
    if (capped !== result) {
      const lines = result.split("\n").length;
      return capped + `\n\n[Output capped. ${lines} total lines. Use read with offset/limit to view specific sections.]`;
    }
  }

  return result;
}

function middleTruncate(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text;
  const marker = "\n[... truncated %d bytes. Pass `select` to codemode to project only the fields you need. ...]\n";
  const overhead = marker.length + 12;
  const headBudget = Math.floor((maxBytes - overhead) * 0.6);
  const tailBudget = Math.floor((maxBytes - overhead) * 0.4);
  if (headBudget <= 0 || tailBudget <= 0) return text.slice(0, maxBytes);
  const head = text.slice(0, headBudget);
  const tail = text.slice(-tailBudget);
  const dropped = text.length - headBudget - tailBudget;
  return `${head}${marker.replace("%d", String(dropped))}${tail}`;
}

export function capCodemodeResult(result: unknown, maxBytes: number): unknown {
  if (!result || typeof result !== "object") return result;
  const obj = result as { code?: unknown; result?: unknown; logs?: unknown };
  const out: Record<string, unknown> = { ...obj };

  if (obj.result !== undefined) {
    let serialized: string;
    try {
      serialized = typeof obj.result === "string" ? obj.result : JSON.stringify(obj.result);
    } catch {
      serialized = String(obj.result);
    }
    if (serialized.length > maxBytes) {
      out.result = middleTruncate(serialized, maxBytes);
      out._truncated = `codemode result exceeded ${maxBytes} bytes (was ${serialized.length}). Result was serialized to string and middle-truncated. Use \`select\` to return only the fields you need.`;
    }
  }

  if (typeof obj.logs === "string" && obj.logs.length > CODEMODE_LOGS_MAX_BYTES) {
    out.logs = middleTruncate(obj.logs, CODEMODE_LOGS_MAX_BYTES);
  }

  return out;
}

export function projectCodemodeResult(result: unknown, paths: string[]): unknown {
  if (!result || typeof result !== "object") return result;
  const obj = result as { code?: unknown; result?: unknown; logs?: unknown };
  if (obj.result === undefined) return result;

  const projected: Record<string, unknown> = {};
  for (const path of paths) {
    const value = getByPath(obj.result, path);
    if (value !== undefined) projected[path] = value;
  }

  return {
    ...obj,
    result: projected,
    _projected_paths: paths,
  };
}

function getByPath(value: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = value;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
      continue;
    }
    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
      continue;
    }
    return undefined;
  }
  return current;
}

function capText(text: string, maxLines: number, maxBytes: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines && text.length <= maxBytes) return text;

  const kept: string[] = [];
  let bytes = 0;
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const line = lines[i];
    if (bytes + line.length + 1 > maxBytes) break;
    kept.push(line);
    bytes += line.length + 1;
  }
  return kept.join("\n");
}

// ─── Subagent message-history pruning ───

const SUBAGENT_MSG_WINDOW = 4;

function makePruneMarker(droppedCount: number): ModelMessage {
  return {
    role: "user",
    content: `[system: ${droppedCount} earlier assistant/tool messages were pruned to keep your input token count bounded. If you need information from those steps, call the relevant tool again — don't try to reconstruct the content.]`,
  };
}

export function pruneSubagentHistory(
  messages: Array<ModelMessage>,
  windowSize: number = SUBAGENT_MSG_WINDOW,
): Array<ModelMessage> {
  if (messages.length <= windowSize + 1) return messages;

  const firstUserIdx = messages.findIndex((m) => m.role === "user");
  if (firstUserIdx < 0) return messages;

  const groups: Array<{ start: number; end: number }> = [];
  let cursor = messages.length;
  while (cursor > firstUserIdx + 1 && groups.length < windowSize) {
    const end = cursor;
    let start = cursor - 1;
    while (start > firstUserIdx + 1 && messages[start].role !== "assistant") {
      start--;
    }
    groups.unshift({ start, end });
    cursor = start;
  }

  if (groups.length === 0) return messages;

  const head = messages.slice(0, firstUserIdx + 1);
  const tailStart = groups[0].start;
  const dropped = tailStart - (firstUserIdx + 1);
  if (dropped <= 0) return messages;
  const tail = messages.slice(tailStart);
  return [...head, makePruneMarker(dropped), ...tail];
}

export function subagentPrepareStep(options?: { windowSize?: number }) {
  const windowSize = options?.windowSize ?? SUBAGENT_MSG_WINDOW;
  return ({ messages }: { messages: Array<ModelMessage> }) => {
    const pruned = pruneSubagentHistory(messages, windowSize);
    return pruned === messages ? {} : { messages: pruned };
  };
}

// ─── Anthropic prompt caching ───

export function addAnthropicCacheMarkers(body: Record<string, unknown>): Record<string, unknown> {
  const modelId = typeof body.model === "string" ? body.model : "";
  if (!modelId.startsWith("anthropic/") && !modelId.startsWith("claude-")) {
    return body;
  }

  const out: Record<string, unknown> = { ...body };

  if (typeof out.system === "string" && out.system.length > 0) {
    out.system = [
      { type: "text", text: out.system, cache_control: { type: "ephemeral" } },
    ];
  } else if (Array.isArray(out.system) && out.system.length > 0) {
    const hasMarker = out.system.some(
      (block) => block && typeof block === "object" && "cache_control" in (block as object),
    );
    if (!hasMarker) {
      const last = out.system[out.system.length - 1];
      if (last && typeof last === "object") {
        out.system = [
          ...out.system.slice(0, -1),
          { ...(last as object), cache_control: { type: "ephemeral" } },
        ];
      }
    }
  }

  if (Array.isArray(out.tools) && out.tools.length > 0) {
    const tools = out.tools as unknown[];
    const hasMarker = tools.some(
      (t) => t && typeof t === "object" && "cache_control" in (t as object),
    );
    if (!hasMarker) {
      const lastIdx = tools.length - 1;
      const last = tools[lastIdx];
      if (last && typeof last === "object") {
        out.tools = [
          ...tools.slice(0, lastIdx),
          { ...(last as object), cache_control: { type: "ephemeral" } },
        ];
      }
    }
  }

  if (Array.isArray(out.messages) && out.messages.length > 0) {
    const messages = out.messages as Array<Record<string, unknown>>;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role !== "user") continue;
      if (typeof msg.content === "string" && msg.content.length > 0) {
        const updated: Record<string, unknown> = {
          ...msg,
          content: [
            {
              type: "text",
              text: msg.content,
              cache_control: { type: "ephemeral" },
            },
          ],
        };
        out.messages = [...messages.slice(0, i), updated, ...messages.slice(i + 1)];
      }
      break;
    }
  }

  return out;
}

// ─── Gateway / provider helpers ───

function trimBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function resolveWireModelId(modelId: string, activeGateway: "opencode" | "ai-gateway"): string {
  if (modelId.startsWith("@cf/")) {
    if (activeGateway !== "ai-gateway") {
      throw new Error(
        `Workers AI model "${modelId}" requires the AI Gateway. ` +
        `Switch gateway to "ai-gateway" in Settings (or via update_config).`,
      );
    }
    return `workers-ai/${modelId}`;
  }
  return modelId;
}

function resolveGatewayForModel(
  modelId: string,
  mainGateway: "opencode" | "ai-gateway",
): "opencode" | "ai-gateway" {
  if (modelId.startsWith("@cf/")) return "ai-gateway";
  return mainGateway;
}

export function buildProviderForModel(modelId: string, config: AppConfig, env: Env) {
  const effectiveGateway = resolveGatewayForModel(modelId, config.activeGateway);
  const isOpencode = effectiveGateway === "opencode";
  const baseURL = isOpencode
    ? `${trimBaseUrl(config.opencodeBaseURL)}`
    : `${trimBaseUrl(config.aiGatewayBaseURL)}`;

  const headers: Record<string, string> = isOpencode
    ? { "cf-access-token": env.OPENCODE_GATEWAY_TOKEN ?? "" }
    : {
        "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_KEY ?? ""}`,
        "x-api-key": env.AI_GATEWAY_KEY ?? "",
      };

  const provider = createOpenAICompatible({
    baseURL,
    headers,
    includeUsage: true,
    name: effectiveGateway,
    transformRequestBody: addAnthropicCacheMarkers,
  });

  const translate = (m: string) => resolveWireModelId(m, effectiveGateway);
  const originalChatModel = provider.chatModel.bind(provider);
  const originalLanguageModel = provider.languageModel.bind(provider);

  return new Proxy(provider, {
    apply(_target, _thisArg, args: [string, ...unknown[]]) {
      const [modelId, ...rest] = args;
      return originalLanguageModel(translate(modelId), ...(rest as []));
    },
    get(target, prop, receiver) {
      if (prop === "chatModel") return (modelId: string) => originalChatModel(translate(modelId));
      if (prop === "languageModel") return (modelId: string, cfg?: unknown) => originalLanguageModel(translate(modelId), cfg as Parameters<typeof originalLanguageModel>[1]);
      return Reflect.get(target, prop, receiver);
    },
  });
}

// ─── Subagent constants ───

export const EXPLORE_MAX_STEPS = 16;
export const EXPLORE_TIMEOUT_MS = 60_000;

export const EXPLORE_SYSTEM_PROMPT = [
  "You are a search assistant. Your job is to find files and code relevant to the user's query.",
  "",
  "## Rules",
  "- Use grep, find, list, and read to search the workspace.",
  "- Be thorough: try multiple search terms if the first doesn't find results.",
  `- You have a hard budget of ${EXPLORE_MAX_STEPS} steps. **Reserve the last 2 steps for your summary** — at step ${EXPLORE_MAX_STEPS - 2} or earlier, stop calling tools and write your findings.`,
  "- Return a concise summary when done: file paths, relevant line numbers, and key observations.",
  "- Do NOT return full file contents — only the relevant snippets (max 10 lines per file).",
  "- If you find too many results, narrow your search with more specific patterns.",
  "- Focus on answering the user's specific question, not cataloguing everything.",
  "- Emitting SOME summary beats hitting the step limit silent. A rough summary is recoverable; no summary wastes the caller's retry budget.",
].join("\n");

const EXPLORE_MODELS: Record<string, string> = {
  "anthropic/": "anthropic/claude-haiku-4-5",
  "openai/": "openai/gpt-4.1-mini",
  "google/": "google/gemini-2.5-flash",
  "deepseek/": "deepseek/deepseek-chat",
};

function getExploreModel(mainModel: string): string {
  for (const [prefix, model] of Object.entries(EXPLORE_MODELS)) {
    if (mainModel.startsWith(prefix)) return model;
  }
  return mainModel;
}

export const TASK_MAX_STEPS = 20;
export const TASK_TIMEOUT_MS = 180_000;
export const TASK_FACET_TIMEOUT_MS = 600_000;

export const TASK_SYSTEM_PROMPT = [
  "You are a focused subagent dispatched by the main Dodo agent to handle one bounded task.",
  "",
  "## Rules",
  "- You have a subset of the main agent's tools. Use them to complete the task and ONLY the task.",
  "- Do not ask clarifying questions — make a best-effort attempt with the info given.",
  `- You have a hard budget of ${TASK_MAX_STEPS} steps. **Reserve the last 2 steps for your summary** — at step ${TASK_MAX_STEPS - 2} or earlier, stop calling tools and write your summary.`,
  "- Return a compact text summary when done. Include: what you did, paths/line numbers touched, test results if any.",
  "- Do NOT dump large tool outputs into your final message — summarize in 5-15 lines.",
  "- If you hit your step budget without finishing, report what was done and what remains. Your caller will retry.",
  "- Emitting SOME summary beats hitting the step limit silent. A rough summary is recoverable; no summary wastes the caller's retry budget.",
].join("\n");

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

// ─── Subagent runner ───

export interface SubagentInvocation {
  kind: "explore" | "task";
  prompt: string;
  model: string;
  config: AppConfig;
  toolset: ToolSet;
  systemPrompt: string;
  maxSteps: number;
  timeoutMs?: number;
  prepareStep?: ({ messages }: { messages: Array<ModelMessage> }) => { messages?: Array<ModelMessage> };
  env: Env;
  signal?: AbortSignal;
}

export interface SubagentResult {
  finalText: string;
  steps: number;
  toolCalls: string[];
  stoppedReason: "max-steps" | "tool-call-final" | "abort" | "timeout";
  transcript: Array<{ role: string; content: string }>;
  tokenInput: number;
  tokenOutput: number;
}

export async function runSubagent(input: SubagentInvocation): Promise<SubagentResult> {
  const provider = buildProviderForModel(input.model, input.config, input.env);
  const model = provider.chatModel(input.model);

  const messages = [{ role: "user" as const, content: input.prompt }];

  try {
    const result = await generateText({
      model,
      system: input.systemPrompt,
      messages,
      tools: input.toolset,
      stopWhen: stepCountIs(input.maxSteps),
      maxOutputTokens: 4000,
      prepareStep: input.prepareStep ?? subagentPrepareStep(),
      abortSignal: input.signal ?? (input.timeoutMs ? AbortSignal.timeout(input.timeoutMs) : undefined),
    });

    const steps = result.steps.length;
    const toolCalls = result.steps.flatMap((s) =>
      (s.toolCalls ?? []).map((tc) => tc.toolName),
    );
    const totalInput = result.steps.reduce((sum, s) => sum + (s.usage?.inputTokens ?? 0), 0);
    const totalOutput = result.steps.reduce((sum, s) => sum + (s.usage?.outputTokens ?? 0), 0);
    const stoppedReason = steps >= input.maxSteps ? "max-steps" : "tool-call-final";

    const transcript: Array<{ role: string; content: string }> = [
      { role: "user", content: input.prompt },
      ...result.steps.flatMap((step) => {
        const entries: Array<{ role: string; content: string }> = [];
        if (step.text) {
          entries.push({ role: "assistant", content: step.text });
        }
        for (const tc of step.toolCalls ?? []) {
          const args = (tc as { args?: unknown }).args;
          entries.push({ role: "tool", content: `${tc.toolName}: ${JSON.stringify(args)}` });
        }
        return entries;
      }),
    ];

    return {
      finalText: result.text,
      steps,
      toolCalls,
      stoppedReason,
      transcript,
      tokenInput: totalInput,
      tokenOutput: totalOutput,
    };
  } catch (error) {
    if (error instanceof DOMException) {
      if (error.name === "AbortError") {
        return {
          finalText: "",
          steps: 0,
          toolCalls: [],
          stoppedReason: "abort",
          transcript: [{ role: "user", content: input.prompt }],
          tokenInput: 0,
          tokenOutput: 0,
        };
      }
      if (error.name === "TimeoutError") {
        return {
          finalText: "",
          steps: 0,
          toolCalls: [],
          stoppedReason: "timeout",
          transcript: [{ role: "user", content: input.prompt }],
          tokenInput: 0,
          tokenOutput: 0,
        };
      }
    }
    throw error;
  }
}
