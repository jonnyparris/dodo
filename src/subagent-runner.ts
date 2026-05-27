import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import type { AgentProfile } from "./agent-profile";
import {
  EXPLORE_PROFILE,
  TASK_PROFILE,
  resolveProfileModel,
} from "./agent-profile";
import { lookupResultSchema } from "./result-schema-registry";
import { generateStructured, type StructuredMode } from "./structured-output";
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

export function resolveWireModelId(modelId: string, _activeGateway: "opencode" | "ai-gateway"): string {
  // Workers AI models (@cf/…) must be wire-prefixed with `workers-ai/` on
  // BOTH gateways. The AI Gateway and the OpenCode gateway both proxy these
  // via Cloudflare's unified OpenAI-compatible endpoint, which expects the
  // `workers-ai/@cf/<vendor>/<model>` form.
  if (modelId.startsWith("@cf/")) {
    return `workers-ai/${modelId}`;
  }
  return modelId;
}

function resolveGatewayForModel(
  _modelId: string,
  mainGateway: "opencode" | "ai-gateway",
): "opencode" | "ai-gateway" {
  // Both gateways route Workers AI models. Honour the user's gateway choice.
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

// ─── Subagent profile re-exports ───
// The runtime constants are defined on agent-profile.ts as part of
// EXPLORE_PROFILE / TASK_PROFILE. The named re-exports below keep
// the historical import surface stable for callers (tests, agentic.ts,
// the facet DOs) while the profile remains the single source of truth.

export const EXPLORE_MAX_STEPS = EXPLORE_PROFILE.maxSteps;
export const EXPLORE_TIMEOUT_MS = EXPLORE_PROFILE.timeoutMs;
export const EXPLORE_SYSTEM_PROMPT = EXPLORE_PROFILE.systemPrompt;
// The fallback hint lives on the profile; the non-null assertion is
// safe because EXPLORE_PROFILE always declares one. We keep the named
// export so callers can render it next to free-form error messages
// without having to import the profile and remember the field name.
export const EXPLORE_FALLBACK_HINT = EXPLORE_PROFILE.fallbackHint as string;

export const TASK_MAX_STEPS = TASK_PROFILE.maxSteps;
export const TASK_TIMEOUT_MS = TASK_PROFILE.timeoutMs;
// Facet timeout is profile-optional (only TASK has one today). The
// fallback to TASK_PROFILE.timeoutMs keeps the export defined when a
// future profile drops the facet override.
export const TASK_FACET_TIMEOUT_MS = TASK_PROFILE.facetTimeoutMs ?? TASK_PROFILE.timeoutMs;
export const TASK_SYSTEM_PROMPT = TASK_PROFILE.systemPrompt;

/**
 * Resolve a subagent's model id from the caller's args, the
 * per-session default, and the main session's model id — delegating
 * to the profile's own resolution strategy.
 *
 * Historical name kept for callers that still pass an `args` record
 * directly. New code should reach for `resolveProfileModel` and pick
 * the profile up-front.
 *
 * @deprecated Use `resolveProfileModel` with an explicit profile.
 */
export function resolveSubagentModel(
  args: Record<string, unknown>,
  sessionDefault: string | undefined,
  mainModel: string,
  profile: AgentProfile = EXPLORE_PROFILE,
): string {
  return resolveProfileModel(profile, args, sessionDefault, mainModel);
}

// ─── Subagent runner ───

/**
 * Runtime-only inputs to a subagent run. Everything that varies per
 * call lives here; the policy (prompt, step budget, timeouts) comes
 * from the `AgentProfile`.
 */
export interface SubagentRunInput {
  /** The natural-language prompt the subagent's model sees. */
  prompt: string;
  /** Resolved model id to invoke (see `resolveProfileModel`). */
  model: string;
  /** Per-session config — supplies provider, gateway, base URLs. */
  config: AppConfig;
  /** Tool subset the subagent can call. */
  toolset: ToolSet;
  /**
   * Override for the wall-clock cap. Falls back to the profile's
   * timeoutMs (or facetTimeoutMs when running inside a facet DO).
   */
  timeoutMs?: number;
  /**
   * Optional prepareStep hook — defaults to the standard subagent
   * history-pruning window. Override only when a caller needs custom
   * message rewriting (e.g. forced tool-call orderings in tests).
   */
  prepareStep?: ({ messages }: { messages: Array<ModelMessage> }) => { messages?: Array<ModelMessage> };
  env: Env;
  signal?: AbortSignal;
  /**
   * Optional structured-output schema name (from the result-schema
   * registry). When set, the runner spends one extra LLM call after
   * the tool-using loop finishes to coerce `finalText` into the
   * schema's shape. The validated object lands on
   * `SubagentResult.structured`; callers consume it without re-parsing.
   *
   * Per-call overrides the profile's `defaultResultSchemaName`.
   */
  resultSchemaName?: string;
}

/**
 * Legacy invocation shape — the previous public surface. Callers that
 * supplied `systemPrompt` and `maxSteps` inline get routed through
 * `runSubagent(profile, input)` internally; existing test snapshots and
 * external imports keep working without churn.
 */
export interface SubagentInvocation extends SubagentRunInput {
  kind: "explore" | "task";
  systemPrompt: string;
  maxSteps: number;
}

/**
 * Outcome of a structured-summary pass on top of a subagent run.
 *
 * Lives alongside the free-form transcript rather than replacing it
 * so callers that opt into typed results still get the human-readable
 * narrative for chat history. `ok: false` means the coercion failed
 * even after retry — the caller should fall back to `finalText`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SubagentStructured =
  | { ok: true; data: unknown; mode: StructuredMode; attempts: number; tokenInput: number; tokenOutput: number }
  | { ok: false; lastError: string; rawText: string; mode: StructuredMode; attempts: number; tokenInput: number; tokenOutput: number };

export interface SubagentResult {
  finalText: string;
  steps: number;
  toolCalls: string[];
  stoppedReason: "max-steps" | "tool-call-final" | "abort" | "timeout";
  transcript: Array<{ role: string; content: string }>;
  tokenInput: number;
  tokenOutput: number;
  /**
   * Set when the caller (or the profile) requested a typed result and
   * the runner ran the coercion pass. Undefined when no result schema
   * was requested; the caller should fall back to `finalText`.
   */
  structured?: SubagentStructured;
}

