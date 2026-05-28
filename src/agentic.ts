import type { StateBackend } from "@cloudflare/shell";
import { jsonSchema, tool, zodSchema } from "ai";
import { z } from "zod";
import type { Workspace } from "@cloudflare/shell";
import type { AttachmentRef } from "./attachments";
import { createWorkspaceGit, defaultAuthor, resolveRemoteToken, verifyRemoteBranch } from "./git";
import { createPullRequest } from "./github-api";
import { normalizePath } from "./paths";
import { createBrowserTools } from "./browser/tools";
import type { McpClient } from "./mcp-client";
import { getKnownRepo, listKnownRepos, parseRemoteSpec } from "./repos";
import {
  buildProviderForModel,
  capToolOutputs,
  runSubagentForProfile,
} from "./subagent-runner";
import {
  EXPLORE_PROFILE,
  TASK_PROFILE,
  resolveProfileModel,
  type AgentProfile,
} from "./agent-profile";
import { chatMonitorIdName, sendChatReaction, sendChatReply } from "./chat-monitor-agent";
import { createWorkspaceTools, createExecuteTool } from "./think-adapter";
import { createShellTool } from "./tools/shell";
import { runTypecheck } from "./typecheck";
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
  /**
   * When true, register a first-party (non-namespaced) `chat_reply` tool
   * so the brain's persona can refer to it by its plain name. The MCP
   * version (`<configId>__chat_reply` via Dodo Self) is suppressed to
   * avoid confusing the model with two functionally identical tools.
   */
  isChatMonitorBrain?: boolean;
  /** Google Chat space the brain is bound to, e.g. "spaces/AAQAfPyXnIc". */
  chatMonitorSpaceId?: string;
  stateBackend?: StateBackend;
    mcpGatekeepers?: McpClient[];
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
    /**
     * Read the current goal state. Returned to the `set_goal_status` tool
     * so the tool can refuse early when no goal is set (avoids confusion
     * if a model in a no-goal session calls the tool by mistake).
     */
    readGoalState?: () => {
      text: string | null;
      status: "none" | "active" | "done" | "blocked" | "needs_input" | "exhausted";
      turnsUsed: number;
      maxTurns: number;
    };
    /** Declare a terminal goal status from inside the `set_goal_status` tool. */
    declareGoalTerminal?: (
      status: "done" | "blocked" | "needs_input",
      summary: string,
    ) => { status: string; turnsUsed: number; maxTurns: number };
  };
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
/** Max bytes for a codemode `logs` field; kept separate from result. */
const CODEMODE_LOGS_MAX_BYTES = 4_000;

// ─── Canonical tool name surfaces (for drift detection & docs) ───
//
// These four sets describe what `buildTools()` MAY register at the top level
// across every session config. The UI's `src/tool-catalog.ts` describes the
// same surface for humans; `test/tool-catalog-unit.test.ts` cross-checks the
// two so a tool added/removed here without a matching catalog update fails
// the build.
//
// Hot-path git tools stay top-level so the common edit-commit loop doesn't
// pay a codemode round-trip; the rest live inside codemode's `git` provider.

/** Git tools registered as top-level orchestrator tools. */
export const KNOWN_TOP_LEVEL_GIT_TOOLS = [
  "git_status",
  "git_add",
  "git_commit",
  "git_diff",
] as const;

/** Git tools reachable only as `git.<name>` inside codemode. */
export const KNOWN_CODEMODE_GIT_TOOLS = [
  "git_clone",
  "git_clone_known",
  "git_push",
  "git_push_checked",
  "git_pull",
  "git_branch",
  "git_checkout",
  "git_log",
  "git_verify_remote_branch",
  "pr_create",
] as const;

/**
 * Tools that the orchestrator surfaces as `alwaysOn: true` in the UI
 * catalog. These are either unconditional (`explore`, `read`, …) or
 * conditional on infra a normal CodingAgent session always supplies
 * (`skill`, `todo_*` — gated in code on `parentAgent.renderSkillForTool`
 * / `options.todoStore`, both always set by CodingAgent.onChatMessage).
 *
 * Tools gated on env bindings or per-session config (codemode, browser_*)
 * live in KNOWN_CONDITIONAL_TOOL_NAMES instead — they're catalog
 * `alwaysOn: false`.
 */
