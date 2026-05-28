import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAgentByName } from "agents";
import { z } from "zod";
import { getSharedIndexStub, getUserControlStub, isAdmin, resolveAdminEmail } from "./auth";
import { chatMonitorIdName, createMonitorSchema } from "./chat-monitor-agent";
import { log } from "./logger";
import { messageLimiter, promptLimiter } from "./rate-limit";
import { createDraftPrForRun, createGithubRepo, pollVerifyWorkflow, triggerVerifyWorkflow } from "./github-api";
import { getKnownRepo, listKnownRepos } from "./repos";
import { forkSessionInternal, SourceSessionMissingError } from "./sessions";
import { errorResult, mcpUserEmail, propagateMcpDepth, registerChatReplyTool } from "./mcp-shared";
import { queryRecentExceptions, querySessionLogs, queryWorkerLogs } from "./cloudflare-logs";
import type { CodingAgent } from "./coding-agent";
import type { Env, WorkerRunRecord } from "./types";
import { dispatchWorkflow } from "./workflows/mcp-adapter";
import { makeRepoEditsWorkflow, type RepoEditsDeps } from "./workflows/repo-edits";
import { makeRepoPromptWorkflow, type RepoPromptDeps } from "./workflows/repo-prompt";
import { makeVerifyRunWorkflow, type VerifyRunDeps, type WorkerRunSnapshot } from "./workflows/verify-run";

/**
 * Check whether the caller has at least `required` permission on the session.
 *
 * Without this check, any user with a valid MCP token could read/write/execute
 * code in any session whose UUID they can learn (audit finding H3). The
 * permission check covers:
 *   - direct ownership in the caller's UserControl
 *   - platform admin
 *   - granted permission in SharedIndex (readonly/readwrite)
 *
 * Share-cookie guests are intentionally NOT honoured for MCP — MCP tokens
 * authenticate a user identity, not a guest browser session.
 */
export async function checkSessionPermission(
  env: Env,
  email: string,
  sessionId: string,
  required: "readonly" | "write" | "admin",
): Promise<{ allowed: boolean; permission: "readonly" | "write" | "admin" | null }> {
  const PERMISSION_LEVELS: Record<string, number> = { readonly: 0, readwrite: 1, write: 1, admin: 2 };

  // Owner check via the caller's UserControl
  const stub = getUserControlStub(env, email);
  const ownerCheck = await stub.fetch(
    `https://user-control/sessions/${encodeURIComponent(sessionId)}/check`,
    { headers: { "x-owner-email": email } },
  );
  if (ownerCheck.ok) {
    return { allowed: true, permission: "admin" };
  }

  // Platform admin
  if (isAdmin(email, env)) {
    return { allowed: true, permission: "admin" };
  }

  // SharedIndex grant
  const sharedStub = getSharedIndexStub(env);
  const permRes = await sharedStub.fetch(
    `https://shared-index/permissions/${encodeURIComponent(sessionId)}/${encodeURIComponent(email)}`,
  );
  if (permRes.ok) {
    const perm = (await permRes.json()) as { permission: string };
    let granted: "readonly" | "write" | "admin" | null = null;
    if (perm.permission === "readwrite") granted = "write";
    else if (perm.permission === "readonly") granted = "readonly";
    if (granted && (PERMISSION_LEVELS[granted] ?? -1) >= (PERMISSION_LEVELS[required] ?? 999)) {
      return { allowed: true, permission: granted };
    }
    return { allowed: false, permission: granted };
  }

  return { allowed: false, permission: null };
}

/**
 * Charge the shared `promptLimiter` for an MCP-driven prompt dispatch.
 * Returns null when the request is allowed; an MCP errorResult when
 * over budget. (audit follow-up F3)
 *
 * Uses the same `prompt:${email}` and `msg:${email}` keys as the HTTP
 * routes so MCP traffic and interactive traffic share one budget per
 * user.
 */
export function checkPromptBudget(email: string): { content: Array<{ type: "text"; text: string }>; isError: true } | null {
  const rl = promptLimiter.check(`prompt:${email}`, 60, 60 * 60 * 1000);
  if (!rl.allowed) {
    return errorResult({
      error: "Too many prompts (per-user hourly limit hit)",
      retryAfter: rl.retryAfter ?? 60,
    });
  }
  return null;
}

export function checkMessageBudget(email: string): { content: Array<{ type: "text"; text: string }>; isError: true } | null {
  const rl = messageLimiter.check(`msg:${email}`, 120, 60 * 60 * 1000);
  if (!rl.allowed) {
    return errorResult({
      error: "Too many messages (per-user hourly limit hit)",
      retryAfter: rl.retryAfter ?? 60,
    });
  }
  return null;
}

export function checkGenerateBudget(email: string): { content: Array<{ type: "text"; text: string }>; isError: true } | null {
  // Mirrors the HTTP /generate route — both an hourly and a daily cap on
  // FLUX image generation since it's pay-per-call.
  const hr = promptLimiter.check(`generate-hr:${email}`, 30, 60 * 60 * 1000);
  if (!hr.allowed) return errorResult({ error: "Too many image generations (hourly limit)", retryAfter: hr.retryAfter ?? 60 });
  const day = promptLimiter.check(`generate-day:${email}`, 100, 24 * 60 * 60 * 1000);
  if (!day.allowed) return errorResult({ error: "Too many image generations (daily limit)", retryAfter: day.retryAfter ?? 60 });
  return null;
}

/** Convenience wrapper that turns a denied check into an MCP error result. */
export async function ensureSessionAccess(
  env: Env,
  userEmail: string | undefined,
  sessionId: string,
  required: "readonly" | "write" | "admin",
): Promise<{ ok: true } | { ok: false; result: { content: Array<{ type: "text"; text: string }>; isError: true } }> {
  const email = mcpUserEmail(env, userEmail);
  const check = await checkSessionPermission(env, email, sessionId, required);
  if (!check.allowed) {
    return {
      ok: false,
      result: errorResult({
        error: `Session '${sessionId}' not found or access denied (need '${required}' permission)`,
      }),
    };
  }
  return { ok: true };
}

async function userControlFetch(env: Env, path: string, init?: RequestInit, userEmail?: string): Promise<Response> {
  const email = mcpUserEmail(env, userEmail);
  const stub = getUserControlStub(env, email);
  const headers = new Headers(init?.headers);
  headers.set("x-owner-email", email);
  return stub.fetch(`https://user-control${path}`, { ...init, headers });
}

async function sharedIndexFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const stub = getSharedIndexStub(env);
  return stub.fetch(`https://shared-index${path}`, init);
}

async function agentFetch(env: Env, sessionId: string, path: string, init?: RequestInit, depth = 0, userEmail?: string): Promise<Response> {
  const agent = await getAgentByName(env.CODING_AGENT as never, sessionId);
  const email = mcpUserEmail(env, userEmail);
  const headers = new Headers(init?.headers);
  headers.set("x-dodo-session-id", sessionId);
  headers.set("x-owner-email", email);
  propagateMcpDepth(headers, depth);

  // Inject gateway config for message/prompt routes
  if (path === "/message" || path === "/prompt") {
    const configRes = await userControlFetch(env, "/config", undefined, userEmail);
    const config = (await configRes.json()) as Record<string, string>;
    headers.set("x-dodo-gateway", config.activeGateway ?? "opencode");
    headers.set("x-dodo-model", config.model ?? "");
    headers.set("x-dodo-opencode-base-url", config.opencodeBaseURL ?? "");
    headers.set("x-dodo-ai-base-url", config.aiGatewayBaseURL ?? "");
    headers.set("x-author-email", email);
  }

  return agent.fetch(new Request(`https://coding-agent${path}`, { ...init, headers }));
}

async function readJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

async function userJson<T>(env: Env, path: string, init?: RequestInit, userEmail?: string): Promise<T> {
  const res = await userControlFetch(env, path, init, userEmail);
  const data = await readJson<T | { error?: string }>(res);
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `UserControl request failed (${res.status})`);
  }
  return data as T;
}

async function agentJson<T>(env: Env, sessionId: string, path: string, init?: RequestInit, depth = 0, userEmail?: string): Promise<T> {
  const res = await agentFetch(env, sessionId, path, init, depth, userEmail);
  const data = await readJson<T | { error?: string }>(res);
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `Agent request failed (${res.status})`);
  }
  return data as T;
}

