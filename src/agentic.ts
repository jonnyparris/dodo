import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { StateBackend } from "@cloudflare/shell";
import { generateText, jsonSchema, stepCountIs, tool, zodSchema, type ModelMessage } from "ai";
import { z } from "zod";
import type { Workspace } from "@cloudflare/shell";
import type { AttachmentRef } from "./attachments";
import { createWorkspaceGit, defaultAuthor, resolveRemoteToken, verifyRemoteBranch } from "./git";
import { wrapOutboundWithOwner } from "./executor";
import { createPullRequest } from "./github-pr";
import { normalizePath } from "./paths";
import { createBrowserTools } from "./browser/tools";
import type { McpGatekeeper } from "./mcp-gatekeeper";
import { getKnownRepo, listKnownRepos, parseRemoteSpec } from "./repos";
import { createWorkspaceTools, createExecuteTool } from "./think-adapter";
import type { AppConfig, Env, TodoStore } from "./types";

/** Options passed through from the coding agent into tool factories. */
/** Metadata describing an OAuth-connected MCP tool federated from the per-user hub DO. */
interface OAuthToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  serverId: string;
  displayName?: string;
}

interface BuildToolsOptions {
  authorEmail?: string;
  browserEnabled?: boolean;
  isAdminUser?: boolean;
  ownerId?: string;
  ownerEmail?: string;
  stateBackend?: StateBackend;
  mcpGatekeepers?: McpGatekeeper[];
  /**
   * OAuth MCP tools pre-fetched from the per-user hub DO. Session DOs don't
   * hold OAuth credentials locally — they pass the cached tool list here
   * and route tool calls back through `oauthToolExec`.
   */
  oauthTools?: OAuthToolInfo[];
  /**
   * Tool-call executor for OAuth MCP tools. Must route through the per-user
   * hub DO where the OAuth credentials live. Provided by CodingAgent as
   * `this.callOAuthToolViaHub`.
   */
  oauthToolExec?: (serverId: string, name: string, args: unknown) => Promise<unknown>;
  /** Session ID — required to scope attachment R2 keys. */
  sessionId?: string;
  /**
   * Fires when a tool produces image attachments. The coding agent uses this
   * to stream `tool_result_image` SSE events so the chat UI renders screenshots
   * before the assistant message finishes persisting.
   */
  onToolAttachments?: (toolCallId: string, attachments: AttachmentRef[]) => void;
  /**
   * Stable read/write surface for session-scoped todos. Backs the
   * `todo_add` / `todo_update` / `todo_list` / `todo_clear` tools.
   */
  todoStore?: TodoStore;
  /**
   * Parent CodingAgent reference — used when `config.exploreMode` or
   * `config.taskMode` is `"facet"` so the explore / task tools can
   * delegate to `runExploreFacet` / `runTaskFacet`. Typed loosely here
   * to avoid a circular type import — the concrete type is `CodingAgent`.
   */
  parentAgent?: {
    runExploreFacet: (
      name: string,
      opts: { q: string; scope?: string; model?: string },
    ) => Promise<{
      ok: true;
      facetName: string;
      summary: string;
      tokenInput: number;
      tokenOutput: number;
    }>;
    runTaskFacet: (
      name: string,
      opts: {
        prompt: string;
        scope?: string;
        model?: string;
        workspaceMode?: "shared" | "scratch";
      },
    ) => Promise<{
      ok: true;
      facetName: string;
      summary: string;
      workspaceMode: "shared" | "scratch";
      tokenInput: number;
      tokenOutput: number;
      scratchWrites?: string[];
    }>;
    /**
     * Resolve a skill by name and return the on-demand rendering used by
     * the `skill` tool. Returns null when no skill matches — the tool then
     * surfaces an error with the available names so the model can retry.
     */
    renderSkillForTool?: (name: string) => string | null;
    /**
     * List the skills the parent has currently warmed (name + source).
     * Used by the `skill` tool's not-found branch so the error message
     * can suggest what's actually available right now.
     */
    listSkillNames?: () => Array<{ name: string; source: "personal" | "workspace" | "builtin" }>;
  };
}

// ─── Tool Output Caps (OpenCode Pattern #1) ───
// Cap tool output AT THE TOOL LEVEL before it enters the AI SDK message history.
// This is more effective than truncating in assembleContext/prepareStep because
// the tokens never enter the step-level accumulation in the first place.

/**
 * Per-tool output limits. Applied before results enter the AI SDK message
 * history — prevents large results from accumulating across multi-step loops.
 *
 * Note: Think's tools already have internal caps (read: 2000 lines,
 * find/grep: 200 results). These are stricter secondary caps that match
 * OpenCode's proven values. The read tool's internal 2000-line cap makes
 * an external cap redundant, so only entry-based caps are defined here.
 */
const TOOL_OUTPUT_CAPS: Record<string, { maxLines?: number; maxBytes?: number; maxEntries?: number }> = {
  grep:   { maxEntries: 100 },  // Think caps at 200; we cap at 100
  find:   { maxEntries: 100 },  // Think caps at 200; we cap at 100
  list:   { maxEntries: 100 },  // Think's list accepts a limit param; we cap the output
  read:   { maxLines: 200 },    // Force the model to use offset/limit for large files.
                                // Think caps at 2000 lines but that's ~60k tokens — too
                                // much for discovery. 200 lines is enough for a preview;
                                // the truncation hint tells the model to use offset/limit.
  // codemode — 32 KB soft cap. codemode lets the model call arbitrary JS
  // including fetch() against external APIs; without a cap, a single
  // GitHub-API-style response can burn 200k+ input tokens. Enforced in
  // capCodemodeResult() below because codemode's result shape is
  // `{ code, result, logs? }` rather than the generic shapes handled by
  // capResult(). Pairs with the `select` schema projection (described in
  // the tool's prompt) so the model can pre-narrow before output hits here.
  codemode: { maxBytes: 32_000 },
  // write, edit, delete — already produce small output, no cap needed
};

/** Max bytes for a codemode `logs` field; kept separate from result. */
const CODEMODE_LOGS_MAX_BYTES = 4_000;

/**
 * Wrap a tool set to enforce per-tool output caps.
 * Each tool's execute function is intercepted: the result is serialized,
 * checked against its cap, and truncated with an actionable hint if exceeded.
 */