export const KNOWN_ALWAYS_ON_TOOL_NAMES = [
  // Subagents
  "explore",
  "task",
  // Workspace ops (`list` and `find` are stripped — see agentic.ts comment)
  "read",
  "grep",
  "write",
  "edit",
  "delete",
  // Replace-all (dodo-specific addition alongside workspace tools)
  "replace_all",
  // Planning todos (always supplied by CodingAgent)
  "todo_list",
  "todo_add",
  "todo_update",
  "todo_clear",
  // Skill loader (always supplied by CodingAgent)
  "skill",
  // Typecheck
  "typecheck",
  // Shell — busybox + /workspace mount, always-on (no env binding)
  "shell",
  // Hot-path git
  ...KNOWN_TOP_LEVEL_GIT_TOOLS,
] as const;

/**
 * Tools registered top-level only when their env/config gate is set.
 * Catalog lists them with `alwaysOn: false` plus a caveat explaining the gate.
 */
export const KNOWN_CONDITIONAL_TOOL_NAMES = [
  "codemode",       // requires env.LOADER
  "browser_search", // requires browser bindings + admin + session config
  "browser_execute",
] as const;

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

export function buildProvider(config: AppConfig, env: Env) {
  return buildProviderForModel(config.model, config, env);
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
      // Call methods on `parent` directly — destructuring (e.g.
      // `const render = parent.renderSkillForTool`) strips the `this`
      // binding and the method's internal `this.getSkillByName(...)`
      // throws "Cannot read properties of undefined". (caught in prod
      // session 7ac07871 — first live test of the skill tool)
      if (typeof parent.renderSkillForTool !== "function") {
        return "skill tool unavailable — parent agent missing renderSkillForTool. This is a bug.";
      }
      const out = parent.renderSkillForTool(name);
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
  profile: AgentProfile;
  description: string;
  inputSchema: AnyTool;
  getUserMessage: (args: Record<string, unknown>) => string;
  getTools: () => Record<string, AnyTool>;
  config: AppConfig;
  env: Env;
  /** Per-session default for this subagent's model (from AppConfig). */
  sessionDefaultModel: string | undefined;
}): AnyTool {
  return tool({
    description: spec.description,
    inputSchema: spec.inputSchema,
    execute: async (args: Record<string, unknown>) => {
      const modelId = resolveProfileModel(
        spec.profile,
        args,
        spec.sessionDefaultModel,
        spec.config.model,
      );
      const userMessage = spec.getUserMessage(args);
      // Per-call result schema. Validated against the registry —
      // unknown names surface as a clear tool error rather than a
      // silent fallback to free-form output.
      const resultSchemaName = typeof args.resultSchemaName === "string" && args.resultSchemaName.trim().length > 0
        ? args.resultSchemaName.trim()
        : undefined;

      try {
        const result = await runSubagentForProfile(spec.profile, {
          prompt: userMessage,
          model: modelId,
          config: spec.config,
          toolset: spec.getTools(),
          env: spec.env,
          resultSchemaName,
        });

        const usageLine = result.tokenInput > 0 || result.tokenOutput > 0
          ? `**Tokens:** ${result.tokenInput} in / ${result.tokenOutput} out | `
          : "";

        const lines = [
          `## ${spec.profile.name} results (model: ${modelId})`,
          `${usageLine}**Steps:** ${result.steps} | **Tools used:** ${result.toolCalls.join(", ") || "none"}`,
          "",
          result.finalText || "(No output — subagent ran its tool budget without emitting a summary. Try a narrower query or a higher-capability model via the `model` arg.)",
        ];

        // Append the structured-result block when the caller asked for
        // one. The free-form text stays above so the model can see both
        // representations — useful when the structured pass coerces a
        // detail away that the orchestrator still wants to read.
        if (result.structured) {
          lines.push("");
          if (result.structured.ok) {
            lines.push("### Structured result");
            lines.push("```json");
            lines.push(JSON.stringify(result.structured.data, null, 2));
            lines.push("```");
          } else {
            lines.push("### Structured result (failed)");
            lines.push(`Coercion error: ${result.structured.lastError}`);
            lines.push("The free-form output above is the authoritative result.");
          }
        }

        return lines.filter(Boolean).join("\n");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const base = `${spec.profile.name} failed (model: ${modelId}): ${msg}`;
        // The fallback hint is profile-defined — explore declares one,
        // task does not. Profiles without a hint just get the plain
        // failure summary (task subagent failures don't have a clean
        // fallback path because they can write, and the orchestrator
        // can't reliably substitute).
        return spec.profile.fallbackHint ? `${base}\n${spec.profile.fallbackHint}` : base;
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
            return `Explore failed (facet mode): ${msg}\n${EXPLORE_PROFILE.fallbackHint ?? ""}`;
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
        let allFailed = true;
        for (let i = 0; i < settled.length; i++) {
          const q = queries[i];
          const outcome = settled[i];
          blocks.push(`## Query ${i + 1}: ${q}`, "");
          if (outcome.status === "fulfilled") {
            blocks.push(outcome.value.summary, "");
            allFailed = false;
          } else {
            const reason = outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason);
            blocks.push(`(query ${i + 1} failed: ${reason})`, "");
          }
        }
        // Only attach the global recovery hint if every query failed —
        // partial success is still useful and the per-query failure
        // lines stand on their own.
        if (allFailed && EXPLORE_PROFILE.fallbackHint) blocks.push(EXPLORE_PROFILE.fallbackHint);
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
    profile: EXPLORE_PROFILE,
    description: "internal — wrapped below",
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
    profile: TASK_PROFILE,
    description: [
      "Delegate a focused, bounded sub-task to a subagent with its own context window.",
      "The subagent gets workspace tools (read, list, find, grep, write, edit) and returns a compact summary.",
      "Use for multi-step sub-tasks that would otherwise eat the main conversation's step budget and context:",
      "'update all imports of X to Y', 'review these 6 files and list bugs', 'rename MyClass to TheirClass everywhere'.",
      "Do NOT use for one-shot operations (just call the tool directly) or anything requiring git/codemode/browser.",
      "NOTE: in-process mode always shares the main workspace. Switch to taskMode=facet to enable scratch workspaces.",
    ].join(" "),
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
      resultSchemaName: z.enum(["task-summary", "verify-run-summary", "dispatch-decision"]).optional().describe(
        "Optional structured-result schema. When set, the subagent's free-form output is coerced into the named schema and returned in a ```json block alongside the narrative. 'task-summary' is the most common choice for delegated work; 'verify-run-summary' for typecheck/test-style runs; 'dispatch-decision' for supervisor-style fan-out planning.",
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
/**
 * `set_goal_status` — the model's only way to stop the auto-continue
 * loop when a goal is active. Kept deliberately small: three statuses,
 * one mandatory summary. Refuses to fire when there's no active goal so
 * a stray call in a regular chat session is a no-op error rather than
 * silently writing nonsense to metadata.
 */
function buildGoalStatusTool(parent: NonNullable<BuildToolsOptions["parentAgent"]>): AnyTool {
  return tool({
    description: [
      "Declare your session's goal is at a terminal state. The session has been auto-continuing this prompt until you call this tool.",
      "",
      "- `done` — goal achieved. Include a one-line summary of what was done.",
      "- `blocked` — you genuinely cannot proceed. Explain the blocker.",
      "- `needs_input` — a human decision is required. Explain what's needed; the owner will be notified.",
      "",
      "Only call this when you've actually reached a terminal state. Don't call it just to narrate progress.",
    ].join("\n"),
    inputSchema: zodSchema(z.object({
      status: z.enum(["done", "blocked", "needs_input"]).describe("Terminal state."),
      summary: z.string().min(1).max(2000).describe("One- or two-line summary of the outcome."),
    }).strict()),
    execute: async ({ status, summary }) => {
      const state = parent.readGoalState?.();
      if (!state || state.status === "none" || !state.text) {
        return {
          ok: false,
          error: "No active goal on this session. set_goal_status only applies when a goal is set via PUT /session/:id/goal or the autopilot kickoff flow.",
        };
      }
      if (state.status !== "active") {
        return {
          ok: false,
          error: `Goal is already in terminal state '${state.status}'. Cannot set status again.`,
        };
      }
      const result = parent.declareGoalTerminal?.(status, summary);
      return {
        ok: true,
        status: result?.status ?? status,
        turnsUsed: result?.turnsUsed ?? state.turnsUsed,
        maxTurns: result?.maxTurns ?? state.maxTurns,
      };
    },
  });
}

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

/**
 * Build a first-party (non-MCP, non-namespaced) `chat_reply` tool for
 * chat-monitor brain sessions. The matching MCP tool (registered under
 * `Dodo Self`) is namespaced as `<configId>__chat_reply` once it's pulled
 * through `buildMcpTools`, which makes it invisible to a persona prompt
 * that tells the model to call literally `chat_reply`. Registering a
 * local tool sidesteps the namespacing entirely.
 *
 * The MCP variant in `mcp-shared.ts` performs caller-flag verification at
 * call time. We can skip that here because the surrounding code only
 * passes `isChatMonitorBrain: true` after reading the same flag from the
 * session's metadata — the auth check has already happened.
 */
function buildChatReplyTool(env: Env, opts: {
  sessionId: string;
  ownerEmail: string;
  spaceId: string;
}): AnyTool {
  return tool({
    description: "Post a reply to the Google Chat space this brain is bound to. Pass `text` for a real reply, or the literal string `<NO_REPLY>` to acknowledge the message without posting anything (use when silence is the right answer). Always pass `messageName` (the value of `[Message resource: ...]` in the prompt header) so loading/done reactions on the original message can be managed. `threadName` is optional — supply it to reply in-thread.",
    inputSchema: zodSchema(
      z.object({
        text: z.string().min(1).max(2000).describe("Reply text. Plain text only. Use the literal `<NO_REPLY>` to mark the turn handled without posting."),
        threadName: z.string().optional().describe("Full thread resource name like `spaces/X/threads/Y` to reply in-thread."),
        messageName: z.string().optional().describe("The `[Message resource: ...]` value from the prompt header. Required for reaction bookkeeping."),
      }),
    ),
    execute: async (args: unknown) => {
      const { text, threadName, messageName } = args as {
        text: string;
        threadName?: string;
        messageName?: string;
      };
      const isNoReply = text.trim() === "<NO_REPLY>";

      // Reaction housekeeping (best-effort).
      if (messageName) {
        const reactionEmoji = ":loading-loading-forever:";
        const doneEmoji = ":b-yes-check:";
        await sendChatReaction(env, {
          messageName,
          emoji: reactionEmoji,
          action: "remove",
        }).catch(() => {});
        if (!isNoReply) {
          await sendChatReaction(env, {
            messageName,
            emoji: doneEmoji,
            action: "add",
          }).catch(() => {});
        }
        try {
          const monitorId = chatMonitorIdName(opts.ownerEmail, opts.spaceId);
          const monitorStub = env.CHAT_MONITOR.get(env.CHAT_MONITOR.idFromName(monitorId));
          await monitorStub.fetch("https://chat-monitor/clear-reaction", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ messageName }),
          });
        } catch {
          // non-fatal
        }
      }

      if (isNoReply) {
        return { posted: false, reason: "no_reply_tombstone", spaceId: opts.spaceId };
      }

      const result = await sendChatReply(env, {
        spaceId: opts.spaceId,
        text,
        threadName,
      });
      if (!result.ok) {
        return { error: "ARIA send failed", status: result.status, body: result.body };
      }
      return { posted: true, spaceId: opts.spaceId, threadName: threadName ?? null };
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

  // Chat-monitor brain: register the first-party `chat_reply` BEFORE
  // anything else so its bare name wins over any MCP equivalent.
  if (
    options?.isChatMonitorBrain &&
    options.chatMonitorSpaceId &&
    options.ownerEmail &&
    options.sessionId
  ) {
    tools.chat_reply = buildChatReplyTool(env, {
      sessionId: options.sessionId,
      ownerEmail: options.ownerEmail,
      spaceId: options.chatMonitorSpaceId,
    });
  }

  const workspaceTools = createWorkspaceTools(workspace);
  const gitTools = buildGitTools(env, workspace, config, options?.ownerEmail);

  if (env.LOADER) {
    // Pass the real OUTBOUND ServiceStub directly. workerd rejects any
    // wrapper (plain object cast as Fetcher) with "Incorrect type for the
    // 'globalOutbound' field on 'WorkerCode'". AllowlistOutbound still
    // enforces the hostname allowlist for every sandbox fetch — the
    // perimeter is unchanged. Per-user token injection for raw fetch is
    // currently unavailable (see src/outbound.ts OWNER_ID_HEADER history);
    // git operations are unaffected because resolveRemoteToken() runs in
    // the parent DO and tokens are passed directly to isomorphic-git.
    void options?.ownerId; // accepted for API compat — not threaded through

    const codemodeTool = createExecuteTool({
      tools: workspaceTools,
      state: options?.stateBackend,
      loader: env.LOADER,
      timeout: 30_000,
      globalOutbound: env.OUTBOUND ?? null,
      providers: [
        { name: "git", tools: gitTools },
      ],
    });

    // Wrap codemode's execute to enforce an output cap and support
    // schema projection. Without this, a single `await fetch(...)` against
    // a large API in codemode can one-shot the input-token budget before
    // any downstream safeguard can react (see dodo session 56a7a597).
    const maxBytes = 32_000;

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

  // Shell tool — busybox-in-a-worker with /workspace mounted. Pure-code,
  // no env binding required (busybox.wasm + initramfs.wasm bundle into the
  // Worker via wrangler's CompiledWasm rule). Lives alongside codemode:
  // codemode for JS/API-shaped work, shell for pipelines and file ops.
  tools.shell = createShellTool(workspace);

  // Git tools — only the hot-path subset is exposed at the top level.
  // See KNOWN_TOP_LEVEL_GIT_TOOLS / KNOWN_CODEMODE_GIT_TOOLS module-scope
  // constants (below) for the full split. The drift test in
  // test/tool-catalog-unit.test.ts pivots on these names.
  for (const name of KNOWN_TOP_LEVEL_GIT_TOOLS) {
    if (gitTools[name]) tools[name] = gitTools[name];
  }

  // Typecheck tool — runs `tsc --noEmit` against the workspace inside this
  // DO. No subprocess, no native binaries: bundles the TypeScript compiler
  // and lib `.d.ts` files into the Worker. Closes the long-standing "the
  // sandbox can't run npm run typecheck" gap without introducing any
  // container-specific assumption (per AGENTS.md).
  //
  // Heap-safe: refuses projects > 50 files / > 5 MB up front. Lazy-imports
  // the TS compiler so non-typecheck cold starts pay nothing.
  tools.typecheck = tool({
    description: [
      "Run TypeScript type checking (`tsc --noEmit`) against the workspace.",
      "",
      "Use this after writing or editing TypeScript code to confirm it type-checks before",
      "you commit or push. Returns a structured list of diagnostics with file paths, line",
      "numbers, error codes, and messages — feed those back into your next edit.",
      "",
      "Honours the workspace's `tsconfig.json` if one exists at the dir root; falls back to",
      "Dodo's defaults (ES2022 target, bundler resolution, strict, isolatedModules).",
      "",
      "Pass `extraStrict: true` to also catch unused locals/parameters, missing returns, and",
      "switch fall-through. This is a cheap stand-in for a real linter — no extra bundle",
      "weight, but layered on top of the user's `tsconfig.json` for this run only.",
      "",
      "Limits: refuses projects with more than 50 .ts/.tsx files or more than 5 MB of source.",
      "If you hit that, narrow the typecheck to a subdirectory by passing `dir`.",
    ].join("\n"),
    inputSchema: zodSchema(
      z.object({
        dir: z
          .string()
          .optional()
          .describe(
            "Subdirectory to root the typecheck in (e.g. 'my-repo'). Defaults to the workspace root.",
          ),
        extraStrict: z
          .boolean()
          .optional()
          .describe(
            "When true, layers noUnusedLocals + noUnusedParameters + noImplicitReturns + noFallthroughCasesInSwitch on top of the user's tsconfig.json for this run.",
          ),
      }),
    ),
    execute: async ({ dir, extraStrict }) => {
      const result = await runTypecheck(workspace, { dir, extraStrict });
      // Cap diagnostics array so a project with 1000 errors doesn't blow
      // the per-tool 32 KB budget. The model sees "+ N more — fix the
      // shown ones first, then re-run" which is the right loop anyway.
      const MAX_DIAGS = 100;
      if (result.diagnostics.length > MAX_DIAGS) {
        const dropped = result.diagnostics.length - MAX_DIAGS;
        return {
          ...result,
          diagnostics: result.diagnostics.slice(0, MAX_DIAGS),
          _truncated: `Showing first ${MAX_DIAGS} of ${result.diagnostics.length} diagnostics. Fix these and re-run typecheck — ${dropped} more remain.`,
        };
      }
      return result;
    },
  });

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

  // Goal status tool — only present when the parent agent exposes the
  // goal hooks. Lets a session that has a goal declare it complete /
  // blocked / needs_input so the auto-continue loop can stop.
  if (options?.parentAgent?.declareGoalTerminal && options?.parentAgent?.readGoalState) {
    tools.set_goal_status = buildGoalStatusTool(options.parentAgent);
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
  mcpGatekeepers?: McpClient[];
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
function buildMcpTools(gatekeepers: McpClient[], existingNames: Set<string>): Record<string, AnyTool> {
  const tools: Record<string, AnyTool> = {};

  // When a first-party `chat_reply` is already registered (chat-monitor
  // brain path), suppress the MCP namespaced equivalent so the model
  // doesn't see two functionally identical tools.
  const suppressChatReplyMcp = existingNames.has("chat_reply");

  for (const gk of gatekeepers) {
    // listTools() returns cached results after initial connect — synchronous-safe
    // if the gatekeeper has already been connected and tools listed.
    const cachedTools = gk.getCachedTools();
    if (!cachedTools) continue;

    for (const mcpTool of cachedTools) {
      if (existingNames.has(mcpTool.name) || tools[mcpTool.name]) continue;
      if (suppressChatReplyMcp && mcpTool.name.endsWith("__chat_reply")) continue;
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