async function createSessionWithTitle(env: Env, title: string | null, userEmail?: string): Promise<{ id: string; title: string | null }> {
  const id = crypto.randomUUID();
  const email = mcpUserEmail(env, userEmail);
  await userJson(env, "/sessions", {
    body: JSON.stringify({ id, title, ownerEmail: email, createdBy: email }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }, userEmail);
  return { id, title };
}

async function createWorkerRun(env: Env, input: {
  baseBranch: string;
  branch: string;
  commitMessage: string | null;
  expectedFiles: string[];
  parentSessionId?: string | null;
  repoDir: string;
  repoId: string;
  repoUrl: string;
  sessionId: string;
  status: string;
  strategy: "deterministic" | "agent";
  title: string;
  verifyWorkflow?: string | null;
}) {
  return userJson<{ id: string } & Record<string, unknown>>(env, "/worker-runs", {
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

async function updateWorkerRun(env: Env, runId: string, patch: {
  status?: string;
  lastError?: string | null;
  failureSnapshotId?: string | null;
  verification?: Record<string, unknown> | null;
  prUrl?: string | null;
  verifyWorkflowRunId?: string | null;
  verifyWorkflowHtmlUrl?: string | null;
}): Promise<WorkerRunRecord> {
  return userJson<WorkerRunRecord>(env, `/worker-runs/${encodeURIComponent(runId)}`, {
    body: JSON.stringify(patch),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
}

async function createFailureSnapshot(env: Env, runId: string, payload: Record<string, unknown>) {
  return userJson<{ id: string } & Record<string, unknown>>(env, "/failure-snapshots", {
    body: JSON.stringify({ runId, payload }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

async function captureFailureSnapshot(env: Env, runId: string, sessionId: string, repoDir: string, depth: number): Promise<{ id: string } & Record<string, unknown>> {
  const [snapshot, status, diff, log, prompts, messages] = await Promise.all([
    agentJson<Record<string, unknown>>(env, sessionId, "/snapshot", undefined, depth).catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
    agentJson<Record<string, unknown>>(env, sessionId, `/git/status?dir=${encodeURIComponent(repoDir)}`, undefined, depth).catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
    agentJson<Record<string, unknown>>(env, sessionId, `/git/diff?dir=${encodeURIComponent(repoDir)}`, undefined, depth).catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
    agentJson<Record<string, unknown>>(env, sessionId, `/git/log?dir=${encodeURIComponent(repoDir)}&depth=10`, undefined, depth).catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
    agentJson<Record<string, unknown>>(env, sessionId, "/prompts", undefined, depth).catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
    agentJson<Record<string, unknown>>(env, sessionId, "/messages", undefined, depth).catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
  ]);
  return createFailureSnapshot(env, runId, { diff, log, messages, prompts, repoDir, sessionId, snapshot, status });
}

/**
 * Get the global seed session for a known repo + base branch, creating it
 * if missing. Seeds are admin-owned, hidden from the user-facing session
 * list (kind='seed'), exempt from idle cleanup, and shared across all
 * users. Subsequent calls return the same `sessionId` so callers can fork
 * it instead of cloning fresh.
 *
 * The registry lives in SharedIndex, the seed session itself lives in the
 * admin's UserControl DO. This split keeps the cache global without
 * needing a separate DO for seed storage.
 */
async function getOrCreateSeedSession(env: Env, repoId: string, baseBranch: string, depth: number): Promise<{ ownerEmail: string; repoDir: string; repoUrl: string; sessionId: string; title: string }> {
  const repo = getKnownRepo(repoId);
  const title = `[Seed:${repo.id}@${baseBranch}]`;
  const adminEmail = resolveAdminEmail(env);
  if (!adminEmail) {
    throw new Error("Seed cache requires ADMIN_EMAIL to be set; cannot allocate an owner for the seed session");
  }

  // 1. Check the global registry. If a seed already exists for this
  //    {repoId, baseBranch}, return it without touching git.
  const existingRes = await sharedIndexFetch(env, `/seeds/${encodeURIComponent(repoId)}/${encodeURIComponent(baseBranch)}`);
  if (existingRes.ok) {
    const { seed } = await existingRes.json() as { seed: { sessionId: string; ownerEmail: string; repoDir: string; repoUrl: string } };
    return { ownerEmail: seed.ownerEmail, repoDir: seed.repoDir, repoUrl: seed.repoUrl, sessionId: seed.sessionId, title };
  }

  // 2. Cold path. Create the seed session under the admin's UserControl
  //    so all users can fork from it. Mark kind='seed' so it's hidden
  //    from the session list and exempt from idle cleanup.
  const sessionId = crypto.randomUUID();
  await userJson(env, "/sessions", {
    body: JSON.stringify({ id: sessionId, title, ownerEmail: adminEmail, createdBy: adminEmail, kind: "seed" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }, adminEmail);

  // 3. Clone the repo into the seed workspace.
  await agentJson(env, sessionId, "/git/clone", {
    body: JSON.stringify({ branch: baseBranch, dir: repo.dir, url: repo.url }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }, depth, adminEmail);

  // 4. Register the seed in the global index so the next caller hits the
  //    warm path. POST /seeds is idempotent — concurrent cold-path callers
  //    converge on whichever session won the insert race; the loser's
  //    session leaks but is harmless (an empty extra clone we'll never
  //    address). We accept that on the assumption that race is rare and
  //    the cost of de-duplicating distributed inserts isn't worth it.
  await sharedIndexFetch(env, "/seeds", {
    body: JSON.stringify({
      repoId,
      baseBranch,
      sessionId,
      ownerEmail: adminEmail,
      repoUrl: repo.url,
      repoDir: repo.dir,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  return { ownerEmail: adminEmail, repoDir: repo.dir, repoUrl: repo.url, sessionId, title };
}

/**
 * Fork the seed into a new worker session owned by the caller. Uses
 * `forkSessionInternal` so the existence check hits the seed's owner
 * (the admin) rather than the caller, who doesn't own the seed.
 */
async function forkSeedSession(env: Env, sourceSessionId: string, sourceOwnerEmail: string, title: string, depth: number, callerEmail?: string): Promise<{ sessionId: string }> {
  const callerCanonical = mcpUserEmail(env, callerEmail);
  const { id } = await forkSessionInternal(env, callerCanonical, sourceSessionId, title, sourceOwnerEmail);
  void depth; // depth threading is preserved for future use; the current
              // forkSessionInternal path doesn't need it because the
              // fan-out happens via forkSnapshots, not nested MCP calls.
  return { sessionId: id };
}

async function prepareRepoBranch(env: Env, sessionId: string, repoDir: string, branch: string, baseBranch: string, depth: number): Promise<void> {
  // Ensure we're on the base branch
  await agentJson(env, sessionId, "/git/checkout", {
    body: JSON.stringify({ branch: baseBranch, dir: repoDir, force: true }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }, depth).catch(() => undefined);

  // Create the feature branch using checkout with force. Works whether we
  // arrived here from a fresh clone (no conflicting refs) or from a forked
  // seed (force overwrites any stale ref state).
  await agentJson(env, sessionId, "/git/checkout", {
    body: JSON.stringify({ branch, dir: repoDir, force: true }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }, depth);
}

/**
 * Acquire a worker session with the repo already checked out at
 * `baseBranch`. Tries the seed cache first (fast: fork from the global
 * admin-owned seed), falls back to a fresh clone if anything goes wrong
 * — wrong env, fork import error, transient SharedIndex failure, etc.
 *
 * Honours the `DISABLE_SEED_CACHE` env var as a kill switch so we can
 * roll back to fresh-clone behaviour without redeploying.
 */
async function acquireRepoSession(env: Env, repo: { id: string; defaultBranch: string; dir: string; url: string }, baseBranch: string, title: string, depth: number, callerEmail?: string): Promise<{ sessionId: string; viaCache: boolean; reason?: string }> {
  // Safety belt: when stacking on a non-default base branch we want a
  // deeper history than the seed has (the seed is a shallow clone of
  // the default branch). Skip the cache for those callers — a fresh
  // clone with depth=20 is the correct path.
  const isStacked = baseBranch !== repo.defaultBranch;
  const seedCacheDisabled = (env as unknown as { DISABLE_SEED_CACHE?: string }).DISABLE_SEED_CACHE === "1";
  if (isStacked || seedCacheDisabled) {
    return acquireFreshClone(env, repo, baseBranch, title, depth, callerEmail, isStacked ? "stacked-base-branch" : "seed-cache-disabled");
  }

  try {
    const seed = await getOrCreateSeedSession(env, repo.id, baseBranch, depth);
    const fork = await forkSeedSession(env, seed.sessionId, seed.ownerEmail, title, depth, callerEmail);
    return { sessionId: fork.sessionId, viaCache: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("warn", "seed-cache: falling back to fresh clone", { error: message, repoId: repo.id, baseBranch });
    return acquireFreshClone(env, repo, baseBranch, title, depth, callerEmail, `seed-cache-error:${message.slice(0, 80)}`);
  }
}

async function acquireFreshClone(env: Env, repo: { defaultBranch: string; dir: string; url: string }, baseBranch: string, title: string, depth: number, callerEmail: string | undefined, reason: string): Promise<{ sessionId: string; viaCache: false; reason: string }> {
  const worker = await createSessionWithTitle(env, title, callerEmail);
  const isStacked = baseBranch !== repo.defaultBranch;
  const cloneDepth = isStacked ? 20 : 1;
  await agentJson(env, worker.id, "/git/clone", {
    body: JSON.stringify({ branch: baseBranch, depth: cloneDepth, dir: repo.dir, url: repo.url }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }, depth, callerEmail);
  return { sessionId: worker.id, viaCache: false, reason };
}

/**
 * Hard cap for the verify gate. If a GitHub Actions run stays in
 * `queued`/`in_progress` for longer than this (e.g. runner outage, org
 * concurrency cap, billing issue) we mark the worker run as failed rather
 * than polling indefinitely. The dodo-verify workflow itself has a
 * timeout-minutes of 15; we double that to absorb transient queue delays.
 */
const VERIFY_GATE_TIMEOUT_MS = 30 * 60 * 1000;

// The `finalizePr`, `pollAndFinalize`, and `getVerifyGateStartedAt`
// helpers that used to live here moved into the `verify-run` workflow
// (`src/workflows/verify-run.ts`). The MCP handler now delegates to
// the workflow via `buildVerifyRunDeps` + `dispatchWorkflow`.

function textResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

async function jsonFetch(env: Env, fetcher: "user" | "shared" | "agent", path: string, opts?: { sessionId?: string; init?: RequestInit; depth?: number }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
  let res: Response;
  if (fetcher === "user") {
    res = await userControlFetch(env, path, opts?.init);
  } else if (fetcher === "shared") {
    res = await sharedIndexFetch(env, path, opts?.init);
  } else {
    res = await agentFetch(env, opts?.sessionId ?? "", path, opts?.init, opts?.depth ?? 0);
  }
  const data = await res.json();
  if (!res.ok) {
    return errorResult(data);
  }
  return textResult(data);
}

// ─── Workflow dep adapters ───
// Wire the workflow contracts in src/workflows/ to the existing
// MCP-layer helpers. Each builder returns a fresh deps bag closing
// over `env`, `userEmail`, and the current MCP `depth` so the
// workflow body can call back through `userJson` / `agentJson`
// without re-resolving auth on every step.

function buildRepoEditsDeps(env: Env, userEmail: string | undefined, depth: number): RepoEditsDeps {
  return {
    getRepo: (repoId: string) => {
      const repo = getKnownRepo(repoId);
      return { dir: repo.dir, url: repo.url };
    },
    acquireRepoSession: async (input) => {
      const repo = getKnownRepo(input.repoId);
      const acquireStart = Date.now();
      const acquired = await acquireRepoSession(env, repo, input.baseBranch, input.title, depth, userEmail);
      log("info", "workflow.repo-edits: repo session acquired", {
        repoId: repo.id,
        baseBranch: input.baseBranch,
        sessionId: acquired.sessionId,
        viaCache: acquired.viaCache,
        reason: acquired.reason,
        ms: Date.now() - acquireStart,
      });
      return { sessionId: acquired.sessionId, viaCache: acquired.viaCache, reason: acquired.reason };
    },
    createRun: async (input) => {
      const repo = getKnownRepo(input.repoId);
      const run = await createWorkerRun(env, {
        baseBranch: input.baseBranch,
        branch: input.branch,
        commitMessage: input.commitMessage,
        expectedFiles: input.expectedFiles,
        parentSessionId: null,
        repoDir: repo.dir,
        repoId: repo.id,
        repoUrl: repo.url,
        sessionId: input.sessionId,
        status: "repo_ready",
        strategy: "deterministic",
        title: input.title,
      });
      return { id: String(run.id) };
    },
    updateRun: async (id, patch) => {
      await updateWorkerRun(env, id, patch);
    },
    prepareRepoBranch: async ({ sessionId, repoDir, branch, baseBranch }) =>
      prepareRepoBranch(env, sessionId, repoDir, branch, baseBranch, depth),
    applyEdit: async ({ sessionId, path, search, replacement }) => {
      await agentJson(env, sessionId, `/file?path=${encodeURIComponent(path)}`, {
        body: JSON.stringify({ replacement, search }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      }, depth);
    },
    gitStatus: async ({ sessionId, repoDir }) =>
      agentJson<{ entries: unknown[] }>(
        env, sessionId, `/git/status?dir=${encodeURIComponent(repoDir)}`, undefined, depth,
      ),
    gitAdd: async ({ sessionId, repoDir, filepath }) => {
      await agentJson(env, sessionId, "/git/add", {
        body: JSON.stringify({ dir: repoDir, filepath }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }, depth);
    },
    gitCommit: async ({ sessionId, repoDir, message }) => {
      await agentJson(env, sessionId, "/git/commit", {
        body: JSON.stringify({ dir: repoDir, message }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }, depth);
    },
    gitPushChecked: async ({ sessionId, repoDir, baseRef, ref, expectedFiles }) =>
      agentJson<Record<string, unknown>>(env, sessionId, "/git/push-checked", {
        body: JSON.stringify({ baseRef, dir: repoDir, expectedFiles, ref }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }, depth),
    captureFailure: async ({ runId, sessionId, repoDir }) =>
      captureFailureSnapshot(env, runId, sessionId, repoDir, depth) as Promise<{ id: string }>,
  };
}

function buildRepoPromptDeps(env: Env, userEmail: string | undefined, depth: number): RepoPromptDeps {
  return {
    getRepo: (repoId: string) => {
      const repo = getKnownRepo(repoId);
      return { dir: repo.dir, url: repo.url };
    },
    acquireRepoSession: async (input) => {
      const repo = getKnownRepo(input.repoId);
      const acquireStart = Date.now();
      const acquired = await acquireRepoSession(env, repo, input.baseBranch, input.title, depth, userEmail);
      log("info", "workflow.repo-prompt: repo session acquired", {
        repoId: repo.id,
        baseBranch: input.baseBranch,
        sessionId: acquired.sessionId,
        viaCache: acquired.viaCache,
        reason: acquired.reason,
        ms: Date.now() - acquireStart,
      });
      return { sessionId: acquired.sessionId, viaCache: acquired.viaCache, reason: acquired.reason };
    },
    createRun: async (input) => {
      const repo = getKnownRepo(input.repoId);
      const run = await createWorkerRun(env, {
        baseBranch: input.baseBranch,
        branch: input.branch,
        commitMessage: input.commitMessage,
        expectedFiles: input.expectedFiles,
        parentSessionId: null,
        repoDir: repo.dir,
        repoId: repo.id,
        repoUrl: repo.url,
        sessionId: input.sessionId,
        status: "repo_ready",
        strategy: "agent",
        title: input.title,
        verifyWorkflow: input.verifyWorkflow,
      });
      return { id: String(run.id) };
    },
    updateRun: async (id, patch) => {
      await updateWorkerRun(env, id, patch);
    },
    prepareRepoBranch: async ({ sessionId, repoDir, branch, baseBranch }) =>
      prepareRepoBranch(env, sessionId, repoDir, branch, baseBranch, depth),
    dispatchPrompt: async ({ sessionId, content }) =>
      agentJson<Record<string, unknown>>(env, sessionId, "/prompt", {
        body: JSON.stringify({ content }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }, depth),
    captureFailure: async ({ runId, sessionId, repoDir }) =>
      captureFailureSnapshot(env, runId, sessionId, repoDir, depth) as Promise<{ id: string }>,
  };
}

function buildVerifyRunDeps(env: Env, ownerEmail: string, depth: number): VerifyRunDeps {
  // The verify-run workflow's WorkerRunSnapshot shape is a strict
  // subset of WorkerRunRecord — every field maps directly. The cast
  // here is the boundary; we keep the workflow contract narrow by
  // copying only what the body needs, so a future change to
  // WorkerRunRecord doesn't have to ripple through the workflow.
  const snapshot = (run: WorkerRunRecord): WorkerRunSnapshot => ({
    id: run.id,
    sessionId: run.sessionId,
    status: run.status,
    strategy: run.strategy,
    baseBranch: run.baseBranch,
    branch: run.branch,
    repoDir: run.repoDir,
    expectedFiles: run.expectedFiles,
    verification: run.verification,
    verifyWorkflow: run.verifyWorkflow ?? null,
    verifyWorkflowRunId: run.verifyWorkflowRunId ?? null,
    verifyWorkflowHtmlUrl: run.verifyWorkflowHtmlUrl ?? null,
    prUrl: run.prUrl ?? null,
  });
  return {
    verifyGateTimeoutMs: VERIFY_GATE_TIMEOUT_MS,
    getRun: async (id) =>
      snapshot(await userJson<WorkerRunRecord>(env, `/worker-runs/${encodeURIComponent(id)}`)),
    updateRun: async (id, patch) => snapshot(await updateWorkerRun(env, id, patch)),
    listSessionPrompts: async (sessionId) => {
      const { prompts } = await agentJson<{
        prompts: Array<{ error: string | null; status: string }>;
      }>(env, sessionId, "/prompts", undefined, depth);
      return prompts;
    },
    verifyBranch: async ({ sessionId, repoDir, baseRef, ref, expectedFiles }) =>
      agentJson<Record<string, unknown>>(env, sessionId, "/git/verify-branch", {
        body: JSON.stringify({ baseRef, dir: repoDir, expectedFiles, ref }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }, depth),
    triggerVerifyWorkflow: async (run) => {
      const r: WorkerRunRecord = {
        ...(run as unknown as WorkerRunRecord),
      };
      return triggerVerifyWorkflow({ env, run: r, ownerEmail });
    },
    pollVerifyWorkflow: async (run) => {
      const r: WorkerRunRecord = {
        ...(run as unknown as WorkerRunRecord),
      };
      const result = await pollVerifyWorkflow({ env, run: r, ownerEmail });
      if (!result) return null;
      // Map github-api's "conclusion" into the workflow's typed enum.
      // Anything unrecognised collapses to "failure" — safer than
      // leaking provider strings into the workflow contract.
      const c = String(result.conclusion ?? "").toLowerCase();
      const conclusion: "success" | "failure" | "timed_out" =
        c === "success" ? "success" : c === "timed_out" ? "timed_out" : "failure";
      return {
        conclusion,
        htmlUrl: String(result.htmlUrl ?? ""),
      };
    },
    createDraftPr: async (run) => {
      const r: WorkerRunRecord = {
        ...(run as unknown as WorkerRunRecord),
      };
      return createDraftPrForRun(env, r, ownerEmail);
    },
    captureFailure: async ({ runId, sessionId, repoDir }) =>
      captureFailureSnapshot(env, runId, sessionId, repoDir, depth) as Promise<{ id: string }>,
  };
}

export function createDodoMcpServer(env: Env, userEmail: string, depth = 0): McpServer {
  const server = new McpServer({ name: "dodo", version: "0.4.0" });

  // --- Session tools ---

  server.tool("list_sessions", "List all Dodo coding sessions", {}, async () =>
    jsonFetch(env, "user", "/sessions"),
  );

  server.tool("create_session", "Create a new Dodo coding session", {}, async () => {
    const sessionId = crypto.randomUUID();
    const email = mcpUserEmail(env, userEmail);
    const res = await userControlFetch(env, "/sessions", { body: JSON.stringify({ id: sessionId, ownerEmail: email, createdBy: email }), headers: { "content-type": "application/json" },
      method: "POST",
    });
    const session = await res.json();
    return textResult(session);
  });

  server.tool("get_session", "Get the state of a Dodo session", { sessionId: z.string().describe("Session ID") }, async ({ sessionId }) => {
    // Permission check covers ownership / admin / shared grant — without it
    // any MCP-token holder could read any session by guessing its UUID.
    // (audit finding H3 / M8)
    const access = await ensureSessionAccess(env, userEmail, sessionId, "readonly");
    if (!access.ok) return access.result;
    return jsonFetch(env, "agent", "/", { sessionId, depth });
  });

  server.tool(
    "get_mcp_status",
    "Get per-config MCP connect status for a session (ok / error / toolCount from the last connectMcpServers() run). Use this to diagnose why an MCP server's tools never appeared in the session.",
    { sessionId: z.string().describe("Session ID") },
    async ({ sessionId }) => {
      const access = await ensureSessionAccess(env, userEmail, sessionId, "readonly");
      if (!access.ok) return access.result;
      return jsonFetch(env, "agent", "/mcp-status", { sessionId, depth });
    },
  );

  server.tool("delete_session", "Delete a Dodo session and its storage. The session can be restored within 5 minutes using restore_session.", { sessionId: z.string().describe("Session ID") }, async ({ sessionId }) => {
    // Delete is admin-level — only the session owner / platform admin may
    // soft-delete. (audit finding H3)
    const access = await ensureSessionAccess(env, userEmail, sessionId, "admin");
    if (!access.ok) return access.result;
    const result = await agentFetch(env, sessionId, "/", { method: "DELETE" }, depth);
    // Soft-delete in UserControl (marks as deleted, auto-purges after 5 minutes)
    await userControlFetch(env, `/sessions/${encodeURIComponent(sessionId)}/soft-delete`, { method: "POST" }, userEmail);
    const data = await result.json();
    return textResult({ ...data as object, sessionId, recoverable: true, recoverableUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString() });
  });

  server.tool("bulk_delete_sessions", "Delete all sessions whose title starts with a given prefix. Skips sessions with running prompts.", {
    titlePrefix: z.string().min(3).describe("Delete all sessions whose title starts with this prefix"),
  }, async ({ titlePrefix }) => {
    const listRes = await userControlFetch(env, "/sessions", undefined, userEmail);
    const { sessions } = (await listRes.json()) as { sessions: Array<{ id: string; title?: string; status?: string }> };
    const matching = sessions.filter((s) => s.title?.startsWith(titlePrefix));
    if (matching.length === 0) {
      return textResult({ deleted: 0, skipped: [], message: `No sessions found with title prefix "${titlePrefix}"` });
    }

    let deleted = 0;
    const skipped: string[] = [];
    for (const session of matching) {
      if (session.status === "running") {
        skipped.push(`${session.id} (running)`);
        continue;
      }
      try {
        await agentFetch(env, session.id, "/", { method: "DELETE" }, depth);
        await userControlFetch(env, `/sessions/${encodeURIComponent(session.id)}/soft-delete`, { method: "POST" });
        deleted++;
      } catch {
        skipped.push(`${session.id} (error)`);
      }
    }
    return textResult({ deleted, skipped });
  });

  server.tool("restore_session", "Restore a recently deleted session (within 5 minutes of deletion)", { sessionId: z.string().describe("Session ID to restore") }, async ({ sessionId }) => {
    const res = await userControlFetch(env, `/sessions/${encodeURIComponent(sessionId)}/restore`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      return errorResult(data);
    }
    return textResult(data);
  });

  server.tool("fork_session", "Fork a session (copy files + messages into a new session)", { sessionId: z.string().describe("Source session ID") }, async ({ sessionId }) => {
    // Require at least readwrite on the source (matches /session/:id/fork
    // HTTP route which requires "write"). Without this gate, an MCP-token
    // holder could fork any session whose UUID they can guess.
    // (audit follow-up F4)
    const access = await ensureSessionAccess(env, userEmail, sessionId, "write");
    if (!access.ok) return access.result;
    const email = mcpUserEmail(env, userEmail);
    let newId: string;
    try {
      const forked = await forkSessionInternal(env, email, sessionId, null);
      newId = forked.id;
    } catch (err) {
      if (err instanceof SourceSessionMissingError) {
        return errorResult({ error: `Source session '${sessionId}' not found. Run list_sessions to see available sessions.` });
      }
      return errorResult({ error: err instanceof Error ? err.message : String(err) });
    }
    // Fork the source's Artifacts repo so the new session's workspace history
    // is preserved in Artifacts as well. Fire-and-forget — a failure here
    // doesn't break session forking (files already copied via snapshot).
    try {
      const sourceAgent = (await getAgentByName(env.CODING_AGENT as never, sessionId)) as unknown as CodingAgent;
      const sourceCtx = await sourceAgent.getOrCreateArtifactsContext(sessionId);
      if (sourceCtx) {
        await sourceCtx.repo.fork(`dodo-${newId}`, { defaultBranchOnly: false });
      }
    } catch (err) {
      console.warn("[fork_session] Artifacts fork failed (files still copied via snapshot):", err);
    }
    return textResult({ sessionId: newId, sourceSessionId: sessionId, forkedAt: new Date().toISOString() });
  });

  server.tool("list_known_repos", "List built-in repositories that the orchestrator can clone without relying on prompt text.", {}, async () =>
    textResult({ repos: listKnownRepos() }),
  );

  server.tool("get_or_create_seed_session", "Get or create a seed session for a known repo. The seed session clones the repo once and is shared globally, then later runs can fork it instead of cloning repeatedly.", {
    repoId: z.string().describe("Known repo id (for example: dodo)"),
    baseBranch: z.string().default("main").describe("Base branch to keep in the seed session"),
  }, async ({ repoId, baseBranch }) => {
    const seed = await getOrCreateSeedSession(env, repoId, baseBranch, depth);
    return textResult(seed);
  });

  server.tool("fork_seed_session", "Fork a seed session into a new worker session with the repo already present. The seed is admin-owned; the forked session belongs to the caller.", {
    seedSessionId: z.string().describe("Seed session id"),
    seedOwnerEmail: z.string().email().optional().describe("Owner of the seed session. Defaults to the admin email — only override when forking a non-admin seed."),
    title: z.string().min(1).describe("New worker session title"),
  }, async ({ seedSessionId, seedOwnerEmail, title }) => {
    const owner = seedOwnerEmail ?? resolveAdminEmail(env);
    if (!owner) {
      throw new Error("Cannot fork seed: no admin email configured and no seedOwnerEmail provided");
    }
    const forked = await forkSeedSession(env, seedSessionId, owner, title, depth, userEmail);
    return textResult(forked);
  });

  server.tool("get_artifacts_remote", "Get or create the per-session Cloudflare Artifacts repo remote.", { sessionId: z.string() }, async ({ sessionId }) => {
    // Artifacts contexts hand out short-lived tokens that grant write
    // access to the per-session repo. Gate behind session permission.
    // (audit follow-up F4)
    const access = await ensureSessionAccess(env, userEmail, sessionId, "readonly");
    if (!access.ok) return access.result;
    const agent = (await getAgentByName(env.CODING_AGENT as never, sessionId)) as unknown as CodingAgent;
    const ctx = await agent.getOrCreateArtifactsContext(sessionId);
    if (!ctx) {
      return textResult({ error: "Artifacts unavailable for this session" });
    }
    return textResult({
      name: `dodo-${sessionId}`,
      remote: ctx.remote,
      token: ctx.tokenSecret,
    });
  });

  server.tool(
    "publish_to_github",
    "Create a fresh GitHub repository and push the session workspace to it. Use this when promoting an Artifacts-only project (or any session repo) to GitHub. Requires a 'github_token' with the 'repo' scope (classic PAT) or 'Administration: Write' (fine-grained PAT). Defaults to a private repo on the authenticated user's account; pass 'owner' to create under an organisation.",
    {
      sessionId: z.string().describe("Session whose workspace will be pushed to GitHub"),
      name: z.string().min(1).describe("Repo name. Alphanumerics, '-', '_', '.' only."),
      owner: z.string().optional().describe("GitHub org or user. If omitted, the repo is created on the authenticated user's account."),
      private: z.boolean().optional().describe("Visibility. Defaults to true (private)."),
      description: z.string().optional().describe("Repo description shown on GitHub."),
      ref: z.string().optional().describe("Branch to push. Defaults to the workspace's current branch, or 'main'."),
      dir: z.string().optional().describe("Repo directory inside the session workspace. Defaults to the workspace root (matches the Artifacts auto-flush)."),
    },
    async ({ sessionId, name, owner, private: isPrivate, description, ref, dir }) => {
      // publish_to_github both creates a remote repo on GitHub *and* pushes
      // session-owned content to it. That's a write operation against the
      // session's data, plus an external side effect — gate at "write".
      const access = await ensureSessionAccess(env, userEmail, sessionId, "write");
      if (!access.ok) return access.result;

      // 1. Create the empty GitHub repo. If creation fails (no token, name
      //    taken, perms missing), surface the structured error to the agent
      //    and stop — there's no point trying to push without a target.
      const created = await createGithubRepo(env, { name, owner, private: isPrivate, description }, userEmail);
      if (!created.ok) {
        return textResult({ ok: false, step: "create_repo", error: created.error, nameTaken: created.nameTaken });
      }

      // 2. Push the session workspace to it. If the push fails, the GitHub
      //    repo will exist but be empty — return both pieces of info so the
      //    caller can either retry or delete the repo manually.
      const push = await jsonFetch(env, "agent", "/git/publish-to-github", {
        sessionId,
        depth,
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cloneUrl: created.cloneUrl, ref, dir }),
        },
      });
      const pushPayload = (push.content?.[0]?.text ? JSON.parse(push.content[0].text) : {}) as Record<string, unknown>;
      if (push.isError) {
        return textResult({
          ok: false,
          step: "push",
          repo: { htmlUrl: created.htmlUrl, cloneUrl: created.cloneUrl, owner: created.owner, name: created.name, private: created.private },
          error: typeof pushPayload.error === "string" ? pushPayload.error : "Push to GitHub failed",
          hint: "The GitHub repo was created but is empty. Fix the underlying issue (commit your work, check the branch name) and retry, or delete the repo manually.",
        });
      }

      return textResult({
        ok: true,
        repo: {
          htmlUrl: created.htmlUrl,
          cloneUrl: created.cloneUrl,
          owner: created.owner,
          name: created.name,
          private: created.private,
        },
        push: pushPayload,
        message: `Published session workspace to ${created.htmlUrl}`,
      });
    },
  );

  server.tool("verify_branch", "Verify that a pushed branch is ahead of the base branch and optionally contains expected changed files.", {
    sessionId: z.string().describe("Worker session id with the repo checkout"),
    dir: z.string().describe("Repo directory path"),
    ref: z.string().min(1).describe("Branch ref to verify"),
    baseRef: z.string().default("main").describe("Base branch to compare against"),
    expectedFiles: z.array(z.string()).optional().describe("Files that must appear in the remote diff"),
  }, async ({ sessionId, dir, ref, baseRef, expectedFiles }) => {
    // Permission check — verify-branch reads git state for the session.
    // (audit follow-up F4)
    const access = await ensureSessionAccess(env, userEmail, sessionId, "readonly");
    if (!access.ok) return access.result;
    return jsonFetch(env, "agent", "/git/verify-branch", {
      sessionId,
      depth,
      init: {
        body: JSON.stringify({ baseRef, dir, expectedFiles, ref }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    });
  });

  server.tool("run_repo_edits", "Run a deterministic repo task end-to-end: fork a seeded repo session, create a branch, apply text edits, commit, push, verify, and record state transitions.", {
    repoId: z.string().describe("Known repo id (for example: dodo)"),
    title: z.string().min(1).describe("Human-readable task title"),
    branch: z.string().min(1).describe("Branch to create and push"),
    baseBranch: z.string().default("main").describe("Base branch to branch from"),
    commitMessage: z.string().min(1).describe("Commit message"),
    expectedFiles: z.array(z.string()).default([]).describe("Files expected to change on the branch"),
    edits: z.array(z.object({
      path: z.string().min(1).describe("File path inside the repo"),
      search: z.string().min(1).describe("Exact text to replace"),
      replacement: z.string().describe("Replacement text"),
    })).min(1).describe("Deterministic text edits to apply in order"),
  }, async ({ repoId, title, branch, baseBranch, commitMessage, expectedFiles, edits }) => {
    const deps = buildRepoEditsDeps(env, userEmail, depth);
    const workflow = makeRepoEditsWorkflow(deps);
    try {
      const dispatched = await dispatchWorkflow({
        workflow,
        sessionId: "pending",
        payload: { repoId, title, branch, baseBranch, commitMessage, expectedFiles, edits },
      });
      const r = dispatched.result;
      if (r.status === "failed") {
        return errorResult({
          error: r.error,
          failureSnapshotId: r.failureSnapshotId,
          sessionId: r.sessionId,
          runId: dispatched.runId,
        });
      }
      return textResult({
        sessionId: r.sessionId,
        runId: dispatched.runId,
        verification: r.verification,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult({ error: message });
    }
  });

  server.tool("dispatch_repo_prompt", "Dispatch a complex repo task to a worker session using a seeded repo fork, with tracked worker state and later branch verification.", {
    repoId: z.string().describe("Known repo id (for example: dodo)"),
    title: z.string().min(1).describe("Human-readable task title"),
    branch: z.string().min(1).describe("Branch to create and push"),
    baseBranch: z.string().default("main").describe("Base branch to branch from"),
    commitMessage: z.string().min(1).describe("Commit message the worker should use"),
    expectedFiles: z.array(z.string()).default([]).describe("Files expected to change on the branch"),
    prompt: z.string().min(1).describe("Worker prompt. The repo is already cloned and the branch is already checked out."),
    verifyWorkflow: z.string().min(1).nullable().optional().describe("GitHub Actions workflow filename (e.g. 'dodo-verify.yml') to run as an external typecheck/test gate after the branch pushes. The workflow must accept a `workflow_dispatch` trigger and a `ref` input. Leave null/unset to skip the verify gate (default). See .github/workflows/dodo-verify.yml.example for a template."),
  }, async ({ repoId, title, branch, baseBranch, commitMessage, expectedFiles, prompt, verifyWorkflow }) => {
    // dispatch_repo_prompt fires /prompt against a worker session DO,
    // bypassing the HTTP rate limiter. Charge the per-user prompt budget
    // here so MCP orchestration can't drive unbounded LLM spend.
    // (audit follow-up F3)
    const limited = checkPromptBudget(mcpUserEmail(env, userEmail));
    if (limited) return limited;
    const deps = buildRepoPromptDeps(env, userEmail, depth);
    const workflow = makeRepoPromptWorkflow(deps);
    try {
      const dispatched = await dispatchWorkflow({
        workflow,
        sessionId: "pending",
        payload: { repoId, title, branch, baseBranch, commitMessage, expectedFiles, prompt, verifyWorkflow: verifyWorkflow ?? null },
      });
      const r = dispatched.result;
      if (r.status === "failed") {
        return errorResult({
          error: r.error,
          failureSnapshotId: r.failureSnapshotId,
          sessionId: r.sessionId,
          runId: dispatched.runId,
        });
      }
      return textResult({
        sessionId: r.sessionId,
        runId: dispatched.runId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult({ error: message });
    }
  });

  server.tool("verify_worker_run", "Verify a tracked worker run. For prompt-based runs, waits for prompt completion, verifies the remote branch, optionally runs a GitHub Actions verify workflow (typecheck/tests), then opens a draft PR and marks the run done.", {
    runId: z.string().min(1).describe("Worker run id"),
  }, async ({ runId }) => {
    const ownerEmail = mcpUserEmail(env, userEmail);
    const deps = buildVerifyRunDeps(env, ownerEmail, depth);
    const workflow = makeVerifyRunWorkflow(deps);
    try {
      const dispatched = await dispatchWorkflow({
        workflow,
        sessionId: "pending",
        payload: { runId },
      });
      const r = dispatched.result;
      if (r.status === "failed") {
        return errorResult({
          error: r.error,
          failureSnapshotId: r.failureSnapshotId,
          run: await userJson<WorkerRunRecord>(env, `/worker-runs/${encodeURIComponent(runId)}`).catch(() => null),
        });
      }
      // For ongoing runs the caller polls back; for done runs return
      // the persisted record so existing UI shows the same shape as
      // before.
      const persisted = await userJson<WorkerRunRecord>(env, `/worker-runs/${encodeURIComponent(runId)}`).catch(() => null);
      return textResult({
        run: persisted,
        status: r.status,
        verifyWorkflowHtmlUrl: r.verifyWorkflowHtmlUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult({ error: message });
    }
  });

  server.tool("list_worker_runs", "List tracked worker runs, optionally filtered by session id.", {
    sessionId: z.string().optional().describe("Filter runs for a specific orchestrator or worker session"),
  }, async ({ sessionId }) =>
    jsonFetch(env, "user", `/worker-runs${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`),
  );

  server.tool("get_worker_run", "Get a tracked worker run by id.", {
    runId: z.string().min(1).describe("Worker run id"),
  }, async ({ runId }) =>
    jsonFetch(env, "user", `/worker-runs/${encodeURIComponent(runId)}`),
  );

  server.tool("get_failure_snapshot", "Get the captured failure snapshot for a failed worker run.", {
    snapshotId: z.string().min(1).describe("Failure snapshot id"),
  }, async ({ snapshotId }) =>
    jsonFetch(env, "user", `/failure-snapshots/${encodeURIComponent(snapshotId)}`),
  );

  // --- File tools ---

  // All session-scoped tools below run a permission check before touching
  // the CodingAgent DO. Without this gate, any MCP-token holder could
  // read/write/execute against any session by learning its UUID.
  // (audit finding H3)

  server.tool("list_files", "List files in a session's workspace", {
    sessionId: z.string().describe("Session ID"),
    path: z.string().default("/").describe("Directory path"),
  }, async ({ sessionId, path }) => {
    const access = await ensureSessionAccess(env, userEmail, sessionId, "readonly");
    if (!access.ok) return access.result;
    return jsonFetch(env, "agent", `/files?path=${encodeURIComponent(path)}`, { sessionId, depth });
  });

  server.tool("read_file", "Read a file from a session's workspace", {
    sessionId: z.string().describe("Session ID"),
    path: z.string().describe("File path"),
  }, async ({ sessionId, path }) => {
    const access = await ensureSessionAccess(env, userEmail, sessionId, "readonly");
    if (!access.ok) return access.result;
    return jsonFetch(env, "agent", `/file?path=${encodeURIComponent(path)}`, { sessionId, depth });
  });

  server.tool("write_file", "Write a file to a session's workspace", {
    sessionId: z.string().describe("Session ID"),
    path: z.string().describe("File path"),
    content: z.string().describe("File content"),
  }, async ({ sessionId, path, content }) => {
    const access = await ensureSessionAccess(env, userEmail, sessionId, "write");
    if (!access.ok) return access.result;
    return jsonFetch(env, "agent", `/file?path=${encodeURIComponent(path)}`, {
      sessionId,
      depth,
      init: { body: JSON.stringify({ content }), headers: { "content-type": "application/json" }, method: "PUT" },
    });
  });

  server.tool("search_files", "Search workspace files by glob pattern and optional content query", {
    sessionId: z.string().describe("Session ID"),
    pattern: z.string().describe("Glob pattern (e.g. **/*.ts)"),
    query: z.string().optional().describe("Content search query (omit to match by filename only)"),
  }, async ({ sessionId, pattern, query }) => {
    const access = await ensureSessionAccess(env, userEmail, sessionId, "readonly");
    if (!access.ok) return access.result;
    return jsonFetch(env, "agent", "/search", {
      sessionId,
      depth,
      init: { body: JSON.stringify({ pattern, query: query ?? "" }), headers: { "content-type": "application/json" }, method: "POST" },
    });
  });

  // --- Code execution ---

  server.tool("execute_code", "Execute JavaScript code in a sandboxed Worker against the session workspace", {
    sessionId: z.string().describe("Session ID"),
    code: z.string().describe("JavaScript code to execute"),
  }, async ({ sessionId, code }) => {
    const access = await ensureSessionAccess(env, userEmail, sessionId, "write");
    if (!access.ok) return access.result;
    return jsonFetch(env, "agent", "/execute", {
      sessionId,
      depth,
      init: { body: JSON.stringify({ code }), headers: { "content-type": "application/json" }, method: "POST" },
    });
  });

  // --- Chat tools ---

  server.tool("send_message", "Send a synchronous message to the Dodo coding agent and wait for the full response", {
    sessionId: z.string().describe("Session ID"),
    content: z.string().describe("Message content"),
  }, async ({ sessionId, content }) => {
    const access = await ensureSessionAccess(env, userEmail, sessionId, "write");
    if (!access.ok) return access.result;
    // Charge the same per-user message budget as the HTTP route so
    // MCP-token holders can't sidestep the limit. (audit follow-up F3)
    const limited = checkMessageBudget(mcpUserEmail(env, userEmail));
    if (limited) return limited;
    return jsonFetch(env, "agent", "/message", {
      sessionId,
      depth,
      init: { body: JSON.stringify({ content }), headers: { "content-type": "application/json" }, method: "POST" },
    });
  });

  server.tool("send_prompt", "Send an async message to the Dodo coding agent (returns immediately, runs in background). Use get_prompts to check status.", {
    sessionId: z.string().describe("Session ID"),
    content: z.string().describe("Prompt content"),
  }, async ({ sessionId, content }) => {
    const access = await ensureSessionAccess(env, userEmail, sessionId, "write");
    if (!access.ok) return access.result;
    const limited = checkPromptBudget(mcpUserEmail(env, userEmail));
    if (limited) return limited;
    return jsonFetch(env, "agent", "/prompt", {
      sessionId,
      depth,
      init: { body: JSON.stringify({ content }), headers: { "content-type": "application/json" }, method: "POST" },
    });
  });

  server.tool("generate_image", "Generate an image with Workers AI FLUX-1-schnell and post it to the session. Bypasses the chat LLM — routes straight to the image model.", {
    sessionId: z.string().describe("Session ID"),
    prompt: z.string().min(1).max(2048).describe("Text prompt describing the image (1-2048 chars)"),
  }, async ({ sessionId, prompt }) => {
    const access = await ensureSessionAccess(env, userEmail, sessionId, "write");
    if (!access.ok) return access.result;
    const limited = checkGenerateBudget(mcpUserEmail(env, userEmail));
    if (limited) return limited;
    return jsonFetch(env, "agent", "/generate", {
      sessionId,
      depth,
      init: { body: JSON.stringify({ content: prompt }), headers: { "content-type": "application/json" }, method: "POST" },
    });
  });

  server.tool("abort_prompt", "Abort a running async prompt", {
    sessionId: z.string().describe("Session ID"),
  }, async ({ sessionId }) => {
    const access = await ensureSessionAccess(env, userEmail, sessionId, "write");
    if (!access.ok) return access.result;
    return jsonFetch(env, "agent", "/abort", { sessionId, depth, init: { method: "POST", body: "{}", headers: { "content-type": "application/json" } } });
  });

  server.tool("get_messages", "Get message history for a session", {
    sessionId: z.string().describe("Session ID"),
  }, async ({ sessionId }) => {
    const access = await ensureSessionAccess(env, userEmail, sessionId, "readonly");
    if (!access.ok) return access.result;
    return jsonFetch(env, "agent", "/messages", { sessionId, depth });
  });

  server.tool("get_prompts", "Get prompt history for a session", {
    sessionId: z.string().describe("Session ID"),
  }, async ({ sessionId }) => {
    const access = await ensureSessionAccess(env, userEmail, sessionId, "readonly");
    if (!access.ok) return access.result;
    return jsonFetch(env, "agent", "/prompts", { sessionId, depth });
  });

  // --- Git tools ---

  server.tool("git_status", "Get git status for a session workspace", {
    sessionId: z.string().describe("Session ID"),
    dir: z.string().optional().describe("Repo directory path"),
  }, async ({ sessionId, dir }) => {
    const access = await ensureSessionAccess(env, userEmail, sessionId, "readonly");
    if (!access.ok) return access.result;
    return jsonFetch(env, "agent", `/git/status${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`, { sessionId, depth });
  });

  server.tool("git_init", "Initialize a git repo in the session workspace", {
    sessionId: z.string().describe("Session ID"),
    dir: z.string().optional().describe("Directory to init in"),
  }, async ({ sessionId, dir }) => {
    const access = await ensureSessionAccess(env, userEmail, sessionId, "write");
    if (!access.ok) return access.result;
    return jsonFetch(env, "agent", "/git/init", {
      sessionId,
      depth,
      init: { body: JSON.stringify({ dir }), headers: { "content-type": "application/json" }, method: "POST" },
    });
  });

  server.tool("git_add", "Stage files in a session's git repo", {
    sessionId: z.string().describe("Session ID"),
    filepath: z.string().default(".").describe("File or directory to stage"),
    dir: z.string().optional().describe("Repo directory path"),
  }, async ({ sessionId, filepath, dir }) => {
    const access = await ensureSessionAccess(env, userEmail, sessionId, "write");
    if (!access.ok) return access.result;
    return jsonFetch(env, "agent", "/git/add", {
      sessionId,
      depth,
      init: { body: JSON.stringify({ filepath, dir }), headers: { "content-type": "application/json" }, method: "POST" },
    });
  });

  server.tool("git_commit", "Commit staged changes in a session's git repo", {
    sessionId: z.string().describe("Session ID"),
    message: z.string().describe("Commit message"),
    dir: z.string().optional().describe("Repo directory path"),
  }, async ({ sessionId, message, dir }) => {
    const access = await ensureSessionAccess(env, userEmail, sessionId, "write");
    if (!access.ok) return access.result;
    return jsonFetch(env, "agent", "/git/commit", {
      sessionId,
      depth,
      init: { body: JSON.stringify({ message, dir }), headers: { "content-type": "application/json" }, method: "POST" },
    });
  });

  server.tool("git_log", "Get git log for a session's repo", {
    sessionId: z.string().describe("Session ID"),
    dir: z.string().optional().describe("Repo directory path"),
    depth: z.number().optional().describe("Number of commits to show"),
  }, async ({ sessionId, dir, depth: logDepth }) => {
    const access = await ensureSessionAccess(env, userEmail, sessionId, "readonly");
    if (!access.ok) return access.result;
    const params = new URLSearchParams();
    if (dir) params.set("dir", dir);
    if (logDepth) params.set("depth", String(logDepth));
    return jsonFetch(env, "agent", `/git/log?${params}`, { sessionId, depth });
  });

  server.tool("git_diff", "Get git diff for a session's repo", {
    sessionId: z.string().describe("Session ID"),
    dir: z.string().optional().describe("Repo directory path"),
  }, async ({ sessionId, dir }) => {
    const access = await ensureSessionAccess(env, userEmail, sessionId, "readonly");
    if (!access.ok) return access.result;
    return jsonFetch(env, "agent", `/git/diff${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`, { sessionId, depth });
  });

  server.tool("git_clone", "Clone a git repo into the session workspace", {
    sessionId: z.string().describe("Session ID"),
    url: z.string().describe("Git repo URL"),
    dir: z.string().optional().describe("Target directory"),
    branch: z.string().optional().describe("Branch to clone"),
    depth: z.number().optional().describe("Clone depth (shallow clone)"),
  }, async ({ sessionId, url, dir, branch, depth: cloneDepth }) => {
    const access = await ensureSessionAccess(env, userEmail, sessionId, "write");
    if (!access.ok) return access.result;
    return jsonFetch(env, "agent", "/git/clone", {
      sessionId,
      depth,
      init: { body: JSON.stringify({ url, dir, branch, depth: cloneDepth }), headers: { "content-type": "application/json" }, method: "POST" },
    });
  });

  server.tool("git_push", "Push commits to remote", {
    sessionId: z.string().describe("Session ID"),
    dir: z.string().optional().describe("Repo directory path"),
    remote: z.string().optional().describe("Remote name (default: origin)"),
    ref: z.string().optional().describe("Branch ref to push"),
    force: z.boolean().optional().describe("Force push"),
  }, async ({ sessionId, dir, remote, ref, force }) => {
    const access = await ensureSessionAccess(env, userEmail, sessionId, "write");
    if (!access.ok) return access.result;
    return jsonFetch(env, "agent", "/git/push", {
      sessionId,
      depth,
      init: { body: JSON.stringify({ dir, remote, ref, force }), headers: { "content-type": "application/json" }, method: "POST" },
    });
  });

  // --- Memory tools (per-user) ---

  server.tool("memory_search", "Search Dodo's persistent memory store", {
    query: z.string().default("").describe("Search query (empty for all)"),
  }, async ({ query }) =>
    jsonFetch(env, "user", `/memory${query ? `?q=${encodeURIComponent(query)}` : ""}`),
  );

  server.tool("memory_write", "Write an entry to Dodo's memory store", {
    title: z.string().describe("Entry title"),
    content: z.string().describe("Entry content"),
    tags: z.array(z.string()).default([]).describe("Tags"),
  }, async ({ title, content, tags }) =>
    jsonFetch(env, "user", "/memory", {
      init: { body: JSON.stringify({ title, content, tags }), headers: { "content-type": "application/json" }, method: "POST" },
    }),
  );

  // --- Skill tools (per-user) ---
  // Personal SKILL.md store. Skills loaded by Dodo via two-stage progressive
  // disclosure (manifest in system prompt → full body via the `skill` tool).

  server.tool("skill_list", "List Dodo skills (personal layer only — workspace + builtin skills are visible from inside the chat).", {
    enabledOnly: z.boolean().optional().describe("If true, only enabled skills are returned"),
  }, async ({ enabledOnly }) =>
    jsonFetch(env, "user", `/skills${enabledOnly ? "?enabled=true" : ""}`),
  );

  server.tool("skill_read", "Get the full SKILL.md body of a personal skill by name.", {
    name: z.string().describe("Skill name"),
  }, async ({ name }) =>
    jsonFetch(env, "user", `/skills/${encodeURIComponent(name)}`),
  );

  server.tool("skill_write", "Create or overwrite a personal SKILL.md skill. Body should be the markdown after the YAML frontmatter — frontmatter fields go in their own params. Skills with the same name are replaced; pass enabled:false to write a draft without surfacing it to the agent.", {
    name: z.string().describe("Skill name (lowercase letters, digits, hyphens, underscores; max 64 chars)"),
    description: z.string().describe("One-sentence description that says WHAT the skill does and WHEN to use it. Max 1024 chars. This is the only thing the model sees at startup — write it like a tool description."),
    body: z.string().describe("Full SKILL.md body (markdown, no frontmatter)"),
    enabled: z.boolean().optional().describe("Default true — set false to save a draft without enabling"),
    sourceUrl: z.string().url().optional().describe("Optional URL the skill was imported from"),
  }, async ({ name, description, body, enabled, sourceUrl }) =>
    jsonFetch(env, "user", "/skills", {
      init: {
        body: JSON.stringify({
          name,
          description,
          body,
          enabled: enabled ?? true,
          sourceOrigin: sourceUrl ? "url-import" : "manual",
          sourceUrl,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    }),
  );

  server.tool("skill_enable", "Enable or disable a personal skill. Disabled skills don't appear in the manifest but stay in storage.", {
    name: z.string().describe("Skill name"),
    enabled: z.boolean().describe("true to enable, false to disable"),
  }, async ({ name, enabled }) =>
    jsonFetch(env, "user", `/skills/${encodeURIComponent(name)}/enabled`, {
      init: { body: JSON.stringify({ enabled }), headers: { "content-type": "application/json" }, method: "PUT" },
    }),
  );

  server.tool("skill_delete", "Delete a personal skill. Workspace and built-in skills cannot be deleted via this tool.", {
    name: z.string().describe("Skill name"),
  }, async ({ name }) =>
    jsonFetch(env, "user", `/skills/${encodeURIComponent(name)}`, {
      init: { method: "DELETE" },
    }),
  );

  server.tool("skill_import_url", "Import a SKILL.md from a URL (raw markdown). Parses the frontmatter, validates name + description, and stores it as a personal skill. Use for pulling skills from github raw URLs or skill-pack hosts.", {
    url: z.string().url().describe("URL to a raw SKILL.md file"),
    enabled: z.boolean().optional().describe("Default true — set false to save as a draft"),
  }, async ({ url, enabled }) => {
    // Fetch raw content with a tight timeout. The OUTBOUND allowlist applies
    // upstream — this fetch goes through the platform's default outbound.
    let raw: string;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        return errorResult({ error: `Fetch failed: HTTP ${res.status} ${res.statusText}` });
      }
      raw = await res.text();
    } catch (err) {
      return errorResult({ error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    if (raw.length > 200_000) {
      return errorResult({ error: `SKILL.md too large (${raw.length} bytes). Max 200KB.` });
    }
    let parsed: { name: string; description: string; body: string };
    try {
      const { parseSkillFile, normalizeFrontmatter } = await import("./skill-registry");
      const { frontmatter, body } = parseSkillFile(raw);
      const norm = normalizeFrontmatter(frontmatter, body);
      parsed = { name: norm.name, description: norm.description, body: norm.body };
    } catch (err) {
      return errorResult({ error: `Parse failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    return jsonFetch(env, "user", "/skills", {
      init: {
        body: JSON.stringify({
          ...parsed,
          enabled: enabled ?? true,
          sourceOrigin: "url-import",
          sourceUrl: url,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    });
  });

  // --- Config tools (per-user) ---

  server.tool("get_config", "Get Dodo's current LLM and git configuration", {}, async () =>
    jsonFetch(env, "user", "/config"),
  );

  server.tool("update_config", "Update Dodo's LLM gateway, model, git author, or subagent model config", {
    model: z.string().optional().describe("Model ID"),
    activeGateway: z.enum(["opencode", "ai-gateway"]).optional().describe("LLM gateway"),
    opencodeBaseURL: z.string().url().optional().describe("OpenCode gateway base URL override. Leave unset to use the worker's env default."),
    aiGatewayBaseURL: z.string().url().optional().describe("AI Gateway base URL override. Leave unset to use the worker's env default."),
    gitAuthorEmail: z.string().email().optional().describe("Git author email"),
    gitAuthorName: z.string().optional().describe("Git author name"),
    systemPromptPrefix: z.string().optional().describe("Personal preamble prepended to the system prompt. Pass empty string to clear."),
    exploreModel: z.string().optional().describe("Default model for the `explore` subagent. Leave unset to use the env default (Kimi K2.6). Pass empty string to clear and fall back to the built-in heuristic."),
    taskModel: z.string().optional().describe("Default model for the `task` subagent. Leave unset to use the env default (Haiku 4.5). Pass empty string to clear and fall back to the built-in heuristic."),
    exploreMode: z.enum(["inprocess", "facet"]).optional().describe("Where the `explore` subagent runs. `inprocess` (default) = blocking generateText call in the parent turn. `facet` = delegates to a separately-addressable Durable Object facet on the same machine; unlocks parallel explore fan-out."),
    taskMode: z.enum(["inprocess", "facet"]).optional().describe("Where the `task` subagent runs. Same semantics as `exploreMode`. Paired with phase-4 scratch-workspace support for isolated experiments."),
  }, async (params) =>
    jsonFetch(env, "user", "/config", {
      init: { body: JSON.stringify(params), headers: { "content-type": "application/json" }, method: "PUT" },
    }),
  );

  // --- MCP Config tools ---

  server.tool("add_mcp_config", "Add an MCP integration. Bypasses host allowlist (MCP is trusted).", {
    name: z.string().describe("Integration name"),
    url: z.string().url().describe("MCP server URL"),
    authToken: z.string().optional().describe("Bearer token for Authorization header"),
    sessionId: z.string().optional().describe("If provided, only enable for this session"),
  }, async ({ name, url, authToken, sessionId: targetSessionId }) => {
    const headers: Record<string, string> = {};
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }

    // Create the config via UserControl directly (bypasses index.ts host allowlist)
    const res = await userControlFetch(env, "/mcp-configs", { body: JSON.stringify({ name, type: "http", url, headers: Object.keys(headers).length > 0 ? headers : undefined, enabled: true }), headers: { "content-type": "application/json" },
      method: "POST",
    });

    if (!res.ok) {
      const err = await res.json();
      return errorResult(err);
    }

    const config = (await res.json()) as { id: string; name: string; url?: string };

    // If sessionId provided, enable only for that session via override
    if (targetSessionId) {
      await userControlFetch(env, `/sessions/${encodeURIComponent(targetSessionId)}/mcp-overrides`, {
        body: JSON.stringify({ mcpConfigId: config.id, enabled: true }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    }

    return textResult({ ...config, scopedToSession: targetSessionId ?? null });
  });

  server.tool("list_mcp_configs", "List configured MCP integrations with id, name, url, and enabled status", {}, async () =>
    jsonFetch(env, "user", "/mcp-configs"),
  );

  // Push a refresh-token MCP config (from a local helper that already ran
  // DCR + browser OAuth for an MCP server whose authorize endpoint only
  // accepts loopback redirect URIs — e.g. portal.mcp.cfdata.org). Idempotent
  // on `url` so re-running the local helper just rotates the tokens in place.
  server.tool(
    "set_refresh_token_mcp",
    [
      "Register an MCP server that authenticates with an OAuth refresh token.",
      "Use this when the upstream OAuth provider only accepts loopback",
      "redirect URIs (so Dodo can't do the OAuth dance itself) and a local",
      "helper has already completed the authorize+exchange flow. Dodo will",
      "use the access token directly and refresh it via the OAuth token",
      "endpoint as it expires. Idempotent on `url`: re-pushing for the same",
      "MCP URL updates the stored tokens in place.",
    ].join(" "),
    {
      name: z.string().describe("Integration display name"),
      url: z.string().url().describe("MCP server endpoint URL"),
      tokenEndpoint: z
        .string()
        .url()
        .describe(
          "OAuth token endpoint used to refresh the access token (e.g. https://cf-mcp.cloudflareaccess.com/cdn-cgi/access/oauth/token)",
        ),
      clientId: z
        .string()
        .min(1)
        .describe("OAuth client_id from the local helper's DCR"),
      accessToken: z.string().min(1).describe("Current OAuth access token"),
      refreshToken: z
        .string()
        .min(1)
        .describe("Current OAuth refresh token. Will rotate on each refresh."),
      expiresAt: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Absolute expiry of the access token in unix seconds. When omitted, the access token is treated as expired and refreshed on first use."),
    },
    async (input) => {
      const res = await userControlFetch(env, "/refresh-token-mcp", {
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json();
        return errorResult(err);
      }
      const payload = (await res.json()) as { id: string; name: string; url: string; updated: boolean };
      return textResult(payload);
    },
  );

  // Two-step DCR OAuth flow: Dodo runs DCR + token exchange server-side; a
  // local helper handles only the loopback callback. Lets Dodo have its own
  // refresh chain that doesn't share fate with any local OAuth client.
  server.tool(
    "start_dcr_oauth_flow",
    [
      "Start an OAuth flow against an MCP server. Dodo registers itself via",
      "DCR (with a loopback redirect URI the upstream will accept) and",
      "returns an authorize URL for a local helper to open. The helper",
      "catches the redirect on 127.0.0.1, then calls",
      "`complete_dcr_oauth_flow` with the auth code to finish the dance.",
      "Use this for MCP servers whose OAuth provider only accepts loopback",
      "redirect URIs (e.g. cf-portal). For servers that accept arbitrary",
      "redirect URIs, the regular browser-based OAuth catalog entry works.",
    ].join(" "),
    {
      mcpUrl: z.string().url().describe("MCP server URL — used as the OAuth `resource` parameter"),
      mcpName: z.string().min(1).describe("Display name for the resulting integration"),
      redirectPort: z
        .number()
        .int()
        .min(1024)
        .max(65535)
        .default(19876)
        .describe("Port the local helper will bind on 127.0.0.1 (default: 19876, matches OpenCode's default)"),
      registrationEndpoint: z
        .string()
        .url()
        .optional()
        .describe("Override the auto-discovered OAuth registration endpoint"),
      authorizationEndpoint: z
        .string()
        .url()
        .optional()
        .describe("Override the auto-discovered OAuth authorization endpoint"),
      tokenEndpoint: z
        .string()
        .url()
        .optional()
        .describe("Override the auto-discovered OAuth token endpoint"),
      scope: z.string().optional().describe("Optional OAuth scopes to request"),
    },
    async (input) => {
      const res = await userControlFetch(env, "/oauth-dcr/start", {
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json();
        return errorResult(err);
      }
      const payload = (await res.json()) as { state: string; authUrl: string; redirectUri: string };
      return textResult(payload);
    },
  );

  server.tool(
    "complete_dcr_oauth_flow",
    [
      "Complete a DCR OAuth flow that was started with",
      "`start_dcr_oauth_flow`. Pass the auth code and state nonce that the",
      "local helper caught on its loopback callback. Dodo exchanges the",
      "code for tokens server-side and stores them as a refresh_token MCP",
      "integration that auto-refreshes as the access token expires.",
    ].join(" "),
    {
      state: z.string().min(1).describe("The state nonce returned by start_dcr_oauth_flow"),
      code: z.string().min(1).describe("The authorization code from the loopback callback's `?code=…` query param"),
    },
    async (input) => {
      const res = await userControlFetch(env, "/oauth-dcr/complete", {
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json();
        return errorResult(err);
      }
      const payload = (await res.json()) as { id: string; name: string; url: string };
      return textResult(payload);
    },
  );

  server.tool("remove_mcp_config", "Remove an MCP integration by id", {
    id: z.string().describe("MCP config id to remove"),
  }, async ({ id }) => {
    const res = await userControlFetch(env, `/mcp-configs/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) {
      const err = await res.json();
      return errorResult(err);
    }
    return textResult({ removed: id });
  });

  // --- Task tools (per-user) ---

  server.tool("list_tasks", "List all tasks in the Dodo backlog", {
    status: z.string().optional().describe("Filter by status: backlog, todo, in_progress, done, cancelled"),
  }, async ({ status }) =>
    jsonFetch(env, "user", `/tasks${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  );

  server.tool("create_task", "Create a new task in the Dodo backlog", {
    title: z.string().describe("Task title"),
    description: z.string().default("").describe("Task description"),
    priority: z.enum(["low", "medium", "high"]).default("medium").describe("Task priority"),
  }, async ({ title, description, priority }) =>
    jsonFetch(env, "user", "/tasks", {
      init: { body: JSON.stringify({ title, description, priority }), headers: { "content-type": "application/json" }, method: "POST" },
    }),
  );

  server.tool("update_task", "Update a task's status, title, description, priority, or linked session", {
    id: z.string().describe("Task ID"),
    title: z.string().optional().describe("New title"),
    description: z.string().optional().describe("New description"),
    status: z.enum(["backlog", "todo", "in_progress", "done", "cancelled"]).optional().describe("New status"),
    priority: z.enum(["low", "medium", "high"]).optional().describe("New priority"),
    session_id: z.string().nullable().optional().describe("Session ID to link (null to unlink)"),
  }, async ({ id, ...patch }) =>
    jsonFetch(env, "user", `/tasks/${encodeURIComponent(id)}`, {
      init: { body: JSON.stringify(patch), headers: { "content-type": "application/json" }, method: "PUT" },
    }),
  );

  server.tool("delete_task", "Delete a task from the backlog", {
    id: z.string().describe("Task ID"),
  }, async ({ id }) => {
    // Verify the task exists before deleting
    const checkRes = await userControlFetch(env, `/tasks/${encodeURIComponent(id)}/check`, undefined, userEmail);
    if (!checkRes.ok) {
      return errorResult({ error: `Task '${id}' not found. Run list_tasks to see available tasks.` });
    }
    return jsonFetch(env, "user", `/tasks/${encodeURIComponent(id)}`, { init: { method: "DELETE" } });
  });

  // ─── Admin: self-introspection (Cloudflare Logs + cross-session sweep) ───
  //
  // All gated on isAdmin(). These power the autopilot self-diagnose loop
  // (Ask 4c) and let an admin investigate Dodo's own behaviour without
  // bouncing out to the Cloudflare dashboard.

  server.tool(
    "fetch_worker_logs",
    "ADMIN-ONLY. Query Dodo's own Cloudflare Workers Observability logs (last N hours, with optional full-text needle). Returns recent log events with outcomes, errors, and raw fields. Use this to investigate Dodo behaviour, find error patterns, or audit recent sessions.",
    {
      sinceHours: z.number().min(1).max(168).optional().describe("How far back to look (default 1, max 168 = 7 days)."),
      needle: z.string().max(500).optional().describe("Full-text substring to match against log fields."),
      errorOnly: z.boolean().optional().describe("Only return events where $metadata.error is set."),
      limit: z.number().min(1).max(200).optional().describe("Max events returned (default 50, max 200)."),
    },
    async ({ sinceHours, needle, errorOnly, limit }) => {
      if (!isAdmin(userEmail, env)) return errorResult({ error: "Admin access required" });
      const toMs = Date.now();
      const fromMs = toMs - (sinceHours ?? 1) * 60 * 60 * 1000;
      const result = errorOnly
        ? await queryRecentExceptions(env, { sinceHours: sinceHours ?? 1, limit })
        : await queryWorkerLogs(env, { fromMs, toMs, needle, limit, view: "events" });
      if (!result.ok) return errorResult({ error: result.message, reason: result.reason });
      return textResult({
        fromMs: result.fromMs,
        toMs: result.toMs,
        total: result.total,
        events: result.events.map((e) => ({
          timestamp: e.timestamp,
          outcome: e.outcome,
          message: e.message,
          error: e.error,
        })),
      });
    },
  );

  server.tool(
    "fetch_session_logs",
    "ADMIN-ONLY. Query Workers Observability logs scoped to a specific Dodo session id. Uses the session id as a full-text needle.",
    {
      sessionId: z.string().min(1).describe("Session id to filter logs by."),
      sinceHours: z.number().min(1).max(168).optional().describe("How far back to look (default 24, max 168)."),
      limit: z.number().min(1).max(200).optional().describe("Max events returned (default 100)."),
    },
    async ({ sessionId, sinceHours, limit }) => {
      if (!isAdmin(userEmail, env)) return errorResult({ error: "Admin access required" });
      const result = await querySessionLogs(env, sessionId, { sinceHours, limit });
      if (!result.ok) return errorResult({ error: result.message, reason: result.reason });
      return textResult({ sessionId, total: result.total, events: result.events });
    },
  );

  server.tool(
    "list_failed_sessions",
    "ADMIN-ONLY. Cross-section view of recent failures: aggregates Worker exceptions + client-side errors + scheduled-session stalls. Useful for picking what to investigate first.",
    {
      sinceHours: z.number().min(1).max(168).optional().describe("Window in hours (default 24)."),
    },
    async ({ sinceHours }) => {
      if (!isAdmin(userEmail, env)) return errorResult({ error: "Admin access required" });
      const hours = sinceHours ?? 24;
      const sharedStub = getSharedIndexStub(env);

      const [workerExceptions, clientErrorsRes] = await Promise.all([
        queryRecentExceptions(env, { sinceHours: hours, limit: 100 }),
        sharedStub.fetch("https://shared-index/errors/summary"),
      ]);
      const clientErrors = clientErrorsRes.ok
        ? (await clientErrorsRes.json()) as { groups?: Array<{ message: string; count: number }> }
        : { groups: [] };

      // Walk every user's UserControl for stalled scheduled sessions
      // (consecutive_failures >= 3). Admin scope only.
      let stalledSchedules: Array<{ ownerEmail: string; id: string; description: string; failures: number; lastError: string | null }> = [];
      try {
        const usersRes = await sharedStub.fetch("https://shared-index/users");
        const users = usersRes.ok
          ? (await usersRes.json() as { users?: Array<{ email: string }> }).users ?? []
          : [];
        for (const user of users) {
          const stub = getUserControlStub(env, user.email);
          const res = await stub.fetch("https://user-control/scheduled-sessions");
          if (!res.ok) continue;
          const body = (await res.json()) as { scheduledSessions?: Array<{ id: string; description: string; consecutive_failures?: number; last_error?: string | null }> };
          for (const s of body.scheduledSessions ?? []) {
            if ((s.consecutive_failures ?? 0) >= 3) {
              stalledSchedules.push({
                ownerEmail: user.email,
                id: s.id,
                description: s.description,
                failures: s.consecutive_failures ?? 0,
                lastError: s.last_error ?? null,
              });
            }
          }
        }
      } catch (e) {
        log("warn", "list_failed_sessions: schedule sweep failed", { error: e instanceof Error ? e.message : String(e) });
      }

      return textResult({
        windowHours: hours,
        workerExceptions: workerExceptions.ok
          ? workerExceptions.events.slice(0, 20).map((e) => ({
              timestamp: e.timestamp,
              error: e.error,
              message: e.message,
            }))
          : { error: workerExceptions.message },
        clientErrorTopGroups: clientErrors.groups ?? [],
        stalledSchedules,
      });
    },
  );

  server.tool(
    "dispatch_autopilot_worker",
    "ADMIN-ONLY. Dispatch a self-diagnose worker session. Creates a session, sets the diagnose goal so the session self-continues until set_goal_status is called, and kicks it off with 'Begin.' Returns the worker session id.",
    {
      targetArea: z.string().min(1).max(500).describe("What this worker should focus on (one concrete area)."),
      contextNotes: z.string().max(4000).optional().describe("Notes from your log sweep that the worker should see."),
      sinceHours: z.number().min(1).max(168).optional().describe("Log window for the worker. Default 24."),
      maxTurns: z.number().min(1).max(200).optional().describe("Max auto-continue turns. Default 50."),
    },
    async ({ targetArea, contextNotes, sinceHours, maxTurns }) => {
      if (!isAdmin(userEmail, env)) return errorResult({ error: "Admin access required" });
      const { buildDiagnoseGoal, resolveAutopilotOwner } = await import("./autopilot");
      let owner: string;
      try {
        owner = resolveAutopilotOwner(env);
      } catch (e) {
        return errorResult({ error: e instanceof Error ? e.message : "Autopilot owner unavailable" });
      }

      const sessionId = crypto.randomUUID();
      const createRes = await userControlFetch(env, "/sessions", {
        body: JSON.stringify({ id: sessionId, ownerEmail: owner, createdBy: owner }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }, owner);
      if (!createRes.ok) {
        return errorResult({ error: `Failed to create worker session: ${createRes.status}` });
      }

      const agent = await getAgentByName(env.CODING_AGENT as never, sessionId);
      await agent.fetch("https://coding-agent/autopilot-flag", {
        body: JSON.stringify({ isAutopilot: true, role: "worker-auto" }),
        headers: { "content-type": "application/json", "x-dodo-session-id": sessionId, "x-owner-email": owner },
        method: "PUT",
      });

      const title = `[autopilot] ${targetArea.slice(0, 64)}`;
      await userControlFetch(env, `/sessions/${encodeURIComponent(sessionId)}`, {
        body: JSON.stringify({ title }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      }, owner);

      // Set the goal — the diagnose template carries all the instructions,
      // and the session self-continues until set_goal_status is called.
      const goalText = buildDiagnoseGoal({
        targetArea,
        contextNotes,
        sinceHours: sinceHours ?? 24,
      });
      await agent.fetch("https://coding-agent/goal", {
        body: JSON.stringify({ text: goalText, maxTurns: maxTurns ?? 50, role: "autopilot-worker" }),
        headers: { "content-type": "application/json", "x-dodo-session-id": sessionId, "x-owner-email": owner },
        method: "PUT",
      });

      const cfgRes = await userControlFetch(env, "/config", undefined, owner);
      const cfg = (await cfgRes.json()) as { activeGateway?: string; model?: string; aiGatewayBaseURL?: string; opencodeBaseURL?: string };
      await agent.fetch("https://coding-agent/prompt", {
        body: JSON.stringify({ content: "Begin." }),
        headers: {
          "content-type": "application/json",
          "x-dodo-session-id": sessionId,
          "x-owner-email": owner,
          "x-author-email": owner,
          "x-dodo-ai-base-url": cfg.aiGatewayBaseURL ?? "",
          "x-dodo-gateway": cfg.activeGateway ?? "opencode",
          "x-dodo-model": cfg.model ?? "",
          "x-dodo-opencode-base-url": cfg.opencodeBaseURL ?? "",
        },
        method: "POST",
      });

      log("info", "Autopilot worker dispatched", { sessionId, targetArea });
      return textResult({ sessionId, title, ownerEmail: owner });
    },
  );

  server.tool(
    "list_autopilot_workers",
    "ADMIN-ONLY. List recent autopilot worker sessions (both manual and supervisor-dispatched). Returns id, title, status, role, created_at — useful for the supervisor to review past runs.",
    {
      limit: z.number().min(1).max(100).optional().describe("Max sessions to return (default 25)."),
    },
    async ({ limit }) => {
      if (!isAdmin(userEmail, env)) return errorResult({ error: "Admin access required" });
      const { resolveAutopilotOwner } = await import("./autopilot");
      let owner: string;
      try {
        owner = resolveAutopilotOwner(env);
      } catch (e) {
        return errorResult({ error: e instanceof Error ? e.message : "Autopilot owner unavailable" });
      }
      const res = await userControlFetch(env, "/sessions", undefined, owner);
      if (!res.ok) return errorResult({ error: `Failed to list sessions: ${res.status}` });
      const body = (await res.json()) as { sessions?: Array<{ id: string; title?: string; status?: string; created_at?: number }> };
      const all = body.sessions ?? [];
      // Title-prefix filter — robust even if the per-session metadata flag
      // is missing (the kickoff always uses the [autopilot] prefix).
      const autopilot = all
        .filter((s) => (s.title ?? "").startsWith("[autopilot]"))
        .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
        .slice(0, limit ?? 25);
      return textResult({ count: autopilot.length, sessions: autopilot });
    },
  );

  server.tool(
    "autopilot_notify",
    "ADMIN-ONLY. Send an ntfy notification on behalf of the autopilot supervisor. Use this when the supervisor decides to pause itself or when a worker hits a recurring failure pattern that needs human attention.",
    {
      title: z.string().min(1).max(200),
      body: z.string().min(1).max(2000),
      priority: z.enum(["min", "low", "default", "high", "urgent"]).optional().describe("ntfy priority. Default 'default'; use 'high' or 'urgent' for stuck patterns."),
    },
    async ({ title, body, priority }) => {
      if (!isAdmin(userEmail, env)) return errorResult({ error: "Admin access required" });
      const { resolveAutopilotOwner } = await import("./autopilot");
      let owner: string;
      try {
        owner = resolveAutopilotOwner(env);
      } catch (e) {
        return errorResult({ error: e instanceof Error ? e.message : "Autopilot owner unavailable" });
      }
      const { planNotification, resolveNotificationConfig, sendNotification } = await import("./notify");
      const config = await resolveNotificationConfig(env, owner);
      const plan = planNotification(
        {
          kind: "autopilot",
          title: `[autopilot] ${title}`,
          body,
          tags: "robot",
          priority: priority ?? "default",
          ownerEmail: owner,
        },
        config,
      );
      if (plan.perChannelMessages.length === 0) {
        return textResult({ delivered: 0, reason: "No notification channels configured for the autopilot owner" });
      }
      await sendNotification(plan, env);
      return textResult({ delivered: plan.perChannelMessages.length, channels: plan.perChannelMessages.map((m) => m.channel.type) });
    },
  );

  server.tool(
    "summarize_session_run",
    "ADMIN-ONLY. Read a session's prompt + message history and return a structured summary (turn count, tools used, last error if any). Faster than reading the full transcript when triaging.",
    {
      sessionId: z.string().min(1).describe("Session id to summarize."),
    },
    async ({ sessionId }) => {
      if (!isAdmin(userEmail, env)) return errorResult({ error: "Admin access required" });
      const access = await ensureSessionAccess(env, userEmail, sessionId, "readonly");
      if (!access.ok) return access.result;
      const [stateRes, promptsRes, messagesRes] = await Promise.all([
        jsonFetch(env, "agent", "/", { sessionId, depth }),
        jsonFetch(env, "agent", "/prompts", { sessionId, depth }),
        jsonFetch(env, "agent", "/messages", { sessionId, depth }),
      ]);
      // jsonFetch returns the MCP content block; pull the inner JSON back
      // out for aggregation.
      const parse = (r: { content?: Array<{ text?: string }> }) => {
        try { return JSON.parse(r.content?.[0]?.text ?? "{}"); } catch { return {}; }
      };
      const state = parse(stateRes as { content?: Array<{ text?: string }> });
      const prompts = parse(promptsRes as { content?: Array<{ text?: string }> });
      const messages = parse(messagesRes as { content?: Array<{ text?: string }> });
      const promptList = (prompts.prompts ?? []) as Array<{ id: string; status: string; error?: string | null; created_at?: number }>;
      const lastError = [...promptList].reverse().find((p) => p.error)?.error ?? null;
      return textResult({
        sessionId,
        title: state.title ?? null,
        status: state.status ?? null,
        promptCount: promptList.length,
        promptStatuses: promptList.reduce<Record<string, number>>((acc, p) => {
          acc[p.status] = (acc[p.status] ?? 0) + 1;
          return acc;
        }, {}),
        messageCount: (messages.messages ?? messages.records ?? []).length,
        lastError,
      });
    },
  );

  // ─── Admin: ChatMonitorAgent PoC tool surface ───
  //
  // Mirrors the HTTP routes in index.ts, but addressable as MCP tools
  // from any client that holds a Dodo MCP token (admin service-mode or
  // a per-user `dodo_*` token).
  //
  // All tools are admin-gated. The `ownerEmail` argument lets the admin
  // operate against any user's UserControl DO — required because the
  // cf-portal refresh-token MCP config is stored per-owner.

  const chatMonitorStubFor = (ownerEmail: string, spaceId: string) => {
    const id = env.CHAT_MONITOR.idFromName(chatMonitorIdName(ownerEmail, spaceId));
    return env.CHAT_MONITOR.get(id);
  };

  const proxyChatMonitor = async (
    ownerEmail: string,
    spaceId: string,
    path: string,
    init?: RequestInit,
  ): Promise<unknown> => {
    const stub = chatMonitorStubFor(ownerEmail, spaceId);
    const res = await stub.fetch(`https://chat-monitor${path}`, init);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { status: res.status, body: text };
    }
  };

  server.tool(
    "chat_monitor_upsert",
    "ADMIN-ONLY. Create or update a Google Chat monitor for (ownerEmail, spaceId). The monitor polls the space and forwards allowlisted HUMAN messages to a dedicated CodingAgent 'brain' session. The persona becomes the brain session's goal text. `commandSenders` is a HARD code-level allowlist — non-allowlisted senders' messages either go to the brain as background context (contextMode='recent') or are dropped (default 'off'). The brain session uses cf-portal MCP + all of Dodo's normal tool surface; it posts to chat by calling the `chat_reply` MCP tool. After upsert, call `chat_monitor_start` to begin polling.",
    createMonitorSchema.shape,
    async (args) => {
      if (!isAdmin(userEmail, env)) return errorResult({ error: "Admin access required" });
      const parsed = createMonitorSchema.parse(args);
      const result = await proxyChatMonitor(parsed.ownerEmail, parsed.spaceId, "/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed),
      });
      return textResult(result);
    },
  );

  server.tool(
    "chat_monitor_list",
    "ADMIN-ONLY. List every chat monitor registered in SharedIndex (across all owners). Lightweight — does not hit each monitor DO. Use `chat_monitor_state` for per-monitor details.",
    {},
    async () => {
      if (!isAdmin(userEmail, env)) return errorResult({ error: "Admin access required" });
      const stub = getSharedIndexStub(env);
      const res = await stub.fetch("https://shared-index/chat-monitors");
      const text = await res.text();
      try {
        return textResult(JSON.parse(text));
      } catch {
        return errorResult({ status: res.status, body: text });
      }
    },
  );

  server.tool(
    "chat_monitor_forwards",
    "ADMIN-ONLY. Return the most-recent forward-log entries for a monitor (newest first, max 200). Shows which messages were forwarded as commands, which as background, and which were skipped (and why). Replaces the pre-refactor `chat_monitor_decisions`.",
    {
      ownerEmail: z.string().email(),
      spaceId: z.string().min(1).regex(/^spaces\//),
      limit: z.number().int().min(1).max(200).optional().describe("Max entries to return (default 50)."),
    },
    async ({ ownerEmail, spaceId, limit }) => {
      if (!isAdmin(userEmail, env)) return errorResult({ error: "Admin access required" });
      const qs = limit ? `?limit=${limit}` : "";
      const result = await proxyChatMonitor(ownerEmail, spaceId, `/forwards${qs}`);
      return textResult(result);
    },
  );

  server.tool(
    "chat_monitor_start",
    "ADMIN-ONLY. Start the alarm-driven poll loop for a previously-upserted monitor.",
    {
      ownerEmail: z.string().email().describe("Owner whose UserControl holds the cf-portal MCP config."),
      spaceId: z.string().min(1).regex(/^spaces\//).describe("Google Chat space resource name."),
    },
    async ({ ownerEmail, spaceId }) => {
      if (!isAdmin(userEmail, env)) return errorResult({ error: "Admin access required" });
      const result = await proxyChatMonitor(ownerEmail, spaceId, "/start", { method: "POST" });
      return textResult(result);
    },
  );

  server.tool(
    "chat_monitor_stop",
    "ADMIN-ONLY. Stop polling. The monitor config is preserved — call `chat_monitor_start` again to resume.",
    {
      ownerEmail: z.string().email(),
      spaceId: z.string().min(1).regex(/^spaces\//),
    },
    async ({ ownerEmail, spaceId }) => {
      if (!isAdmin(userEmail, env)) return errorResult({ error: "Admin access required" });
      const result = await proxyChatMonitor(ownerEmail, spaceId, "/stop", { method: "POST" });
      return textResult(result);
    },
  );

  server.tool(
    "chat_monitor_tick",
    "ADMIN-ONLY. Fire one poll-decide-reply cycle immediately. Useful for debugging — returns counts (fetched/new/replied/skipped) and any per-message errors.",
    {
      ownerEmail: z.string().email(),
      spaceId: z.string().min(1).regex(/^spaces\//),
    },
    async ({ ownerEmail, spaceId }) => {
      if (!isAdmin(userEmail, env)) return errorResult({ error: "Admin access required" });
      const result = await proxyChatMonitor(ownerEmail, spaceId, "/tick", { method: "POST" });
      return textResult(result);
    },
  );

  server.tool(
    "chat_monitor_state",
    "ADMIN-ONLY. Read the monitor's current state (persona, interval, lastSeenIso, enabled, lastError, lastRunIso).",
    {
      ownerEmail: z.string().email(),
      spaceId: z.string().min(1).regex(/^spaces\//),
    },
    async ({ ownerEmail, spaceId }) => {
      if (!isAdmin(userEmail, env)) return errorResult({ error: "Admin access required" });
      const result = await proxyChatMonitor(ownerEmail, spaceId, "/state");
      return textResult(result);
    },
  );

  // The chat_reply tool is implemented in mcp-shared so the codemode
  // server (which exposes a tiny tool surface) can register it too.
  registerChatReplyTool(server, env, userEmail);

  server.tool(
    "chat_monitor_delete",
    "ADMIN-ONLY. Wipe the monitor entirely (storage + alarm). Use this to reset state for a smoke test.",
    {
      ownerEmail: z.string().email(),
      spaceId: z.string().min(1).regex(/^spaces\//),
    },
    async ({ ownerEmail, spaceId }) => {
      if (!isAdmin(userEmail, env)) return errorResult({ error: "Admin access required" });
      const result = await proxyChatMonitor(ownerEmail, spaceId, "/", { method: "DELETE" });
      return textResult(result);
    },
  );

  return server;
}