export function capToolOutputs(tools: Record<string, AnyTool>): Record<string, AnyTool> {
  const wrapped: Record<string, AnyTool> = {};
  for (const [name, t] of Object.entries(tools)) {
    const caps = TOOL_OUTPUT_CAPS[name];
    if (!caps) {
      wrapped[name] = t;
      continue;
    }
    // Clone the tool with a wrapped execute
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

/** Apply output caps to a single tool result. */
function capResult(
  toolName: string,
  result: unknown,
  caps: { maxLines?: number; maxBytes?: number; maxEntries?: number },
): unknown {
  if (result === null || result === undefined) return result;

  // Handle structured results (objects with entries arrays — list, find, grep)
  if (typeof result === "object" && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;

    // Cap entries arrays (list, find, grep return { entries: [...] } or { matches: [...] })
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

    // Cap text content in read results
    if (caps.maxLines || caps.maxBytes) {
      // The read tool returns { content: string, ... } or just a string
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

  // Handle plain string results
  if (typeof result === "string" && (caps.maxLines || caps.maxBytes)) {
    const capped = capText(result, caps.maxLines ?? Infinity, caps.maxBytes ?? Infinity);
    if (capped !== result) {
      const lines = result.split("\n").length;
      return capped + `\n\n[Output capped. ${lines} total lines. Use read with offset/limit to view specific sections.]`;
    }
  }

  return result;
}

/**
 * Middle-truncate a string to fit within a byte budget. Keeps head and tail
 * so both the shape of the value and its end (often the most recent /
 * interesting data) are preserved. Produces a `[... truncated N bytes ...]`
 * hint in the middle.
 */
function middleTruncate(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text;
  // Leave room for the truncation marker
  const marker = "\n[... truncated %d bytes. Pass `select` to codemode to project only the fields you need. ...]\n";
  const overhead = marker.length + 12; // room for %d replacement
  const headBudget = Math.floor((maxBytes - overhead) * 0.6);
  const tailBudget = Math.floor((maxBytes - overhead) * 0.4);
  if (headBudget <= 0 || tailBudget <= 0) return text.slice(0, maxBytes);
  const head = text.slice(0, headBudget);
  const tail = text.slice(-tailBudget);
  const dropped = text.length - headBudget - tailBudget;
  return `${head}${marker.replace("%d", String(dropped))}${tail}`;
}

/**
 * Cap a codemode tool result. Handles the `{ code, result, logs? }` shape
 * returned by `createExecuteTool`. The `result` field is whatever the
 * sandboxed JS returned (often a fetched JSON blob); it's serialized and
 * middle-truncated against `maxBytes`. `logs` is trimmed separately.
 *
 * The `code` field is left untouched — it's typically small, and we want the
 * model to be able to diff what it sent vs what came back.
 */
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

/**
 * Project a codemode result to the caller-provided dot-paths.
 *
 * Only the `result` field of the returned object is projected — `code`,
 * `logs`, and any other fields are left alone. Supports numeric indices
 * in paths (e.g. `items.0.name`). Missing paths are silently skipped.
 *
 * Returns a new object shaped like:
 *   { code, result: { "items.0.name": "foo", "total_count": 42 }, logs? }
 * so the model sees exactly what it asked for, flat-keyed by path.
 */
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

/** Walk a dot-path through a value. `items.0.name` handles arrays. */
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

/** Truncate text by line count and byte size, keeping the head. */
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

function trimBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

// ─── Subagent message-history pruning ───
// Tool-level output caps (capToolOutputs above) bound the size of ANY single
// tool result. But inside a multi-step subagent run, every prior tool result
// stays pinned in the `messages` array and gets re-fed to the model every step.
// A 12-step explore that reads five 200-line snippets still ships ~50k tokens
// of stale tool output at step 12 — because steps 1-11 are still present.
//
// Observed in the 2026-04-24 prod A/B: a single explore facet accumulated
// ~301k input tokens across 12 steps, within shouting distance of Haiku's
// 200k window. No single step was over the per-tool cap; the sum was.
//
// `pruneSubagentHistory` plugs into `generateText`'s `prepareStep` callback.
// It keeps:
//   - the system message (injected by generateText, not in our `messages`)
//   - the initial user message (the query/prompt)
//   - the most recent N assistant+tool_result pairs
// and replaces the dropped middle with a single marker message so the model
// knows history was compacted, not corrupted.
//
// N defaults to 4. That's aggressive — two full tool-call cycles in working
// memory plus the current turn. Subagents are supposed to do ONE bounded
// thing; they don't need long-term conversational context. If the model
// needed information from an earlier step, it should have summarised it
// into its own reasoning before now.

/**
 * Keep this many trailing message groups (each group = one assistant msg
 * plus any tool_result messages tied to it). Chosen empirically: smaller
 * values risk dropping useful context the model hasn't condensed yet;
 * larger values defeat the point. 4 is enough for the model to remember
 * its last ~2 tool-call cycles plus the current turn.
 */
const SUBAGENT_MSG_WINDOW = 4;

/**
 * Compact tool-result marker used when we drop the middle of the message
 * history. Surfaces a rough count so the model can self-explain if asked.
 */
function makePruneMarker(droppedCount: number): ModelMessage {
  return {
    role: "user",
    content: `[system: ${droppedCount} earlier assistant/tool messages were pruned to keep your input token count bounded. If you need information from those steps, call the relevant tool again — don't try to reconstruct the content.]`,
  };
}

/**
 * Return a pruned copy of `messages` keeping the initial user prompt and the
 * most recent `windowSize` assistant+tool_result groups. Stable when the
 * history is already short enough.
 *
 * Intended for use inside `generateText({ prepareStep })`.
 */
export function pruneSubagentHistory(
  messages: Array<ModelMessage>,
  windowSize: number = SUBAGENT_MSG_WINDOW,
): Array<ModelMessage> {
  if (messages.length <= windowSize + 1) return messages;

  // Find the first user message — this is the original query we must preserve
  // across pruning so the model retains its goal.
  const firstUserIdx = messages.findIndex((m) => m.role === "user");
  if (firstUserIdx < 0) return messages; // defensive — shouldn't happen

  // Walk from the end of the list backwards and group: every assistant
  // message and the tool_result messages that follow it are one "group".
  // We keep the last `windowSize` groups.
  const groups: Array<{ start: number; end: number }> = [];
  let cursor = messages.length;
  while (cursor > firstUserIdx + 1 && groups.length < windowSize) {
    const end = cursor;
    let start = cursor - 1;
    // Walk backwards through any leading non-assistant messages (tool results)
    // until we find the assistant message that emitted them.
    while (start > firstUserIdx + 1 && messages[start].role !== "assistant") {
      start--;
    }
    groups.unshift({ start, end });
    cursor = start;
  }

  if (groups.length === 0) return messages;

  // Keep: [0 .. firstUserIdx], marker, messages[groups[0].start ..]
  const head = messages.slice(0, firstUserIdx + 1);
  const tailStart = groups[0].start;
  const dropped = tailStart - (firstUserIdx + 1);
  if (dropped <= 0) return messages;
  const tail = messages.slice(tailStart);
  return [...head, makePruneMarker(dropped), ...tail];
}

/**
 * Convenience: build a `prepareStep` callback suitable for passing into
 * `generateText` in both explore and task subagent call sites. Returns a
 * message override only when pruning actually happens.
 */
export function subagentPrepareStep(options?: { windowSize?: number }) {
  const windowSize = options?.windowSize ?? SUBAGENT_MSG_WINDOW;
  return ({ messages }: { messages: Array<ModelMessage> }) => {
    const pruned = pruneSubagentHistory(messages, windowSize);
    return pruned === messages ? {} : { messages: pruned };
  };
}

/**
 * Add Anthropic prompt-caching cache_control markers to an OpenAI-compatible
 * request body. Invoked by @ai-sdk/openai-compatible as transformRequestBody,
 * so this runs once per outbound request (per call to streamText / generateText).
 *
 * Strategy — place markers at the boundaries Anthropic expects:
 *   1. System prompt   → cache (static per session after turn 1)
 *   2. Tool definitions → cache (stable per session)
 *   3. Last user message → cache (reuses cached context on retries)
 *
 * Anthropic allows up to 4 cache_control markers per request. We use 3 to
 * leave one spare for future extensions (e.g. caching a compaction summary).
 *
 * The OpenAI-compatible wire format allows system to be a string; when
 * routed to Anthropic the gateway re-shapes it. We upgrade to the Anthropic
 * array-of-content-blocks shape at the wire level — most gateways that route
 * to Anthropic pass this through unchanged; those that don't strip the
 * cache_control field silently (no error).
 *
 * All modifications are idempotent: if cache_control markers already exist,
 * we leave them alone.
 */
export function addAnthropicCacheMarkers(body: Record<string, unknown>): Record<string, unknown> {
  // No-op for non-Anthropic requests. The transform is installed on every
  // provider instance so calls that override the session model (e.g. the
  // compaction step pinned to claude-haiku-4-5) get caching too. Detect
  // Anthropic by checking the outbound model field — it's already been
  // translated to the wire format (e.g. "anthropic/claude-opus-4-7") by
  // the time transformRequestBody runs.
  const modelId = typeof body.model === "string" ? body.model : "";
  if (!modelId.startsWith("anthropic/") && !modelId.startsWith("claude-")) {
    return body;
  }

  // Shallow clone so we don't mutate the caller's object
  const out: Record<string, unknown> = { ...body };

  // 1. System prompt — upgrade string → array with cache_control
  if (typeof out.system === "string" && out.system.length > 0) {
    out.system = [
      { type: "text", text: out.system, cache_control: { type: "ephemeral" } },
    ];
  } else if (Array.isArray(out.system) && out.system.length > 0) {
    // Already array form — mark the last block if none has cache_control yet
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

  // 2. Tools — attach cache_control to the last tool definition so the
  //    whole tool-schema block is cached. Tools are stable per session, so
  //    this produces a reliable cache hit on every subsequent step.
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

  // 3. Last user message — place a cache marker so that between-step
  //    reruns can reuse the cached input. Conservative: only upgrade if
  //    the content is a string (don't touch multimodal arrays to avoid
  //    accidentally breaking image-bearing messages).
  if (Array.isArray(out.messages) && out.messages.length > 0) {
    const messages = out.messages as Array<Record<string, unknown>>;
    // Walk from the end to find the last user message
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

/** Some model IDs need rewriting before they're sent to the upstream gateway.
 *  - Workers AI models (`@cf/…`) need the `workers-ai/` prefix per AI Gateway
 *    unified-API docs: https://developers.cloudflare.com/ai-gateway/chat-completion/
 *    They only work when the active gateway is `ai-gateway`.
 *  Returns the wire-format model ID, or throws if the combination is invalid. */
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

/**
 * Pick the right gateway for a given model ID.
 *
 *  - `@cf/*` (Workers AI) → always ai-gateway
 *  - Everything else → respect whatever `config.activeGateway` says
 *
 * This lets a subagent run on a Workers AI model (e.g. Kimi K2.6) even if
 * the main session uses the opencode gateway. Without this, asking Kimi
 * to do explore work from an opencode-gateway session would fail because
 * the provider baseURL would be wrong.
 */
function resolveGatewayForModel(
  modelId: string,
  mainGateway: "opencode" | "ai-gateway",
): "opencode" | "ai-gateway" {
  if (modelId.startsWith("@cf/")) return "ai-gateway";
  return mainGateway;
}

export function buildProvider(config: AppConfig, env: Env) {
  return buildProviderForModel(config.model, config, env);
}

/**
 * Build a provider for a specific model — picks the right gateway and
 * base URL even if that differs from the session's main gateway. Used by
 * subagents that run on a cheaper/different model than the main session.
 */
export function buildProviderForModel(modelId: string, config: AppConfig, env: Env) {
  const effectiveGateway = resolveGatewayForModel(modelId, config.activeGateway);
  const isOpencode = effectiveGateway === "opencode";
  const baseURL = isOpencode
    ? `${trimBaseUrl(config.opencodeBaseURL)}`
    : `${trimBaseUrl(config.aiGatewayBaseURL)}`;

  const headers: Record<string, string> = isOpencode
    ? { "cf-access-token": env.OPENCODE_GATEWAY_TOKEN ?? "" }
    : {
        // AI Gateway unified API: auth with `cf-aig-authorization` bearer.
        // We keep `x-api-key` for back-compat with existing deployments.
        "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_KEY ?? ""}`,
        "x-api-key": env.AI_GATEWAY_KEY ?? "",
      };

  // Anthropic prompt caching. The transform checks the outbound model per
  // request and only acts when the wire-format model ID starts with
  // "anthropic/" (or "claude-"). Always installing it ensures we still get
  // caching on calls that use a different model than the session default —
  // most importantly the compaction step, which hardcodes
  // anthropic/claude-haiku-4-5 regardless of the session model.
  // For non-Anthropic requests the transform is a no-op.
  const provider = createOpenAICompatible({
    baseURL,
    headers,
    includeUsage: true,
    name: effectiveGateway,
    transformRequestBody: addAnthropicCacheMarkers,
  });

  // Wrap `chatModel` / `languageModel` / the callable provider so callers can pass
  // the user-facing id (e.g. `@cf/moonshotai/kimi-k2.6`) and we translate it to the
  // wire format (`workers-ai/@cf/moonshotai/kimi-k2.6`) exactly once, at the edge.
  // Use the *effective* gateway (the one we actually picked for this provider)
  // so @cf/* models don't trip resolveWireModelId's activeGateway check when
  // the main session is on opencode but the subagent wants Workers AI.
  const translate = (m: string) => resolveWireModelId(m, effectiveGateway);
  const originalChatModel = provider.chatModel.bind(provider);
  const originalLanguageModel = provider.languageModel.bind(provider);

  return new Proxy(provider, {
    // Intercept `provider("model-id")` (the callable form).
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = any;

/**
 * Default git_clone depth. Bumped from 1 to 20 after observing repeated
 * "what's new in this repo?" failures where a depth=1 clone gave the model
 * only the most recent commit, so it either gave up or triggered extra
 * tool calls to get more history. 20 commits covers almost all "recent
 * changes" style questions without materially inflating clone size.
 * Agents can still pass depth=1 for tree-only or depth=0 for full history.
 */
const DEFAULT_CLONE_DEPTH = 20;

function buildGitTools(
  env: Env,
  workspace: Workspace,
  config: AppConfig,
  ownerEmail?: string,
): Record<string, AnyTool> {
  const git = createWorkspaceGit(workspace);
  const knownRepoIds = listKnownRepos().map((repo) => repo.id) as [string, ...string[]];

  const dirSchema = zodSchema(z.object({ dir: z.string().optional().describe("Repo directory") }));

  return {
    git_clone_known: tool({
      description: "Clone a built-in known repository by id. Use this instead of free-form URLs when possible. Default depth is 20 commits — enough for most 'what's new / recent changes' investigations without downloading the full history. Pass depth=0 for full history or depth=1 when you only need the current tree.",
      inputSchema: zodSchema(z.object({
        repoId: z.enum(knownRepoIds as ["dodo"]).describe("Known repo id"),
        dir: z.string().optional().describe("Target directory (defaults to repo's standard dir)"),
        branch: z.string().optional().describe("Branch to clone (defaults to repo default branch)"),
        depth: z.number().optional().describe("Clone depth in commits. Default: 20 (covers most 'what changed recently' questions). Use 1 for tree-only, 0 for full history."),
      })),
      execute: async ({ repoId, dir, branch, depth }) => {
        const repo = getKnownRepo(repoId);
        const targetDir = dir ?? repo.dir;
        const token = await resolveRemoteToken({ dir: targetDir, env, git, ownerEmail, url: repo.url });
        const cloneDepth = depth === 0 ? undefined : (depth ?? DEFAULT_CLONE_DEPTH);
        return git.clone({
          branch: branch ?? repo.defaultBranch,
          depth: cloneDepth,
          dir: targetDir,
          singleBranch: true,
          token,
          url: repo.url,
        });
      },
    }),

    git_clone: tool({
      description: "Clone a git repo into the workspace. Auth is automatic for GitHub/GitLab. Default depth is 20 commits — enough for 'what's new / recent changes / since commit X' style investigations without paying for full history. Pass depth=1 for tree-only (cheapest, no log context) or depth=0 for full history.",
      inputSchema: zodSchema(z.object({
        url: z.string().describe("Git repo URL (e.g. https://github.com/owner/repo)"),
        dir: z.string().optional().describe("Target directory (default: repo name)"),
        branch: z.string().optional().describe("Branch to clone"),
        depth: z.number().optional().describe("Clone depth in commits. Default: 20. Use 1 for tree-only, 0 for full history."),
      })),
      execute: async ({ url, dir, branch, depth }) => {
        const token = await resolveRemoteToken({ dir, env, git, url, ownerEmail });
        // depth 0 = full history (pass undefined to isomorphic-git), undefined = default depth
        const cloneDepth = depth === 0 ? undefined : (depth ?? DEFAULT_CLONE_DEPTH);
        return git.clone({ branch, depth: cloneDepth, dir, singleBranch: true, token, url });
      },
    }),

    git_status: tool({
      description: "Show working tree status (modified, added, deleted files).",
      inputSchema: dirSchema,
      execute: async ({ dir }) => {
        const entries = await git.status({ dir });
        return { entries };
      },
    }),

    git_add: tool({
      description: "Stage files for commit.",
      inputSchema: zodSchema(z.object({
        filepath: z.string().describe("File or directory to stage (use '.' for all)"),
        dir: z.string().optional().describe("Repo directory"),
      })),
      execute: async ({ filepath, dir }) => git.add({ dir, filepath }),
    }),

    git_commit: tool({
      description: "Commit staged changes.",
      inputSchema: zodSchema(z.object({
        message: z.string().describe("Commit message"),
        dir: z.string().optional().describe("Repo directory"),
      })),
      execute: async ({ message, dir }) => {
        const status = await git.status({ dir });
        if (!Array.isArray(status) || status.length === 0) {
          throw new Error("Nothing to commit. Make sure you edited files and staged them before committing.");
        }
        return git.commit({ author: defaultAuthor(config), dir, message });
      },
    }),

    git_push: tool({
      description: "Push commits to the remote. Returns a summary with ok/error status per ref. Always check the result — a successful tool call does NOT mean the push succeeded.",
      inputSchema: zodSchema(z.object({
        dir: z.string().optional().describe("Repo directory"),
        remote: z.string().optional().describe("Remote name (default: origin)"),
        ref: z.string().optional().describe("Branch ref to push"),
        force: z.boolean().optional().describe("Force push"),
        baseRef: z.string().optional().describe("Base branch to verify against after push (default: main)"),
        expectedFiles: z.array(z.string()).optional().describe("Files that must be present in the remote branch diff"),
      })),
      execute: async ({ dir, remote, ref, force, baseRef, expectedFiles }) => {
        const token = await resolveRemoteToken({ dir, env, git, remote, ownerEmail });
        const result = await git.push({ dir, force, ref, remote, token });
        if (!result.ok) {
          const refErrors = Object.entries(result.refs ?? {})
            .filter(([, v]) => !v.ok)
            .map(([k, v]) => `${k}: ${v.error}`)
            .join("; ");
          throw new Error(`Push failed: ${refErrors || "remote rejected the push"}`);
        }
        // Detect no-op pushes: ok=true but no refs changed (e.g. pushed main when on a feature branch)
        const refs = result.refs ?? {};
        const pushedRefs = Object.keys(refs);
        if (pushedRefs.length === 0) {
          throw new Error("Push was a no-op — no refs were pushed. Make sure you are on the correct branch and have committed changes. Use git_branch to verify your current branch, then retry with ref set to your branch name.");
        }
        if (ref) {
          const verification = await verifyRemoteBranch({
            baseRef,
            dir,
            env,
            expectedFiles,
            git,
            ownerEmail,
            ref,
            remote,
          });
          if (!verification.ok) {
            throw new Error(verification.error ?? `Branch '${ref}' did not verify after push`);
          }
          return {
            ok: true,
            refs: pushedRefs.join(", "),
            verification,
            message: `Pushed ${ref} and verified it is ahead of ${verification.baseRef}`,
          };
        }
        const pushed = pushedRefs.join(", ");
        return { ok: true, refs: pushed, message: `Pushed ${pushed} to ${remote || "origin"}` };
      },
    }),

    git_push_checked: tool({
      description: "Push a branch and verify that the remote branch exists, is ahead of the base branch, and optionally contains expected changed files.",
      inputSchema: zodSchema(z.object({
        dir: z.string().optional().describe("Repo directory"),
        remote: z.string().optional().describe("Remote name (default: origin)"),
        ref: z.string().min(1).describe("Branch ref to push and verify"),
        force: z.boolean().optional().describe("Force push"),
        baseRef: z.string().optional().describe("Base branch to compare against (default: main)"),
        expectedFiles: z.array(z.string()).optional().describe("Files that must appear in the remote diff"),
      })),
      execute: async ({ dir, remote, ref, force, baseRef, expectedFiles }) => {
        const token = await resolveRemoteToken({ dir, env, git, remote, ownerEmail });
        const result = await git.push({ dir, force, ref, remote, token });
        if (!result.ok) {
          const refErrors = Object.entries(result.refs ?? {})
            .filter(([, v]) => !v.ok)
            .map(([k, v]) => `${k}: ${v.error}`)
            .join("; ");
          throw new Error(`Push failed: ${refErrors || "remote rejected the push"}`);
        }
        const verification = await verifyRemoteBranch({
          baseRef,
          dir,
          env,
          expectedFiles,
          git,
          ownerEmail,
          ref,
          remote,
        });
        if (!verification.ok) {
          throw new Error(verification.error ?? `Branch '${ref}' did not verify after push`);
        }
        return {
          ok: true,
          refs: Object.keys(result.refs ?? {}).join(", "),
          verification,
          message: `Pushed ${ref} and verified it is ahead of ${verification.baseRef}`,
        };
      },
    }),

    git_verify_remote_branch: tool({
      description: "Verify a remote branch is ahead of its base branch and inspect changed files.",
      inputSchema: zodSchema(z.object({
        dir: z.string().optional().describe("Repo directory"),
        remote: z.string().optional().describe("Remote name (default: origin)"),
        ref: z.string().min(1).describe("Branch ref to verify"),
        baseRef: z.string().optional().describe("Base branch to compare against (default: main)"),
        expectedFiles: z.array(z.string()).optional().describe("Files that must appear in the remote diff"),
      })),
      execute: async ({ dir, remote, ref, baseRef, expectedFiles }) => {
        const verification = await verifyRemoteBranch({
          baseRef,
          dir,
          env,
          expectedFiles,
          git,
          ownerEmail,
          ref,
          remote,
        });
        if (!verification.ok) {
          throw new Error(verification.error ?? `Branch '${ref}' failed verification`);
        }
        return verification;
      },
    }),

    pr_create: tool({
      description: "Open a pull request (GitHub) or merge request (GitLab) for the current branch. Auto-detects the provider from the remote URL. Auto-fills `head` from the current branch and `title` / `body` from the latest commit if you omit them. Defaults to draft. Push the branch first (use git_push_checked).",
      inputSchema: zodSchema(z.object({
        dir: z.string().optional().describe("Repo directory"),
        remote: z.string().optional().describe("Remote name (default: origin)"),
        head: z.string().optional().describe("Source branch. Defaults to the current branch."),
        base: z.string().optional().describe("Target branch. Defaults to 'main'."),
        title: z.string().optional().describe("PR/MR title. Defaults to the first line of the latest commit message."),
        body: z.string().optional().describe("PR/MR body. Defaults to the latest commit body + 'Drafted via Dodo session' footer."),
        draft: z.boolean().optional().describe("Open as draft. Defaults to true."),
      })),
      execute: async ({ dir, remote, head, base, title, body, draft }) => {
        // Resolve remote URL from the workspace's git config.
        const remoteName = remote ?? "origin";
        const remotes = await git.remote({ dir, list: true });
        const remoteEntry = Array.isArray(remotes)
          ? remotes.find((entry: { remote: string; url: string }) => entry.remote === remoteName)
          : undefined;
        if (!remoteEntry?.url) {
          throw new Error(`No '${remoteName}' remote configured. Run git_clone first or add a remote.`);
        }
        const parsed = parseRemoteSpec(remoteEntry.url);
        if (!parsed) {
          throw new Error(`Remote URL '${remoteEntry.url}' is not on a supported provider (github.com, gitlab.com, gitlab.cfdata.org).`);
        }

        // Resolve head branch (current branch if not specified).
        let resolvedHead = head;
        if (!resolvedHead) {
          const branchInfo = await git.branch({ dir, list: true });
          if (branchInfo && "current" in branchInfo && branchInfo.current) {
            resolvedHead = branchInfo.current;
          }
        }
        if (!resolvedHead) {
          throw new Error("Could not determine the current branch. Pass `head` explicitly or run git_branch to inspect.");
        }
        const resolvedBase = base ?? "main";
        if (resolvedHead === resolvedBase) {
          throw new Error(`Head and base branches are both '${resolvedHead}'. Create a feature branch first with git_checkout.`);
        }

        // Auto-fill title/body from latest commit if not provided.
        let resolvedTitle = title;
        let resolvedBody = body;
        if (!resolvedTitle || !resolvedBody) {
          const log = await git.log({ depth: 1, dir });
          const latest = Array.isArray(log) && log.length > 0 ? log[0] : null;
          const message = latest?.message ?? "";
          const [firstLine, ...rest] = message.split("\n");
          if (!resolvedTitle) {
            resolvedTitle = firstLine.trim() || `Update from ${resolvedHead}`;
          }
          if (!resolvedBody) {
            const commitBody = rest.join("\n").trim();
            // Skip the horizontal rule when there's no commit body — an
            // orphan `---` above the footer reads like an empty section.
            resolvedBody = commitBody
              ? `${commitBody}\n\n---\n\nDrafted via Dodo session.`
              : "Drafted via Dodo session.";
          }
        }

        const result = await createPullRequest(
          env,
          {
            remoteUrl: remoteEntry.url,
            head: resolvedHead,
            base: resolvedBase,
            title: resolvedTitle,
            body: resolvedBody,
            draft,
          },
          ownerEmail,
        );
        if (!result.ok) {
          throw new Error(result.error);
        }
        return {
          ok: true,
          url: result.url,
          number: result.number,
          provider: result.provider,
          head: resolvedHead,
          base: resolvedBase,
          draft: draft ?? true,
          message: `Opened ${result.provider === "github" ? "PR" : "MR"} #${result.number}: ${result.url}`,
        };
      },
    }),

    git_branch: tool({
      description: "List, create, or delete branches.",
      inputSchema: zodSchema(z.object({
        dir: z.string().optional().describe("Repo directory"),
        name: z.string().optional().describe("Branch name to create"),
        list: z.boolean().optional().describe("List all branches"),
        delete: z.string().optional().describe("Branch name to delete"),
      })),
      execute: async ({ dir, name, list, delete: del }) =>
        git.branch({ delete: del, dir, list, name }),
    }),

    git_checkout: tool({
      description: "Switch branches or restore files.",
      inputSchema: zodSchema(z.object({
        dir: z.string().optional().describe("Repo directory"),
        branch: z.string().optional().describe("Branch to checkout"),
        ref: z.string().optional().describe("Ref (commit/tag) to checkout"),
        force: z.boolean().optional().describe("Force checkout"),
      })),
      execute: async ({ dir, branch, ref, force }) =>
        git.checkout({ branch, dir, force, ref }),
    }),

    git_diff: tool({
      description: "Show unstaged changes in the working tree.",
      inputSchema: dirSchema,
      execute: async ({ dir }) => {
        const entries = await git.diff({ dir });
        return { entries };
      },
    }),

    git_log: tool({
      description: "Show commit history.",
      inputSchema: zodSchema(z.object({
        dir: z.string().optional().describe("Repo directory"),
        depth: z.number().optional().describe("Number of commits to show"),
      })),
      execute: async ({ dir, depth }) => {
        const entries = await git.log({ depth, dir });
        return { entries };
      },
    }),

    git_pull: tool({
      description: "Pull changes from the remote.",
      inputSchema: zodSchema(z.object({
        dir: z.string().optional().describe("Repo directory"),
        remote: z.string().optional().describe("Remote name (default: origin)"),
        ref: z.string().optional().describe("Branch ref to pull"),
      })),
      execute: async ({ dir, remote, ref }) => {
        const token = await resolveRemoteToken({ dir, env, git, remote, ownerEmail });
        return git.pull({ author: defaultAuthor(config), dir, ref, remote, token });
      },
    }),
  };
}

// ─── Explore Subagent (Phase 3) ───
// Offloads open-ended file search to a worker generateText call with its own
// context window. Returns a compact summary (~500-1000 tokens) instead of
// raw file contents (~5000-20000 tokens), saving 5-20× tokens per search.

/** Max steps for the explore subagent.
 *  History:
 *   - Bumped 5 → 12 after the 2026-04-24 demo sessions
 *     (`877cefcc`, `197cc126`, `fdad8393`) showed 5 steps was routinely
 *     consumed by tool-calling before the model got a chance to summarise.
 *   - Bumped 12 → 16 after a 2026-04-25 prod A/B surfaced the same
 *     exhaustion pattern: multiple facet runs hit step 12 with ~25k of
 *     accumulated grep/read context and emitted empty summaries, forcing
 *     the parent (Opus) to retry — doubling the tokens that were supposed
 *     to be saved. 16 + the explicit "reserve 2 for summary" rule in the
 *     system prompt hits the same observed tool-call volume without
 *     starving the summary. */
export const EXPLORE_MAX_STEPS = 16;

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

/** Cheap model for the explore subagent, keyed by provider prefix.
 *  Falls back to the main model if no match (still works, just costs more). */
const EXPLORE_MODELS: Record<string, string> = {
  "anthropic/": "anthropic/claude-haiku-4-5",
  "openai/": "openai/gpt-4.1-mini",
  "google/": "google/gemini-2.5-flash",
  "deepseek/": "deepseek/deepseek-chat",
};
export function getExploreModel(mainModel: string): string {
  for (const [prefix, model] of Object.entries(EXPLORE_MODELS)) {
    if (mainModel.startsWith(prefix)) return model;
  }
  return mainModel; // fallback: use the main model itself
}

/** Timeout for the explore subagent (ms). Prevents indefinite blocking. */
export const EXPLORE_TIMEOUT_MS = 60_000;

/** Max steps for the generic task subagent.
 *  Bumped 15 → 20 alongside EXPLORE_MAX_STEPS 12 → 16 on 2026-04-25
 *  to leave room for the "reserve 2 for summary" pacing rule in
 *  TASK_SYSTEM_PROMPT. Task is write-capable and typically uses more
 *  tool calls per run than explore. */
export const TASK_MAX_STEPS = 20;

/** Timeout for the generic task subagent (ms).
 *  Raised to 600s when the task runs inside a facet — the facet has its
 *  own DO request lifetime and isn't bound by the parent's turn budget. */
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

/**
 * Pick the model a subagent should use.
 *
 * Precedence:
 *   1. Per-call override — `args.model` on the tool call
 *   2. Per-session default — `config.exploreModel` / `config.taskModel`
 *      (sourced from DodoConfig, ultimately from the env defaults
 *       DEFAULT_EXPLORE_MODEL / DEFAULT_TASK_MODEL on wrangler.jsonc)
 *   3. Built-in heuristic — `getExploreModel(config.model)` which picks a
 *      cheap model by provider family, falling back to the main model itself
 *
 * Each level is only used if the one above is unset/blank, so users can
 * configure globally but still override on a hot path.
 */
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

/**
 * Build a subagent tool with a configurable name, description, system prompt,
 * tool subset, and step/timeout budgets. Both `explore` and `task` are
 * instances of this — `explore` is a pre-configured read-only search
 * subagent; `task` is a general-purpose delegate with a tighter time budget
 * per call but more steps.
 */
/**
 * Build the `skill` tool — on-demand loader for the second stage of the
 * progressive-disclosure skill model. The system prompt's `<available_skills>`
 * block lists name + description for every enabled skill; this tool returns
 * the full SKILL.md body when the model decides one matches the task.
 *
 * Implementation lives in coding-agent.ts (so the warmed cache is local).
 * This tool is a thin shim that calls `parent.renderSkillForTool(name)`.
 *
 * Token cost: ~80 tokens for the tool definition. Per-load: 500-2000 tokens
 * depending on body size. Bundled files (references/, scripts/) are listed
 * by relative path but never auto-loaded — the model uses `read` to fetch.
 */
function buildSkillTool(parent: NonNullable<BuildToolsOptions["parentAgent"]>): AnyTool {
  return tool({
    description: [
      "Load a skill by name. Skills are listed in <available_skills> in the system prompt.",
      "Returns the full SKILL.md body and a list of bundled files. Use the `read` tool to",
      "fetch any bundled files you need — they are NOT auto-loaded.",
    ].join(" "),
    inputSchema: z.object({
      name: z.string().min(1).describe("Exact skill name from the <available_skills> manifest."),
    }),
    execute: async ({ name }: { name: string }) => {
      const render = parent.renderSkillForTool;
      if (!render) {
        return "skill tool unavailable — parent agent missing renderSkillForTool. This is a bug.";
      }
      const out = render(name);
      if (out) return out;
      const list = parent.listSkillNames?.() ?? [];
      const available = list.length === 0
        ? "(no skills currently loaded)"
        : list.map((s) => `${s.name} (${s.source})`).join(", ");
      return `Skill "${name}" not found. Available: ${available}`;
    },
  });
}

function buildSubagentTool(spec: {
  name: string;
  description: string;
  systemPrompt: string;
  inputSchema: AnyTool;
  getUserMessage: (args: Record<string, unknown>) => string;
  getTools: () => Record<string, AnyTool>;
  config: AppConfig;
  env: Env;
  maxSteps: number;
  timeoutMs: number;
  /** Per-session default for this subagent's model (from AppConfig). */
  sessionDefaultModel: string | undefined;
}): AnyTool {
  return tool({
    description: spec.description,
    inputSchema: spec.inputSchema,
    execute: async (args: Record<string, unknown>) => {
      const modelId = resolveSubagentModel(args, spec.sessionDefaultModel, spec.config.model);
      const provider = buildProviderForModel(modelId, spec.config, spec.env);
      const model = provider.chatModel(modelId);
      const userMessage = spec.getUserMessage(args);

      try {
        const result = await generateText({
          model,
          system: spec.systemPrompt,
          messages: [{ role: "user" as const, content: userMessage }],
          tools: spec.getTools(),
          stopWhen: stepCountIs(spec.maxSteps),
          // Bumped from 2000 → 4000. The explore/task subagents frequently
          // summarize 5-10 files' worth of findings; 2000 tokens was clipping
          // the summary mid-sentence after the model ran its tool budget.
          // 4000 still small enough to keep the subagent's turn compact.
          maxOutputTokens: 4000,
          // Prune older assistant/tool message groups between steps so a long
          // investigation doesn't ship its entire tool-result history back to
          // the model on every call. Tool-level caps bound single results; this
          // bounds the sum across steps.
          prepareStep: subagentPrepareStep(),
          abortSignal: AbortSignal.timeout(spec.timeoutMs),
        });

        const summary = result.text;
        const steps = result.steps.length;
        const toolCalls = result.steps.flatMap((s) =>
          (s.toolCalls ?? []).map((tc) => tc.toolName),
        );
        // Sum per-step usage into a single subagent cost line. Surfacing
        // this matters for observability — "explore used 40k tokens" is a
        // cost the parent can't see otherwise since the subagent's LLM
        // calls don't touch the parent's message_metadata totals.
        const totalInput = result.steps.reduce(
          (sum, s) => sum + (s.usage?.inputTokens ?? 0),
          0,
        );
        const totalOutput = result.steps.reduce(
          (sum, s) => sum + (s.usage?.outputTokens ?? 0),
          0,
        );
        const usageLine = totalInput > 0 || totalOutput > 0
          ? `**Tokens:** ${totalInput} in / ${totalOutput} out | `
          : "";

        return [
          `## ${spec.name} results (model: ${modelId})`,
          `${usageLine}**Steps:** ${steps} | **Tools used:** ${toolCalls.join(", ") || "none"}`,
          "",
          summary || "(No output — subagent ran its tool budget without emitting a summary. Try a narrower query or a higher-capability model via the `model` arg.)",
        ].filter(Boolean).join("\n");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `${spec.name} failed (model: ${modelId}): ${msg}`;
      }
    },
  });
}

/**
 * Build the explore tool — spawns a search-only subagent via generateText().
 *
 * The subagent gets read-only workspace tools (read, list, find, grep) with
 * output caps applied. It runs up to EXPLORE_MAX_STEPS steps of search,
 * then returns a compact text summary. The summary enters the main agent's
 * context (~500-1000 tokens) instead of multiple raw file reads (~5-20k tokens).
 */
function buildExploreTool(
  workspace: Workspace,
  config: AppConfig,
  env: Env,
  parentAgent?: BuildToolsOptions["parentAgent"],
): AnyTool {
  // Branch on `config.exploreMode`:
  //
  //   - "facet"     → delegate to the parent CodingAgent's
  //                   `runExploreFacet`, which spins up an ExploreAgent
  //                   facet DO and returns the same formatted summary.
  //                   The parent's turn is still blocked on `await`, but
  //                   the LLM turns happen in a separate DO (separate
  //                   context window, no shared step budget).
  //   - "inprocess" → today's path: `generateText` inside the tool's
  //                   own execute, tools share the parent's workspace
  //                   directly. Default — easy to roll back.
  //
  // Both paths return the same `## Explore results` shape so the caller
  // model sees identical output.
  if (config.exploreMode === "facet" && parentAgent) {
    return tool({
      description: [
        "Search the workspace for files and code matching a query (or multiple queries).",
        "Runs autonomous search agents (facets) that use grep, find, list, and read to explore",
        "the codebase, then return compact summaries of findings (file paths, line numbers, key observations).",
        "Much more token-efficient than reading files directly for open-ended searches.",
        "Pass `query` for a single search, or `queries` (array) to fan out N parallel searches in one tool call —",
        "the facet-mode backend runs them concurrently, cutting wall time roughly N× when searches are independent.",
        "Use when you need to find where something is defined, locate files matching a pattern,",
        "or understand how a feature is implemented across multiple files.",
      ].join(" "),
      inputSchema: zodSchema(z.object({
        query: z.string().min(1).optional().describe(
          "A single search query — use this OR `queries`, not both. E.g. 'Find all files that handle CSS escaping' or 'Where is the database connection pool configured?'",
        ),
        queries: z.array(z.string().min(1)).min(1).max(5).optional().describe(
          "Array of independent search queries to fan out in parallel (facet mode only; falls back to sequential in inprocess mode). Max 5 per call. Results are concatenated with a `## Query N: <q>` header per entry.",
        ),
        scope: z.string().optional().describe(
          "Optional directory to scope the search to (e.g. 'src/' or 'lib/utils'). Applied to every query.",
        ),
        model: z.string().optional().describe(
          "Optional model override for this call (e.g. '@cf/moonshotai/kimi-k2.6', 'anthropic/claude-haiku-4-5'). Leave unset to use the session default.",
        ),
      })),
      execute: async (args: Record<string, unknown>) => {
        const scope = typeof args.scope === "string" ? args.scope : undefined;
        const model = typeof args.model === "string" ? args.model : undefined;

        // Normalize input → list of queries. Accept either form; reject
        // the "both" case to avoid the model passing contradictory args.
        const rawQueries = Array.isArray(args.queries)
          ? args.queries.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
          : [];
        const rawQuery = typeof args.query === "string" ? args.query.trim() : "";

        if (rawQueries.length === 0 && rawQuery.length === 0) {
          return "Explore requires `query` (string) or `queries` (non-empty array).";
        }
        if (rawQueries.length > 0 && rawQuery.length > 0) {
          return "Explore received both `query` and `queries` — pick one.";
        }

        const queries = rawQueries.length > 0 ? rawQueries : [rawQuery];

        // Single query: keep the existing single-summary output shape so
        // the model's tool-handling code doesn't need to care about the
        // fan-out wrapper when only one query came in.
        if (queries.length === 1) {
          try {
            const result = await parentAgent.runExploreFacet("pool-explore-0", {
              q: queries[0], scope, model,
            });
            return result.summary;
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return `Explore failed (facet mode): ${msg}`;
          }
        }

        // Parallel fan-out: spawn N facets by pool index and Promise.all
        // them. Order of the returned summaries matches the input order
        // so the model can reliably cross-reference "Query 1" etc.
        const settled = await Promise.allSettled(
          queries.map((q, idx) =>
            parentAgent.runExploreFacet(`pool-explore-${idx}`, { q, scope, model }),
          ),
        );

        const blocks: string[] = [
          `# Parallel explore — ${queries.length} queries in parallel`,
          "",
        ];
        for (let i = 0; i < settled.length; i++) {
          const q = queries[i];
          const outcome = settled[i];
          blocks.push(`## Query ${i + 1}: ${q}`, "");
          if (outcome.status === "fulfilled") {
            blocks.push(outcome.value.summary, "");
          } else {
            const reason = outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason);
            blocks.push(`(query ${i + 1} failed: ${reason})`, "");
          }
        }
        return blocks.join("\n").trimEnd();
      },
    });
  }

  // Build read-only workspace tools for the explore subagent (in-process path).
  const allWsTools = createWorkspaceTools(workspace);
  const readOnlyTools = capToolOutputs({
    read: allWsTools.read,
    list: allWsTools.list,
    find: allWsTools.find,
    grep: allWsTools.grep,
  });

  // Underlying single-query subagent tool. Wrapped below to accept
  // `queries` (array) as a sibling to `query` — in-process mode cannot
  // parallelise (generateText blocks its caller), so multi-query
  // requests run sequentially and the result header flags that.
  const singleQueryTool = buildSubagentTool({
    name: "Explore",
    description: "internal — wrapped below",
    systemPrompt: EXPLORE_SYSTEM_PROMPT,
    inputSchema: zodSchema(z.object({
      query: z.string().min(1),
      scope: z.string().optional(),
      model: z.string().optional(),
    })),
    getUserMessage: (args) => {
      const query = String(args.query ?? "");
      const scope = args.scope ? String(args.scope) : null;
      return scope ? `${query}\n\nSearch scope: ${scope}` : query;
    },
    getTools: () => readOnlyTools,
    config,
    env,
    maxSteps: EXPLORE_MAX_STEPS,
    timeoutMs: EXPLORE_TIMEOUT_MS,
    sessionDefaultModel: config.exploreModel,
  });

  const singleExec = (singleQueryTool as AnyTool).execute as (args: Record<string, unknown>) => Promise<unknown>;

  return tool({
    description: [
      "Search the workspace for files and code matching a query (or multiple queries).",
      "Runs an autonomous search agent that uses grep, find, list, and read to explore the codebase,",
      "then returns a compact summary of findings (file paths, line numbers, key observations).",
      "Much more token-efficient than reading files directly for open-ended searches.",
      "Pass `query` for a single search, or `queries` (array) to run N searches in one tool call.",
      "NOTE: in in-process mode multi-query runs sequentially; switch to `exploreMode=facet` for parallel fan-out.",
      "Use when you need to find where something is defined, locate files matching a pattern,",
      "or understand how a feature is implemented across multiple files.",
    ].join(" "),
    inputSchema: zodSchema(z.object({
      query: z.string().min(1).optional().describe(
        "A single search query — use this OR `queries`, not both. E.g. 'Find all files that handle CSS escaping' or 'Where is the database connection pool configured?'",
      ),
      queries: z.array(z.string().min(1)).min(1).max(5).optional().describe(
        "Array of search queries. In in-process mode these run sequentially; in facet mode they fan out in parallel. Max 5.",
      ),
      scope: z.string().optional().describe(
        "Optional directory to scope the search to (e.g. 'src/' or 'lib/utils'). Applied to every query.",
      ),
      model: z.string().optional().describe(
        "Optional model override for this call. Leave unset to use the session default.",
      ),
    })),
    execute: async (args: Record<string, unknown>) => {
      const scope = typeof args.scope === "string" ? args.scope : undefined;
      const model = typeof args.model === "string" ? args.model : undefined;
      const rawQueries = Array.isArray(args.queries)
        ? args.queries.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
        : [];
      const rawQuery = typeof args.query === "string" ? args.query.trim() : "";

      if (rawQueries.length === 0 && rawQuery.length === 0) {
        return "Explore requires `query` (string) or `queries` (non-empty array).";
      }
      if (rawQueries.length > 0 && rawQuery.length > 0) {
        return "Explore received both `query` and `queries` — pick one.";
      }

      const queries = rawQueries.length > 0 ? rawQueries : [rawQuery];

      if (queries.length === 1) {
        return singleExec({ query: queries[0], scope, model });
      }

      // In-process fan-out is sequential by construction. Flagged in the
      // header so the parent model knows latency scales N×.
      const blocks: string[] = [
        `# Sequential explore — ${queries.length} queries (in-process mode; switch exploreMode=facet for parallel)`,
        "",
      ];
      for (let i = 0; i < queries.length; i++) {
        blocks.push(`## Query ${i + 1}: ${queries[i]}`, "");
        try {
          const result = await singleExec({ query: queries[i], scope, model });
          blocks.push(typeof result === "string" ? result : JSON.stringify(result), "");
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          blocks.push(`(query ${i + 1} failed: ${msg})`, "");
        }
      }
      return blocks.join("\n").trimEnd();
    },
  });
}

/**
 * Build the generic `task` subagent — delegates a bounded unit of work to a
 * fresh generateText() call with a caller-configurable tool subset.
 *
 * Use cases: "update all imports from X to Y", "run the tests and
 * report failures", "review this file for dead code". Keeps the main
 * agent's context clean — only the sub-agent's final text summary lands
 * in the main conversation.
 */
function buildTaskTool(
  workspace: Workspace,
  config: AppConfig,
  env: Env,
  parentAgent?: BuildToolsOptions["parentAgent"],
): AnyTool {
  // Facet branch — delegate to the parent's runTaskFacet which spins up
  // a TaskAgent facet DO. Supports a new `workspaceMode` arg that the
  // in-process path can't offer (the in-process subagent always shares
  // the parent's workspace).
  if (config.taskMode === "facet" && parentAgent) {
    return tool({
      description: [
        "Delegate a focused, bounded sub-task to a TaskAgent facet with its own context window.",
        "The facet gets workspace tools (read, list, find, grep, write, edit) and returns a compact summary.",
        "Use for multi-step sub-tasks that would otherwise eat the main conversation's step budget and context:",
        "'update all imports of X to Y', 'review these 6 files and list bugs', 'rename MyClass to TheirClass everywhere'.",
        "",
        "workspaceMode:",
        "  - 'shared' (default) — facet writes land directly in the main workspace",
        "  - 'scratch' — facet writes go to a scratch workspace; call applyFromScratch to merge back",
        "",
        "Do NOT use for one-shot operations (just call the tool directly) or anything requiring git/codemode/browser.",
      ].join("\n"),
      inputSchema: zodSchema(z.object({
        prompt: z.string().min(1).describe(
          "The task to perform. Be specific and self-contained — the facet has no access to your conversation. Include file paths, names, and acceptance criteria.",
        ),
        scope: z.string().optional().describe(
          "Optional directory to scope the task to (e.g. 'src/'). Hint only.",
        ),
        model: z.string().optional().describe(
          "Optional model override for this call. Leave unset to use the session default.",
        ),
        workspaceMode: z.enum(["shared", "scratch"]).optional().describe(
          "Workspace isolation. 'shared' (default) writes to the main workspace. 'scratch' writes to an isolated workspace you can merge back via applyFromScratch. Use 'scratch' for reversible experiments.",
        ),
      })),
      execute: async (args: Record<string, unknown>) => {
        const workspaceMode = args.workspaceMode === "scratch" ? "scratch" : "shared";
        try {
          const result = await parentAgent.runTaskFacet("pool-task-0", {
            prompt: String(args.prompt ?? ""),
            scope: typeof args.scope === "string" ? args.scope : undefined,
            model: typeof args.model === "string" ? args.model : undefined,
            workspaceMode,
          });
          if (result.workspaceMode === "scratch" && result.scratchWrites?.length) {
            return [
              result.summary,
              "",
              `**Scratch writes (${result.scratchWrites.length} files):**`,
              ...result.scratchWrites.map((p) => `- ${p}`),
              "",
              "Writes landed in an isolated scratch workspace — the main workspace is unchanged.",
              `To merge a subset back into the main workspace, ask the user to \`POST /session/<id>/facets/${result.facetName}/apply\` with \`{ "paths": [...] }\`.`,
              "Or — if the caller has already confirmed — the parent can call `applyTaskScratch(facetName, paths)` directly via RPC.",
            ].join("\n");
          }
          return result.summary;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return `Task failed (facet mode): ${msg}`;
        }
      },
    });
  }

  // In-process branch (default) — unchanged from before phase 4. Workspace
  // is always shared; workspaceMode arg is silently ignored here since
  // in-process has no scratch implementation.
  const allWsTools = createWorkspaceTools(workspace);
  const taskTools = capToolOutputs({
    read: allWsTools.read,
    list: allWsTools.list,
    find: allWsTools.find,
    grep: allWsTools.grep,
    write: allWsTools.write,
    edit: allWsTools.edit,
  });

  return buildSubagentTool({
    name: "Task",
    description: [
      "Delegate a focused, bounded sub-task to a subagent with its own context window.",
      "The subagent gets workspace tools (read, list, find, grep, write, edit) and returns a compact summary.",
      "Use for multi-step sub-tasks that would otherwise eat the main conversation's step budget and context:",
      "'update all imports of X to Y', 'review these 6 files and list bugs', 'rename MyClass to TheirClass everywhere'.",
      "Do NOT use for one-shot operations (just call the tool directly) or anything requiring git/codemode/browser.",
      "NOTE: in-process mode always shares the main workspace. Switch to taskMode=facet to enable scratch workspaces.",
    ].join(" "),
    systemPrompt: TASK_SYSTEM_PROMPT,
    inputSchema: zodSchema(z.object({
      prompt: z.string().min(1).describe(
        "The task to perform. Be specific and self-contained — the subagent has no access to your conversation. Include file paths, names, and acceptance criteria.",
      ),
      scope: z.string().optional().describe(
        "Optional directory to scope the task to (e.g. 'src/'). Hint only — the subagent can still read outside this path.",
      ),
      model: z.string().optional().describe(
        "Optional model override for this call (e.g. 'anthropic/claude-haiku-4-5', '@cf/moonshotai/kimi-k2.6'). Leave unset to use the session default (configured via PUT /config taskModel, defaults to Haiku 4.5).",
      ),
    })),
    getUserMessage: (args) => {
      const prompt = String(args.prompt ?? "");
      const scope = args.scope ? String(args.scope) : null;
      return scope ? `${prompt}\n\nScope hint: ${scope}` : prompt;
    },
    getTools: () => taskTools,
    config,
    env,
    maxSteps: TASK_MAX_STEPS,
    timeoutMs: TASK_TIMEOUT_MS,
    sessionDefaultModel: config.taskModel,
  });
}

/**
 * Build the todo tool family. Backed by a per-session store injected from
 * the CodingAgent DO. Exposes four small operations the model can use to
 * maintain a persistent, durable checklist across compactions.
 *
 * Why a tool (not a convention): Anthropic models in particular tend to
 * repeat themselves after a compaction summary, and a hallucinated todo
 * list drifts. A durable list the model can query each turn collapses that
 * failure mode.
 */
function buildTodoTools(store: TodoStore): Record<string, AnyTool> {
  const priorityEnum = z.enum(["low", "medium", "high"]);
  const statusEnum = z.enum(["pending", "in_progress", "completed", "cancelled"]);

  return {
    todo_list: tool({
      description: [
        "List all todos for the current session with their status and priority.",
        "Use at the start of a multi-step task and after every few steps to re-orient.",
        "Empty list is fine — most short tasks don't need todos.",
      ].join(" "),
      inputSchema: zodSchema(z.object({}).strict()),
      execute: async () => {
        const items = store.list();
        if (items.length === 0) {
          return { items: [], hint: "No todos. Use todo_add to create one for multi-step work." };
        }
        return { items };
      },
    }),

    todo_add: tool({
      description: [
        "Append a todo to the session checklist. Use for tasks that take 3+ steps,",
        "branch into sub-tasks, or have distinct user-visible deliverables.",
        "Do NOT use for trivial single-step actions.",
      ].join(" "),
      inputSchema: zodSchema(z.object({
        content: z.string().min(1).max(500).describe("Short description, imperative voice (\"Fix X\", not \"Fixed X\")"),
        priority: priorityEnum.optional().describe("low | medium (default) | high"),
      })),
      execute: async ({ content, priority }) => {
        store.add(content, priority);
        return { ok: true, items: store.list() };
      },
    }),

    todo_update: tool({
      description: [
        "Update an existing todo by id. Use to mark pending → in_progress → completed,",
        "or to cancel a todo that's no longer relevant. Only ONE todo should be",
        "in_progress at a time.",
      ].join(" "),
      inputSchema: zodSchema(z.object({
        id: z.number().int().positive().describe("Todo id from todo_list"),
        status: statusEnum.optional(),
        content: z.string().min(1).max(500).optional(),
        priority: priorityEnum.optional(),
      })),
      execute: async ({ id, status, content, priority }) => {
        const ok = store.update(id, { status, content, priority });
        if (!ok) return { error: `No todo with id ${id}` };
        return { ok: true, items: store.list() };
      },
    }),

    todo_clear: tool({
      description: "Clear all todos for the current session. Use sparingly — typically only at the end of a large task when the list is stale.",
      inputSchema: zodSchema(z.object({}).strict()),
      execute: async () => {
        store.clear();
        return { ok: true, items: [] };
      },
    }),
  };
}

function buildTools(
  env: Env,
  workspace: Workspace,
  config: AppConfig,
  options?: BuildToolsOptions,
): Record<string, AnyTool> {
  const tools: Record<string, AnyTool> = {};

  const workspaceTools = createWorkspaceTools(workspace);
  const gitTools = buildGitTools(env, workspace, config, options?.ownerEmail);

  if (env.LOADER) {
    // Wrap OUTBOUND so codemode fetches from the AI-tool sandbox carry an
    // `x-dodo-owner-id` header — without it AllowlistOutbound can't resolve
    // the calling user's GitHub/GitLab tokens and falls back to no auth.
    // The HTTP `/execute` path already wraps via `runSandboxedCode`; this
    // closes the same gap for the agent-loop path. (audit follow-up F2)
    const outbound = wrapOutboundWithOwner(env.OUTBOUND ?? null, options?.ownerId);

    const codemodeTool = createExecuteTool({
      tools: workspaceTools,
      state: options?.stateBackend,
      loader: env.LOADER,
      timeout: 30_000,
      globalOutbound: outbound,
      providers: [
        { name: "git", tools: gitTools },
      ],
    });

    // Wrap codemode's execute to enforce an output cap and support
    // schema projection. Without this, a single `await fetch(...)` against
    // a large API in codemode can one-shot the input-token budget before
    // any downstream safeguard can react (see dodo session 56a7a597).
    const caps = TOOL_OUTPUT_CAPS.codemode ?? { maxBytes: 32_000 };
    const maxBytes = caps.maxBytes ?? 32_000;

    const originalExecute = (codemodeTool as AnyTool).execute as
      | ((args: unknown, ...rest: unknown[]) => Promise<unknown>)
      | undefined;

    if (originalExecute) {
      // Replace codemode's inputSchema with one that includes the `select`
      // field. Must be done at the schema level — AI SDK strips unknown
      // keys during Zod validation (and adds additionalProperties:false to
      // the schema sent to the model), so putting `select` only in the
      // description would mean the model never emits it and even if it did,
      // it'd be dropped before reaching our wrapped execute.
      const extendedInputSchema = zodSchema(
        z.object({
          code: z.string().describe("JavaScript async arrow function to execute"),
          select: z
            .array(z.string())
            .optional()
            .describe(
              "Optional dot-paths to project from the execution result (e.g. [\"items.0.name\", \"total_count\"]). Applied before the 32 KB cap — use for narrow API responses to avoid wasting context on unused fields.",
            ),
        }),
      );

      tools.codemode = {
        ...codemodeTool,
        // Extend the tool's description so the model knows about `select`.
        description: [
          (codemodeTool as AnyTool).description ?? "",
          "",
          "Output is capped at 32 KB. For large API responses, pass `select` — an array of dot-paths",
          "(e.g. [\"items.0.name\", \"total_count\"]) — and the result is projected to those fields",
          "before being returned. This saves context for the full multi-step loop.",
        ].filter(Boolean).join("\n"),
        inputSchema: extendedInputSchema,
        execute: async (args: unknown, ...rest: unknown[]) => {
          // Extract + strip the `select` field before forwarding to the
          // underlying executor (which doesn't know about it).
          let select: string[] | undefined;
          if (args && typeof args === "object") {
            const a = args as { select?: unknown };
            if (Array.isArray(a.select) && a.select.every((s) => typeof s === "string")) {
              select = a.select as string[];
            }
          }
          const cleanArgs = args && typeof args === "object"
            ? (() => {
                const { select: _discard, ...rest } = args as { select?: unknown };
                return rest;
              })()
            : args;

          const result = await originalExecute(cleanArgs, ...rest);

          // Schema projection — apply BEFORE size cap so the projected result
          // is what counts against the budget.
          const projected = select ? projectCodemodeResult(result, select) : result;
          return capCodemodeResult(projected, maxBytes);
        },
      } as AnyTool;
    } else {
      tools.codemode = codemodeTool;
    }
  }

  // Workspace tools — available as top-level tools alongside codemode.
  // `list` and `find` are excluded from the top-level set to prevent the
  // model from using them for open-ended discovery (which fills the context
  // window with raw file listings). They remain available inside the
  // `explore` subagent where they run in a separate context window.
  const { list: _list, find: _find, ...topLevelWsTools } = workspaceTools;
  Object.assign(tools, capToolOutputs(topLevelWsTools));

  // Replace-all tool — complements the edit tool for bulk string replacements.
  // The edit tool requires a unique old_string match (fails on duplicates).
  // This tool replaces ALL occurrences, which is useful for renaming variables,
  // fixing repeated patterns in minified files, or updating imports.
  tools.replace_all = tool({
    description: "Replace ALL occurrences of a string in a file. Unlike edit (which requires a unique match), this replaces every occurrence. Use for renaming variables, updating repeated patterns, or fixing minified files where the same substring appears multiple times.",
    inputSchema: z.object({
      path: z.string().describe("Absolute path to the file"),
      old_string: z.string().min(1).describe("Exact text to find (all occurrences will be replaced)"),
      new_string: z.string().describe("Replacement text"),
    }),
    execute: async ({ path, old_string, new_string }: { path: string; old_string: string; new_string: string }) => {
      // Normalize and reject `..` traversal — matches the HTTP file
      // handlers in coding-agent.ts so a tool can't reach outside the
      // workspace by stringing `..` segments. (audit finding M11)
      let normalized: string;
      try {
        normalized = normalizePath(path);
      } catch (error) {
        return { error: error instanceof Error ? error.message : "Invalid path" };
      }
      const content = await workspace.readFile(normalized);
      if (content === null) return { error: `File not found: ${normalized}` };
      if (!content.includes(old_string)) return { error: "old_string not found in file. Read the file first to verify the exact text." };
      const count = content.split(old_string).length - 1;
      const newContent = content.replaceAll(old_string, new_string);
      await workspace.writeFile(normalized, newContent);
      return { path: normalized, replacements: count, old_string, new_string };
    },
  });

  // Git tools — always available as top-level tools
  Object.assign(tools, gitTools);

  // Explore tool — search subagent for token-efficient codebase discovery.
  // When `config.exploreMode === "facet"`, the tool delegates to an
  // ExploreAgent facet DO; see `buildExploreTool` for the branch.
  tools.explore = buildExploreTool(workspace, config, env, options?.parentAgent);

  // Task tool — generic subagent for bounded sub-tasks. Keeps the main
  // conversation's step budget free when a chunk of work can be safely
  // delegated to a fresh context window. When `config.taskMode === "facet"`,
  // delegates to a TaskAgent facet DO and unlocks scratch-workspace mode.
  tools.task = buildTaskTool(workspace, config, env, options?.parentAgent);

  // Skill tool — loads a SKILL.md body on demand. The <available_skills>
  // manifest in the system prompt lists name + description per skill;
  // this tool returns the full body when the model picks one. Two-stage
  // progressive disclosure mirrors Claude Code / OpenCode.
  if (options?.parentAgent?.renderSkillForTool) {
    tools.skill = buildSkillTool(options.parentAgent);
  }

  // Todo tools — durable checklist backed by per-session SQLite. Helps the
  // model stay oriented across long multi-step tasks and compactions.
  if (options?.todoStore) {
    Object.assign(tools, buildTodoTools(options.todoStore));
  }

  // Browser tools — full CDP access via code-mode pattern.
  // Two tools: browser_search (query the ~1.7MB CDP spec server-side) and
  // browser_execute (run CDP commands against a live headless Chrome session).
  // Gated on: BROWSER + LOADER bindings exist, session has browser enabled,
  // AND the session owner is admin. Non-admin users get browser via the MCP
  // path (which bills to their own Cloudflare account).
  if (env.BROWSER && env.LOADER && options?.browserEnabled && options?.isAdminUser) {
    const browserTools = createBrowserTools({
      browser: env.BROWSER,
      loader: env.LOADER,
      timeout: 30_000,
      env,
      sessionId: options?.sessionId,
      ownerEmail: options?.ownerEmail,
      onAttachments: options?.onToolAttachments,
    });
    Object.assign(tools, browserTools);
  }

  return tools;
}

/**
 * Build the tool set for Think's getTools() override.
 * If mcpGatekeepers are provided, their tools are merged into the set.
 */
export function buildToolsForThink(
  env: Env,
  workspace: Workspace,
  config: AppConfig,
  options?: BuildToolsOptions & {
    agent?: { mcp?: unknown };
    mcpGatekeepers?: McpGatekeeper[];
  },
): Record<string, AnyTool> {
  const tools = buildTools(env, workspace, config, options);
  const existingNames = new Set(Object.keys(tools));

  if (options?.mcpGatekeepers?.length) {
    const mcpTools = buildMcpTools(options.mcpGatekeepers, existingNames);
    Object.assign(tools, mcpTools);
    Object.keys(mcpTools).forEach((name) => existingNames.add(name));
  }

  // Phase 1 OAuth path: tools federated from the per-user hub DO. The tool
  // list is pre-fetched; execute() routes back to the hub via the provided
  // executor so OAuth credentials never leave that DO.
  if (options?.oauthTools?.length && options.oauthToolExec) {
    const oauthTools = buildOAuthMcpTools(options.oauthTools, options.oauthToolExec, existingNames);
    Object.assign(tools, oauthTools);
  }

  return tools;
}

/**
 * Convert connected MCP gatekeeper tools into AI SDK tool() objects.
 *
 * Each gatekeeper's tools are already namespaced (e.g. "agent-memory__read")
 * by the gatekeeper's listTools(). We use jsonSchema() passthrough for the
 * input schema since MCP tools define JSON Schema directly, not Zod.
 */
function buildMcpTools(gatekeepers: McpGatekeeper[], existingNames: Set<string>): Record<string, AnyTool> {
  const tools: Record<string, AnyTool> = {};

  for (const gk of gatekeepers) {
    // listTools() returns cached results after initial connect — synchronous-safe
    // if the gatekeeper has already been connected and tools listed.
    const cachedTools = gk.getCachedTools();
    if (!cachedTools) continue;

    for (const mcpTool of cachedTools) {
      if (existingNames.has(mcpTool.name) || tools[mcpTool.name]) continue;
      tools[mcpTool.name] = tool({
        description: mcpTool.description ?? `MCP tool: ${mcpTool.name}`,
        inputSchema: mcpTool.inputSchema
          ? jsonSchema(mcpTool.inputSchema as Record<string, unknown>)
          : jsonSchema({ type: "object", properties: {} }),
        execute: async (args: unknown) => {
          const result = await gk.callTool(mcpTool.name, args);
          if (result.isError) {
            const errText = result.content.map((c) => c.text ?? "").join("\n");
            return { error: errText || "MCP tool call failed" };
          }
          // Return text content joined — the LLM can parse it
          return result.content
            .map((c) => c.text ?? "")
            .filter(Boolean)
            .join("\n");
        },
      });
    }
  }

  return tools;
}

function slugifyToolNamespace(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "mcp-unnamed";
}

/**
 * Build AI SDK tool() objects from the per-user OAuth hub's tool list.
 *
 * The tool list has already been fetched via RPC (`listOAuthTools`) from
 * the per-user CodingAgent DO. `execute()` routes calls back to that hub
 * via the provided executor (`callOAuthToolViaHub`), so OAuth credentials
 * never leave the hub DO.
 *
 * Tool names are prefixed with a slug of the server's display name to
 * avoid collisions across servers. Capped at 64 chars to satisfy AI SDK
 * naming constraints. Collisions after truncation are logged.
 */
function buildOAuthMcpTools(
  oauthTools: OAuthToolInfo[],
  executor: (serverId: string, name: string, args: unknown) => Promise<unknown>,
  existingNames: Set<string>,
): Record<string, AnyTool> {
  const tools: Record<string, AnyTool> = {};

  for (const info of oauthTools) {
    if (!info.name || !info.serverId) {
      console.warn("[oauth-mcp] Skipping tool with missing name or serverId:", info);
      continue;
    }

    const display = info.displayName ?? info.serverId;
    const slug = slugifyToolNamespace(display);
    const fullName = `${slug}__${info.name}`;
    const prefixedName = fullName.length > 64 ? fullName.slice(0, 64) : fullName;

    if (existingNames.has(prefixedName) || tools[prefixedName]) {
      console.warn("[oauth-mcp] Skipping duplicate tool name:", { prefixedName, serverId: info.serverId, original: info.name });
      continue;
    }

    tools[prefixedName] = tool({
      description: info.description ?? `OAuth MCP tool: ${info.name}`,
      inputSchema: info.inputSchema
        ? jsonSchema(info.inputSchema)
        : jsonSchema({ type: "object", properties: {} }),
      execute: async (args: unknown) => {
        try {
          return await executor(info.serverId, info.name, args);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { error: `OAuth MCP tool call failed: ${msg}` };
        }
      },
    });
    existingNames.add(prefixedName);
  }

  return tools;
}
