import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { StateBackend } from "@cloudflare/shell";
import { generateText, jsonSchema, stepCountIs, tool, zodSchema, type Tool as AnyToolType } from "ai";
import { z } from "zod";
import type { Workspace } from "@cloudflare/shell";
import type { AttachmentRef } from "./attachments";
import { createWorkspaceGit, defaultAuthor, resolveRemoteToken, verifyRemoteBranch } from "./git";
import { createBrowserTools } from "./browser/tools";
import type { McpGatekeeper, McpToolInfo } from "./mcp-gatekeeper";
import { getKnownRepo, listKnownRepos } from "./repos";
import { createWorkspaceTools, createExecuteTool } from "./think-adapter";
import type { AppConfig, Env } from "./types";

/** Options passed through from the coding agent into tool factories. */
export interface BuildToolsOptions {
  authorEmail?: string;
  browserEnabled?: boolean;
  isAdminUser?: boolean;
  ownerId?: string;
  ownerEmail?: string;
  stateBackend?: StateBackend;
  /** Session ID — required to scope attachment R2 keys. */
  sessionId?: string;
  /**
   * Fires when a tool produces image attachments. The coding agent uses this
   * to stream `tool_result_image` SSE events so the chat UI renders screenshots
   * before the assistant message finishes persisting.
   */
  onToolAttachments?: (toolCallId: string, attachments: AttachmentRef[]) => void;
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
function capToolOutputs(tools: Record<string, AnyTool>): Record<string, AnyTool> {
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
function capCodemodeResult(result: unknown, maxBytes: number): unknown {
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
function projectCodemodeResult(result: unknown, paths: string[]): unknown {
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

export function buildProvider(config: AppConfig, env: Env) {
  const isOpencode = config.activeGateway === "opencode";
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

  // Enable Anthropic prompt caching for anthropic/* models. When the
  // underlying provider is Anthropic (either directly via OpenCode gateway
  // or via AI Gateway's Anthropic route), sending the request body with
  // cache_control markers unlocks ~90% input-cost reduction on multi-turn
  // sessions with a stable system prompt + tools definition. On other
  // providers, the extra fields are ignored.
  const isAnthropicModel = config.model.startsWith("anthropic/");

  const provider = createOpenAICompatible({
    baseURL,
    headers,
    includeUsage: true,
    name: config.activeGateway,
    transformRequestBody: isAnthropicModel ? addAnthropicCacheMarkers : undefined,
  });

  // Wrap `chatModel` / `languageModel` / the callable provider so callers can pass
  // the user-facing id (e.g. `@cf/moonshotai/kimi-k2.6`) and we translate it to the
  // wire format (`workers-ai/@cf/moonshotai/kimi-k2.6`) exactly once, at the edge.
  const translate = (modelId: string) => resolveWireModelId(modelId, config.activeGateway);
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
      description: "Clone a built-in known repository by id. Use this instead of free-form URLs when possible.",
      inputSchema: zodSchema(z.object({
        repoId: z.enum(knownRepoIds as ["dodo"]).describe("Known repo id"),
        dir: z.string().optional().describe("Target directory (defaults to repo's standard dir)"),
        branch: z.string().optional().describe("Branch to clone (defaults to repo default branch)"),
        depth: z.number().optional().describe("Clone depth. Default: 1. Use 0 for full history."),
      })),
      execute: async ({ repoId, dir, branch, depth }) => {
        const repo = getKnownRepo(repoId);
        const targetDir = dir ?? repo.dir;
        const token = await resolveRemoteToken({ dir: targetDir, env, git, ownerEmail, url: repo.url });
        const cloneDepth = depth === 0 ? undefined : (depth ?? 1);
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
      description: "Clone a git repo into the workspace. Auth is automatic for GitHub/GitLab. Clones are shallow (depth 1) by default. Pass depth 0 for full history.",
      inputSchema: zodSchema(z.object({
        url: z.string().describe("Git repo URL (e.g. https://github.com/owner/repo)"),
        dir: z.string().optional().describe("Target directory (default: repo name)"),
        branch: z.string().optional().describe("Branch to clone"),
        depth: z.number().optional().describe("Clone depth. Default: 1 (shallow). Use 0 for full history."),
      })),
      execute: async ({ url, dir, branch, depth }) => {
        const token = await resolveRemoteToken({ dir, env, git, url, ownerEmail });
        // depth 0 = full history (pass undefined to isomorphic-git), undefined = shallow default of 1
        const cloneDepth = depth === 0 ? undefined : (depth ?? 1);
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

const EXPLORE_SYSTEM_PROMPT = [
  "You are a search assistant. Your job is to find files and code relevant to the user's query.",
  "",
  "## Rules",
  "- Use grep, find, list, and read to search the workspace.",
  "- Be thorough: try multiple search terms if the first doesn't find results.",
  "- Return a concise summary when done: file paths, relevant line numbers, and key observations.",
  "- Do NOT return full file contents — only the relevant snippets (max 10 lines per file).",
  "- If you find too many results, narrow your search with more specific patterns.",
  "- Focus on answering the user's specific question, not cataloguing everything.",
].join("\n");

/** Max steps for the explore subagent. */
const EXPLORE_MAX_STEPS = 5;

/** Cheap model for the explore subagent, keyed by provider prefix.
 *  Falls back to the main model if no match (still works, just costs more). */
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
  return mainModel; // fallback: use the main model itself
}

/** Timeout for the explore subagent (ms). Prevents indefinite blocking. */
const EXPLORE_TIMEOUT_MS = 60_000;

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
): AnyTool {
  // Build read-only workspace tools for the explore subagent
  const allWsTools = createWorkspaceTools(workspace);
  const readOnlyTools = capToolOutputs({
    read: allWsTools.read,
    list: allWsTools.list,
    find: allWsTools.find,
    grep: allWsTools.grep,
  });

  return tool({
    description: [
      "Search the workspace for files and code matching a query.",
      "Runs an autonomous search agent that uses grep, find, list, and read to explore the codebase,",
      "then returns a compact summary of findings (file paths, line numbers, key observations).",
      "Much more token-efficient than reading files directly for open-ended searches.",
      "Use this when you need to find where something is defined, locate files matching a pattern,",
      "or understand how a feature is implemented across multiple files.",
    ].join(" "),
    inputSchema: zodSchema(z.object({
      query: z.string().min(1).describe(
        "What to search for — be specific. E.g. 'Find all files that handle CSS escaping' or 'Where is the database connection pool configured?'",
      ),
      scope: z.string().optional().describe(
        "Optional directory to scope the search to (e.g. 'src/' or 'lib/utils'). Omit to search the entire workspace.",
      ),
    })),
    execute: async ({ query, scope }: { query: string; scope?: string }) => {
      const provider = buildProvider(config, env);
      const exploreModelId = getExploreModel(config.model);
      const model = provider.chatModel(exploreModelId);

      const scopeHint = scope ? `\n\nSearch scope: ${scope}` : "";
      const userMessage = `${query}${scopeHint}`;

      try {
        const result = await generateText({
          model,
          system: EXPLORE_SYSTEM_PROMPT,
          messages: [{ role: "user" as const, content: userMessage }],
          tools: readOnlyTools,
          stopWhen: stepCountIs(EXPLORE_MAX_STEPS),
          maxOutputTokens: 2000,
          abortSignal: AbortSignal.timeout(EXPLORE_TIMEOUT_MS),
        });

        const summary = result.text;
        const steps = result.steps.length;
        const toolCalls = result.steps.flatMap(s =>
          (s.toolCalls ?? []).map(tc => tc.toolName),
        );

        // Return structured result for the main agent
        return [
          `## Explore results for: ${query}`,
          scope ? `**Scope:** ${scope}` : "",
          `**Search steps:** ${steps} | **Tools used:** ${toolCalls.join(", ") || "none"}`,
          "",
          summary || "(No results found)",
        ].filter(Boolean).join("\n");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `Explore failed: model: ${exploreModelId}. ${msg}. Try searching directly with grep.`;
      }
    },
  });
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
    const outbound = env.OUTBOUND ?? null;

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
          const cleanArgs = select && args && typeof args === "object"
            ? (() => {
                const { select: _, ...rest } = args as { select?: unknown };
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
      const content = await workspace.readFile(path);
      if (content === null) return { error: `File not found: ${path}` };
      if (!content.includes(old_string)) return { error: "old_string not found in file. Read the file first to verify the exact text." };
      const count = content.split(old_string).length - 1;
      const newContent = content.replaceAll(old_string, new_string);
      await workspace.writeFile(path, newContent);
      return { path, replacements: count, old_string, new_string };
    },
  });

  // Git tools — always available as top-level tools
  Object.assign(tools, gitTools);

  // Explore tool — search subagent for token-efficient codebase discovery
  tools.explore = buildExploreTool(workspace, config, env);

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
  options?: BuildToolsOptions & { mcpGatekeepers?: McpGatekeeper[] },
): Record<string, AnyTool> {
  const tools = buildTools(env, workspace, config, options);

  if (options?.mcpGatekeepers?.length) {
    const mcpTools = buildMcpTools(options.mcpGatekeepers);
    Object.assign(tools, mcpTools);
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
function buildMcpTools(gatekeepers: McpGatekeeper[]): Record<string, AnyTool> {
  const tools: Record<string, AnyTool> = {};

  for (const gk of gatekeepers) {
    // listTools() returns cached results after initial connect — synchronous-safe
    // if the gatekeeper has already been connected and tools listed.
    const cachedTools = gk.getCachedTools();
    if (!cachedTools) continue;

    for (const mcpTool of cachedTools) {
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


