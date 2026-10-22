import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { AgentProfile } from "./agent-profile";
import {
  EXPLORE_PROFILE,
  TASK_PROFILE,
  resolveProfileModel,
} from "./agent-profile";
import { log } from "./logger";
import { withModelBudget } from "./model-budget-fetch";
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

/**
 * Constant on purpose: the marker sits right after the first user message,
 * so any per-step change here (e.g. a dropped-message count) would break
 * the provider's prompt-cache prefix on every step.
 */
const PRUNE_MARKER: ModelMessage = {
  role: "user",
  content:
    "[system: earlier assistant/tool messages were pruned to keep your input token count bounded. If you need information from those steps, call the relevant tool again — don't try to reconstruct the content.]",
};

/**
 * Number of leading groups to drop when `groupCount` assistant+tool groups
 * follow the first user message. Drops in whole chunks of `windowSize`, so
 * the cut point (and with it the prompt prefix) only moves once every
 * `windowSize` steps. Kept groups range from `windowSize` to
 * `2 * windowSize - 1`.
 */
function groupsToDrop(groupCount: number, windowSize: number): number {
  if (windowSize <= 0) return groupCount > 1 ? groupCount - 1 : 0;
  if (groupCount < 2 * windowSize) return 0;
  return Math.floor((groupCount - windowSize) / windowSize) * windowSize;
}

/**
 * Keep the first user message (goal anchor) and the most recent
 * assistant+tool groups; replace the rest with a constant marker.
 *
 * Cache-friendly: the AI SDK passes the full, unpruned history to
 * `prepareStep` on every step, so the cut point is a pure function of the
 * group count. It jumps by `windowSize` groups at a time instead of
 * sliding by one, so `[system, tools, user, marker, kept groups…]` stays a
 * stable prefix for `windowSize` steps and prompt caching (Anthropic
 * breakpoints, Workers AI prefix caching) can reuse it.
 */
export function pruneSubagentHistory(
  messages: Array<ModelMessage>,
  windowSize: number = SUBAGENT_MSG_WINDOW,
): Array<ModelMessage> {
  const firstUserIdx = messages.findIndex((m) => m.role === "user");
  if (firstUserIdx < 0) return messages;

  // Group starts: every assistant message after the first user message.
  // Anything between the first user message and the first assistant
  // message belongs to the first group.
  const starts: number[] = [];
  for (let i = firstUserIdx + 1; i < messages.length; i++) {
    if (messages[i].role === "assistant") starts.push(i);
  }
  if (starts.length > 0 && starts[0] !== firstUserIdx + 1) starts[0] = firstUserIdx + 1;

  const drop = groupsToDrop(starts.length, windowSize);
  if (drop <= 0) return messages;

  const head = messages.slice(0, firstUserIdx + 1);
  const tail = messages.slice(starts[drop]);
  return [...head, PRUNE_MARKER, ...tail];
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

// ─── Anthropic prompt caching, native Messages API ───
//
// AI Gateway's unified `/compat/chat/completions` endpoint drops every
// `cache_control` marker before the request reaches Anthropic (system,
// tool and message markers alike; measured 2026-10-21: identical 17k-token
// prefixes billed at full input price with no cache fields in usage).
// The provider-native `/anthropic/v1/messages` endpoint keeps them: the same
// prefix read back from cache at ~10% of the price. So Anthropic subagent
// calls on AI Gateway go native, and this transform adds the markers.

const ANTHROPIC_MAX_CACHE_BREAKPOINTS = 4;
const EPHEMERAL = { type: "ephemeral" } as const;

function hasCacheControl(value: unknown): boolean {
  return !!value && typeof value === "object" && "cache_control" in (value as object);
}

/** A message block carries a marker itself or, for tool_result, in its own content. */
function blockHasCacheControl(block: unknown): boolean {
  if (hasCacheControl(block)) return true;
  const inner = (block as { content?: unknown } | null)?.content;
  return Array.isArray(inner) && inner.some(hasCacheControl);
}

function countCacheMarkers(body: Record<string, unknown>): number {
  let n = 0;
  if (Array.isArray(body.system)) n += body.system.filter(hasCacheControl).length;
  if (Array.isArray(body.tools)) n += body.tools.filter(hasCacheControl).length;
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages as Array<Record<string, unknown>>) {
      if (!Array.isArray(msg?.content)) continue;
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (hasCacheControl(block)) n++;
        // tool_result blocks can carry their own marked content blocks.
        if (Array.isArray(block?.content)) n += block.content.filter(hasCacheControl).length;
      }
    }
  }
  return n;
}