/**
 * Run a subagent against an `AgentProfile`. Preferred entry point for
 * new code — the profile owns the prompt, step count, and timeouts so
 * callers can't drift those out of sync with the other end of the
 * subagent contract (the parent DO's transcript formatting, the tool
 * description in `agentic.ts`).
 */
export function runSubagentForProfile(
  profile: AgentProfile,
  input: SubagentRunInput,
): Promise<SubagentResult> {
  return executeSubagent({
    profile,
    prompt: input.prompt,
    model: input.model,
    config: input.config,
    toolset: input.toolset,
    timeoutMs: input.timeoutMs ?? profile.timeoutMs,
    prepareStep: input.prepareStep,
    env: input.env,
    signal: input.signal,
    resultSchemaName: input.resultSchemaName ?? profile.defaultResultSchemaName,
  });
}

/**
 * Legacy entry point. Looks up the profile by `kind` and forwards. Any
 * `systemPrompt` / `maxSteps` carried on `SubagentInvocation` is
 * ignored — the profile is canonical. We accept the fields to keep
 * existing call sites compiling; the next pass will drop them in favour
 * of `runSubagentForProfile`.
 */
export async function runSubagent(input: SubagentInvocation): Promise<SubagentResult> {
  const profile = input.kind === "explore" ? EXPLORE_PROFILE : TASK_PROFILE;
  return runSubagentForProfile(profile, input);
}

interface SubagentExecuteInput {
  profile: AgentProfile;
  prompt: string;
  model: string;
  config: AppConfig;
  toolset: ToolSet;
  timeoutMs: number;
  prepareStep?: ({ messages }: { messages: Array<ModelMessage> }) => { messages?: Array<ModelMessage> };
  env: Env;
  signal?: AbortSignal;
  resultSchemaName?: string;
}

async function executeSubagent(input: SubagentExecuteInput): Promise<SubagentResult> {
  const provider = buildProviderForModel(input.model, input.config, input.env);
  const model = provider.chatModel(input.model);

  const messages = [{ role: "user" as const, content: input.prompt }];

  try {
    const result = await generateText({
      model,
      system: input.profile.systemPrompt,
      messages,
      tools: input.toolset,
      stopWhen: stepCountIs(input.profile.maxSteps),
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
    const stoppedReason = steps >= input.profile.maxSteps ? "max-steps" : "tool-call-final";

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

    let structured: SubagentStructured | undefined;
    if (input.resultSchemaName && result.text.trim().length > 0) {
      // One coercion pass over the subagent's free-form final text.
      // We deliberately don't pipe the schema into the multi-step loop
      // (the AI SDK can't combine `tools` + `generateObject`), so the
      // subagent does its tool-driven investigation first and a small
      // structured pass distils the summary into the requested shape.
      // The extra call is one round-trip; tokens used are accounted
      // for separately on `structured.tokenInput`/`tokenOutput`.
      structured = await coerceStructured({
        schemaName: input.resultSchemaName,
        model,
        finalText: result.text,
        modelId: input.model,
        signal: input.signal,
      });
    }

    return {
      finalText: result.text,
      steps,
      toolCalls,
      stoppedReason,
      transcript,
      tokenInput: totalInput,
      tokenOutput: totalOutput,
      structured,
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

/**
 * Coerce a subagent's free-form `finalText` into the registered schema
 * named `schemaName`. Reuses the same chat model the subagent ran on
 * so we don't take a second provider hop for a structured pass that
 * the parent model could itself produce.
 *
 * The schema lookup throws on unknown names — that's a configuration
 * error (a typo in a profile or per-call arg) and we want it loud.
 */
async function coerceStructured(input: {
  schemaName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any;
  finalText: string;
  modelId: string;
  signal?: AbortSignal;
}): Promise<SubagentStructured> {
  const schema = lookupResultSchema(input.schemaName);
  const prompt = [
    "Distill the following subagent output into the requested schema.",
    "Do not invent fields. Use only information present in the text.",
    "",
    "Subagent output:",
    "---",
    input.finalText,
    "---",
  ].join("\n");
  const out = await generateStructured({
    modelId: input.modelId,
    model: input.model,
    schema,
    prompt,
    signal: input.signal,
    // Coercion pass is fast — give it a tighter budget so a slow
    // structured pass can't hold up the whole subagent call.
    timeoutMs: 30_000,
  });
  if (out.ok) {
    return {
      ok: true,
      data: out.data,
      mode: out.mode,
      attempts: out.attempts,
      tokenInput: out.tokenInput,
      tokenOutput: out.tokenOutput,
    };
  }
  return {
    ok: false,
    lastError: out.lastError,
    rawText: out.rawText,
    mode: out.mode,
    attempts: out.attempts,
    tokenInput: out.tokenInput,
    tokenOutput: out.tokenOutput,
  };
}