/**
 * Add Anthropic cache breakpoints to a native Messages API body: end of
 * system, last tool, and the last cacheable block of the last message.
 * Marking the last message means each step of a tool loop reads the
 * previous step's prefix from cache instead of re-paying for it.
 * Never exceeds Anthropic's limit of 4 breakpoints per request.
 */
export function addAnthropicMessagesCacheMarkers(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  let budget = ANTHROPIC_MAX_CACHE_BREAKPOINTS - countCacheMarkers(body);

  if (budget > 0 && typeof out.system === "string" && out.system.length > 0) {
    out.system = [{ type: "text", text: out.system, cache_control: EPHEMERAL }];
    budget--;
  } else if (budget > 0 && Array.isArray(out.system) && out.system.length > 0 && !out.system.some(hasCacheControl)) {
    const last = out.system[out.system.length - 1];
    if (last && typeof last === "object") {
      out.system = [...out.system.slice(0, -1), { ...(last as object), cache_control: EPHEMERAL }];
      budget--;
    }
  }

  if (budget > 0 && Array.isArray(out.tools) && out.tools.length > 0 && !out.tools.some(hasCacheControl)) {
    const tools = out.tools as unknown[];
    const last = tools[tools.length - 1];
    if (last && typeof last === "object") {
      out.tools = [...tools.slice(0, -1), { ...(last as object), cache_control: EPHEMERAL }];
      budget--;
    }
  }

  // Pruned histories get this breakpoint too: pruneSubagentHistory moves its
  // cut only once per prune window, so the pruned prefix is stable and the
  // next step reads it. Only the step just before each cut move pays a cache
  // write that is never read.
  if (budget > 0 && Array.isArray(out.messages) && out.messages.length > 0) {
    const messages = out.messages as Array<Record<string, unknown>>;
    const idx = messages.length - 1;
    const msg = messages[idx];
    let content: unknown = msg?.content;
    if (typeof content === "string" && content.length > 0) {
      content = [{ type: "text", text: content }];
    }
    if (Array.isArray(content) && !content.some(blockHasCacheControl)) {
      // Thinking blocks can't carry cache_control; mark the last block that can.
      for (let i = content.length - 1; i >= 0; i--) {
        const block = content[i] as Record<string, unknown> | undefined;
        if (!block || typeof block !== "object") continue;
        if (block.type === "thinking" || block.type === "redacted_thinking") continue;
        const marked = [...content];
        marked[i] = { ...block, cache_control: EPHEMERAL };
        out.messages = [...messages.slice(0, idx), { ...msg, content: marked }];
        break;
      }
    }
  }

  return out;
}

/**
 * Native Anthropic base URL for an AI Gateway unified base URL, e.g.
 * `.../v1/{account}/{gateway}/compat` → `.../v1/{account}/{gateway}/anthropic`
 * (pi-ai's Anthropic SDK appends `/v1/messages`). Undefined off AI Gateway or
 * when the path isn't AI Gateway's `/v1/{account}/{gateway}/compat` shape,
 * so a custom proxy that happens to end in `/compat` keeps the
 * OpenAI-compatible path. Shared by the main session (src/pi/models.ts) and
 * explore/task subagents so both route Anthropic the same way.
 */
export function anthropicGatewayBaseUrl(config: Pick<AppConfig, "activeGateway" | "aiGatewayBaseURL">): string | undefined {
  const parts = anthropicGatewayUrlParts(config);
  return parts ? `${parts.prefix}${parts.search}` : undefined;
}

/**
 * Same as {@link anthropicGatewayBaseUrl} but with the `/v1` the AI SDK's
 * `@ai-sdk/anthropic` expects in its baseURL (it appends `/messages`).
 */
export function anthropicNativeBaseURL(config: Pick<AppConfig, "activeGateway" | "aiGatewayBaseURL">): string | undefined {
  const parts = anthropicGatewayUrlParts(config);
  return parts ? `${parts.prefix}/v1${parts.search}` : undefined;
}

function anthropicGatewayUrlParts(
  config: Pick<AppConfig, "activeGateway" | "aiGatewayBaseURL">,
): { prefix: string; search: string } | undefined {
  if (config.activeGateway !== "ai-gateway" || !config.aiGatewayBaseURL) return undefined;
  let url: URL;
  try {
    url = new URL(config.aiGatewayBaseURL);
  } catch {
    return undefined;
  }
  const path = trimBaseUrl(url.pathname);
  if (!/^\/v1\/[^/]+\/[^/]+\/compat$/.test(path)) return undefined;
  return { prefix: `${url.origin}${path.slice(0, -"/compat".length)}/anthropic`, search: url.search };
}

/**
 * fetch for the native Anthropic route. Drops `x-api-key`: the AI SDK always
 * sends one, and AI Gateway forwards a key it doesn't recognise to Anthropic
 * as bring-your-own-key, which fails. Auth is `cf-aig-authorization` only.
 * Adds cache breakpoints to the JSON body.
 */
export const anthropicGatewayFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  headers.delete("x-api-key");
  let body = init?.body;
  if (typeof body === "string") {
    try {
      body = JSON.stringify(addAnthropicMessagesCacheMarkers(JSON.parse(body)));
    } catch {
      // Not JSON: send it untouched.
    }
  }
  return fetch(input, { ...init, headers, body });
};

function buildAnthropicNativeProvider(baseURL: string, env: Env, sessionAffinity?: string) {
  const anthropic = createAnthropic({
    baseURL,
    apiKey: "unused",
    headers: {
      "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_KEY ?? ""}`,
      // sessionAffinity is the parent session id: tag the gateway log with it.
      ...aigMetadataHeader(sessionAffinity, "subagent"),
    },
    fetch: anthropicGatewayFetch,
  });
  // Dodo ids are `anthropic/claude-…`; the native endpoint wants `claude-…`.
  const model = (modelId: string): LanguageModel => anthropic.languageModel(modelId.replace(/^anthropic\//, ""));
  return Object.assign((modelId: string) => model(modelId), {
    chatModel: model,
    languageModel: (modelId: string, _cfg?: unknown) => model(modelId),
  });
}

// ─── Gateway / provider helpers ───

function trimBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * AI Gateway log metadata for one Dodo request. Lets bench/model-ab.ts (and
 * anyone reading the gateway logs) split cost by session and by main model vs
 * subagent, even when two sessions run the same model at the same time.
 */
export function aigMetadataHeader(sessionId: string | undefined, role: "main" | "subagent"): Record<string, string> {
  return sessionId ? { "cf-aig-metadata": JSON.stringify({ dodo_session: sessionId, dodo_role: role }) } : {};
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

export function buildProviderForModel(
  modelId: string,
  config: AppConfig,
  env: Env,
  sessionAffinity?: string,
) {
  const nativeAnthropic = modelId.startsWith("anthropic/") ? anthropicNativeBaseURL(config) : undefined;
  if (nativeAnthropic) return buildAnthropicNativeProvider(nativeAnthropic, env, sessionAffinity);

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
        // Workers AI prefix caching is per-replica. Without a stable
        // affinity key, consecutive steps of one conversation land on
        // different replicas and re-pay full prefill every step.
        ...(sessionAffinity ? { "x-session-affinity": sessionAffinity } : {}),
        // sessionAffinity is the parent session id: tag the gateway log with it.
        ...aigMetadataHeader(sessionAffinity, "subagent"),
      };

  const provider = createOpenAICompatible({
    baseURL,
    headers,
    includeUsage: true,
    name: effectiveGateway,
    transformRequestBody: addAnthropicCacheMarkers,
    // Workers AI models: draw from the per-model budget shared with main
    // turns, leaving the main-turn reserve alone (src/model-budget.ts).
    fetch: withModelBudget((input, init) => fetch(input, init), {
      env,
      gateway: effectiveGateway,
      modelId,
      priority: "subagent",
      onWait: (info) => log("info", "subagent: waiting for model capacity", { sessionId: sessionAffinity, ...info, waitMs: Math.round(info.waitMs) }),
    }),
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
  /**
   * Stable conversation key for Workers AI prefix-cache affinity
   * (x-session-affinity). Pass the parent session id from facets.
   */
  sessionAffinity?: string;
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
    sessionAffinity: input.sessionAffinity,
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
  sessionAffinity?: string;
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
  const provider = buildProviderForModel(input.model, input.config, input.env, input.sessionAffinity);
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
