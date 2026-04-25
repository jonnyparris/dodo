import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAgentByName } from "agents";
import { z } from "zod";
import { canonicalizeEmail, getSharedIndexStub, getUserControlStub, isAdmin, resolveAdminEmail } from "./auth";
import { messageLimiter, promptLimiter } from "./rate-limiters";
import { createDraftPrForRun, createGithubRepo } from "./github-pr";
import { pollVerifyWorkflow, triggerVerifyWorkflow } from "./github-actions";
import { getKnownRepo, listKnownRepos } from "./repos";
import { forkSessionInternal, SourceSessionMissingError } from "./sessions";
import type { CodingAgent } from "./coding-agent";
import type { Env, WorkerRunRecord } from "./types";

/**
 * Resolve the MCP caller's email. Prefers an explicit userEmail (from a
 * user-scoped dodo_* token validated upstream), falls back to ADMIN_EMAIL
 * for service-mode callers using the shared DODO_MCP_TOKEN.
 *
 * When the fallback is taken we log a warning so operators can audit
 * operations that get attributed to the admin. In production, review the
 * log stream periodically to confirm the expected service-mode callers
 * (CI etc.) are the only ones hitting this path.
 */
function mcpUserEmail(env: Env, userEmail?: string): string {
  const canonical = canonicalizeEmail(userEmail ?? null);
  if (canonical) return canonical;
  const email = resolveAdminEmail(env);
  if (!email) throw new Error("ADMIN_EMAIL must be configured for MCP access. Set it as a secret or in wrangler.jsonc vars.");
  console.warn("[mcp] Operation attributed to admin via service-mode fallback (no userEmail threaded).");
  return email;
}

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
  headers.set("x-dodo-mcp-depth", String(depth + 1));

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

async function patchSession(env: Env, sessionId: string, patch: { status?: string; title?: string | null }, userEmail?: string): Promise<void> {
  await userJson(env, `/sessions/${encodeURIComponent(sessionId)}`, {
    body: JSON.stringify(patch),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  }, userEmail);
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

async function getOrCreateSeedSession(env: Env, repoId: string, baseBranch: string, depth: number): Promise<{ repoDir: string; repoUrl: string; sessionId: string; title: string }> {
  const repo = getKnownRepo(repoId);
  const title = `[Seed:${repo.id}@${baseBranch}]`;
  const existing = await userJson<{ sessions: Array<{ id: string; title?: string | null }> }>(env, "/sessions");
  const found = existing.sessions.find((session) => session.title === title);
  if (found) {
    return { repoDir: repo.dir, repoUrl: repo.url, sessionId: found.id, title };
  }

  const seed = await createSessionWithTitle(env, title);
  await agentJson(env, seed.id, "/git/clone", {
    body: JSON.stringify({ branch: baseBranch, dir: repo.dir, url: repo.url }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }, depth);
  return { repoDir: repo.dir, repoUrl: repo.url, sessionId: seed.id, title };
}

async function forkSeedSession(env: Env, sourceSessionId: string, title: string, depth: number): Promise<{ sessionId: string }> {
  const snapshotRes = await agentFetch(env, sourceSessionId, "/snapshot", undefined, depth);
  const snapshot = await snapshotRes.text();
  const snapshotStore = await userJson<{ id: string }>(env, "/fork-snapshots", {
    body: snapshot,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const created = await createSessionWithTitle(env, title);
  await agentJson(env, created.id, `/snapshot/import?snapshotId=${encodeURIComponent(snapshotStore.id)}`, { method: "POST" }, depth);
  await userJson(env, `/fork-snapshots/${encodeURIComponent(snapshotStore.id)}`, { method: "DELETE" });
  return { sessionId: created.id };
}

async function prepareRepoBranch(env: Env, sessionId: string, repoDir: string, branch: string, baseBranch: string, depth: number): Promise<void> {
  // Ensure we're on the base branch
  await agentJson(env, sessionId, "/git/checkout", {
    body: JSON.stringify({ branch: baseBranch, dir: repoDir, force: true }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }, depth).catch(() => undefined);

  // Create the feature branch using checkout. Since we clone fresh (not fork),
  // there are no remote tracking refs to conflict with.
  await agentJson(env, sessionId, "/git/checkout", {
    body: JSON.stringify({ branch, dir: repoDir, force: true }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }, depth);
}

/**
 * Hard cap for the verify gate. If a GitHub Actions run stays in
 * `queued`/`in_progress` for longer than this (e.g. runner outage, org
 * concurrency cap, billing issue) we mark the worker run as failed rather
 * than polling indefinitely. The dodo-verify workflow itself has a
 * timeout-minutes of 15; we double that to absorb transient queue delays.
 */
const VERIFY_GATE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * After a run reaches `done` (or we explicitly decide to open a PR without
 * blocking on verify), attempt to open a draft PR. PR failures are non-fatal
 * so they don't regress the run.
 *
 * If a prior call already opened a PR (e.g. the caller is double-polling
 * `verify_worker_run` and both see a terminal state), skip the second
 * attempt — `createDraftPrForRun` has no existing-PR check and would
 * otherwise open duplicates.
 */
async function finalizePr(env: Env, run: WorkerRunRecord, ownerEmail: string | undefined, verification: Record<string, unknown>): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (run.prUrl) {
    return textResult({ run, verification });
  }
  const prUrl = await createDraftPrForRun(env, run, ownerEmail);
  if (prUrl) {
    const withPr = await updateWorkerRun(env, run.id, { prUrl });
    return textResult({ run: withPr, verification });
  }
  return textResult({ run, verification });
}

/** Read the startedAt ISO string from the verifyGate record. Null if missing. */
function getVerifyGateStartedAt(run: WorkerRunRecord): number | null {
  const gate = (run.verification as Record<string, unknown> | null)?.verifyGate as Record<string, unknown> | undefined;
  const raw = gate?.startedAt;
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Poll the verify-gate workflow run for a worker run that's currently
 * `checks_running`. If the workflow is still in flight, return a running
 * response. On success: transition `checks_passed` → auto-PR → `done`. On
 * failure (or timeout): capture the workflow URL in a failure snapshot and
 * mark `failed`.
 */
async function pollAndFinalize(env: Env, run: WorkerRunRecord, ownerEmail: string | undefined): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
  const verification = (run.verification ?? {}) as Record<string, unknown>;
  const pollResult = await pollVerifyWorkflow({ env, run, ownerEmail });

  if (!pollResult) {
    // Still running — but check the timeout cap first so we don't poll forever.
    const startedAt = getVerifyGateStartedAt(run);
    if (startedAt !== null && Date.now() - startedAt > VERIFY_GATE_TIMEOUT_MS) {
      const htmlUrl = run.verifyWorkflowHtmlUrl ?? null;
      const message = `Verify workflow timed out after ${Math.round(VERIFY_GATE_TIMEOUT_MS / 60000)} minutes${htmlUrl ? ` — see ${htmlUrl}` : ""}`;
      const failure = await createFailureSnapshot(env, run.id, {
        reason: "verify_gate_timeout",
        htmlUrl,
        startedAt: new Date(startedAt).toISOString(),
        timeoutMs: VERIFY_GATE_TIMEOUT_MS,
        verifyWorkflow: run.verifyWorkflow,
      });
      const updated = await updateWorkerRun(env, run.id, {
        status: "failed",
        lastError: message,
        failureSnapshotId: String(failure.id),
        verification: { ...verification, verifyGate: { ...(verification.verifyGate as Record<string, unknown> | undefined), conclusion: "timed_out", htmlUrl, timedOutAt: new Date().toISOString() } },
      });
      return errorResult({ error: message, failureSnapshotId: failure.id, run: updated, verifyWorkflowHtmlUrl: htmlUrl });
    }
    return textResult({ run, status: "checks_running", verifyWorkflowHtmlUrl: run.verifyWorkflowHtmlUrl });
  }

  if (pollResult.conclusion === "success") {
    const passed = await updateWorkerRun(env, run.id, {
      status: "checks_passed",
      verification: { ...verification, verifyGate: { ...(verification.verifyGate as Record<string, unknown> | undefined), conclusion: "success", htmlUrl: pollResult.htmlUrl, completedAt: pollResult.completedAt } },
    });
    // Immediately transition to `done` so the caller sees a single terminal
    // state, and open the draft PR.
    const done = await updateWorkerRun(env, run.id, { status: "done" });
    return await finalizePr(env, done, ownerEmail, passed.verification ?? {});
  }

  // Non-success conclusion — record a failure snapshot pointing at the run.
  const failure = await createFailureSnapshot(env, run.id, {
    reason: "verify_gate_failed",
    conclusion: pollResult.conclusion,
    htmlUrl: pollResult.htmlUrl,
    completedAt: pollResult.completedAt,
    verifyWorkflow: run.verifyWorkflow,
  });
  const message = `Verify workflow concluded '${pollResult.conclusion}' — see ${pollResult.htmlUrl}`;
  const updated = await updateWorkerRun(env, run.id, {
    status: "failed",
    lastError: message,
    failureSnapshotId: String(failure.id),
    verification: { ...verification, verifyGate: { ...(verification.verifyGate as Record<string, unknown> | undefined), conclusion: pollResult.conclusion, htmlUrl: pollResult.htmlUrl, completedAt: pollResult.completedAt } },
  });
  return errorResult({ error: message, failureSnapshotId: failure.id, run: updated, verifyWorkflowHtmlUrl: pollResult.htmlUrl });
}

function textResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(data: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: true };
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

  server.tool("get_or_create_seed_session", "Get or create a seed session for a known repo. The seed session clones the repo once, then later runs can fork it instead of cloning repeatedly.", {
    repoId: z.string().describe("Known repo id (for example: dodo)"),
    baseBranch: z.string().default("main").describe("Base branch to keep in the seed session"),
  }, async ({ repoId, baseBranch }) => {
    const seed = await getOrCreateSeedSession(env, repoId, baseBranch, depth);
    return textResult(seed);
  });

  server.tool("fork_seed_session", "Fork a seed session into a new worker session with the repo already present.", {
    seedSessionId: z.string().describe("Seed session id"),
    title: z.string().min(1).describe("New worker session title"),
  }, async ({ seedSessionId, title }) => {
    const forked = await forkSeedSession(env, seedSessionId, title, depth);
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
    const repo = getKnownRepo(repoId);
    const worker = await createSessionWithTitle(env, title);
    const run = await createWorkerRun(env, {
      baseBranch,
      branch,
      commitMessage,
      expectedFiles,
      parentSessionId: null,
      repoDir: repo.dir,
      repoId: repo.id,
      repoUrl: repo.url,
      sessionId: worker.id,
      status: "session_created",
      strategy: "deterministic",
      title,
    });

    try {
      // Clone fresh (avoids fork binary corruption issues). Deeper clone when
      // stacking on a non-default base so later `git log` calls see the stack.
      const isStacked = baseBranch !== repo.defaultBranch;
      const cloneDepth = isStacked ? 20 : 1;
      await agentJson(env, worker.id, "/git/clone", {
        body: JSON.stringify({ branch: baseBranch, depth: cloneDepth, dir: repo.dir, url: repo.url }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }, depth);
      await updateWorkerRun(env, String(run.id), { status: "repo_ready" });
      await prepareRepoBranch(env, worker.id, repo.dir, branch, baseBranch, depth);
      await updateWorkerRun(env, String(run.id), { status: "branch_created" });

      for (const edit of edits) {
        await agentJson(env, worker.id, `/file?path=${encodeURIComponent(edit.path)}`, {
          body: JSON.stringify({ replacement: edit.replacement, search: edit.search }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        }, depth);
      }
      await updateWorkerRun(env, String(run.id), { status: "edit_applied" });

      const status = await agentJson<{ entries?: unknown[] }>(env, worker.id, `/git/status?dir=${encodeURIComponent(repo.dir)}`, undefined, depth);
      if (!Array.isArray(status.entries) || status.entries.length === 0) {
        throw new Error("No changed files detected after applying deterministic edits");
      }

      // Stage files — git add needs repo-relative paths, not workspace-absolute
      const repoPrefix = repo.dir.endsWith("/") ? repo.dir : `${repo.dir}/`;
      for (const file of Array.from(new Set(edits.map((edit) => edit.path)))) {
        const relPath = file.startsWith(repoPrefix) ? file.slice(repoPrefix.length) : file;
        await agentJson(env, worker.id, "/git/add", {
          body: JSON.stringify({ dir: repo.dir, filepath: relPath }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }, depth);
      }

      await agentJson(env, worker.id, "/git/commit", {
        body: JSON.stringify({ dir: repo.dir, message: commitMessage }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }, depth);
      await updateWorkerRun(env, String(run.id), { status: "commit_created" });

      const push = await agentJson<Record<string, unknown>>(env, worker.id, "/git/push-checked", {
        body: JSON.stringify({ baseRef: baseBranch, dir: repo.dir, expectedFiles, ref: branch }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }, depth);
      await updateWorkerRun(env, String(run.id), { status: "done", verification: push });
      return textResult({ run, sessionId: worker.id, verification: push });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = await captureFailureSnapshot(env, String(run.id), worker.id, repo.dir, depth);
      await updateWorkerRun(env, String(run.id), { failureSnapshotId: String(failure.id), lastError: message, status: "failed" });
      return errorResult({ error: message, failureSnapshotId: failure.id, runId: run.id, sessionId: worker.id });
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
    const repo = getKnownRepo(repoId);
    const worker = await createSessionWithTitle(env, title);
    const run = await createWorkerRun(env, {
      baseBranch,
      branch,
      commitMessage,
      expectedFiles,
      parentSessionId: null,
      repoDir: repo.dir,
      repoId: repo.id,
      repoUrl: repo.url,
      sessionId: worker.id,
      status: "session_created",
      strategy: "agent",
      title,
      verifyWorkflow: verifyWorkflow ?? null,
    });

    try {
      // Clone fresh. When stacking on a non-default base branch, fetch more
      // history so the LLM can `git log` the existing stack without needing
      // to pull or fetch (both of which fail under singleBranch+shallow).
      const isStacked = baseBranch !== repo.defaultBranch;
      const cloneDepth = isStacked ? 20 : 1;
      await agentJson(env, worker.id, "/git/clone", {
        body: JSON.stringify({ branch: baseBranch, depth: cloneDepth, dir: repo.dir, url: repo.url }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }, depth);
      await updateWorkerRun(env, String(run.id), { status: "repo_ready" });
      await prepareRepoBranch(env, worker.id, repo.dir, branch, baseBranch, depth);
      await updateWorkerRun(env, String(run.id), { status: "branch_created" });

      const content = [
        `Repository is already cloned at ${repo.dir}.`,
        `You are on the ${baseBranch} branch. Push to remote branch '${branch}' when done.`,
        `Do not clone again. Do not change branch names.`,
        `Do NOT run git_pull or git_fetch — the clone is singleBranch+shallow. The repository is already on the correct branch.`,
        `Use commit message: ${commitMessage}`,
        `Push with git_push_checked and ref set to '${branch}'.`,
        `Skip npm/node verification commands (npm run typecheck, npm test, npm install) — the sandbox cannot run them. The dispatching system will verify externally.`,
        prompt,
      ].join("\n\n");

      const promptRes = await agentJson<Record<string, unknown>>(env, worker.id, "/prompt", {
        body: JSON.stringify({ content }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }, depth);
      await updateWorkerRun(env, String(run.id), { status: "prompt_running" });
      return textResult({ prompt: promptRes, run, sessionId: worker.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = await captureFailureSnapshot(env, String(run.id), worker.id, repo.dir, depth);
      await updateWorkerRun(env, String(run.id), { failureSnapshotId: String(failure.id), lastError: message, status: "failed" });
      return errorResult({ error: message, failureSnapshotId: failure.id, runId: run.id, sessionId: worker.id });
    }
  });

  server.tool("verify_worker_run", "Verify a tracked worker run. For prompt-based runs, waits for prompt completion, verifies the remote branch, optionally runs a GitHub Actions verify workflow (typecheck/tests), then opens a draft PR and marks the run done.", {
    runId: z.string().min(1).describe("Worker run id"),
  }, async ({ runId }) => {
    const run = await userJson<WorkerRunRecord>(env, `/worker-runs/${encodeURIComponent(runId)}`);

    if (run.strategy === "deterministic" && run.status === "done") {
      return textResult(run);
    }

    const ownerEmail = mcpUserEmail(env, userEmail);

    try {
      // Resume a verify-gate poll if we're mid-check on a prior call.
      if (run.status === "checks_running" && run.verifyWorkflowRunId) {
        return await pollAndFinalize(env, run, ownerEmail);
      }

      // Don't re-trigger the verify gate if we already passed and an auto-PR
      // attempt simply didn't land a URL. Let the caller retry that path
      // separately if they want.
      if (run.status === "checks_passed") {
        return textResult({ run, note: "checks already passed; call again to retry PR creation" });
      }

      const prompts = await agentJson<{ prompts: Array<{ error: string | null; status: string }> }>(env, run.sessionId, "/prompts", undefined, depth);
      const active = prompts.prompts[0];
      if (!active || active.status === "queued" || active.status === "running") {
        return textResult({ runId, sessionId: run.sessionId, status: "running" });
      }
      if (active.status === "failed" || active.status === "aborted") {
        const failure = await captureFailureSnapshot(env, runId, run.sessionId, run.repoDir, depth);
        const message = active.error ?? `Worker prompt ${active.status}`;
        const updated = await updateWorkerRun(env, runId, { failureSnapshotId: String(failure.id), lastError: message, status: "failed" });
        return errorResult({ failureSnapshotId: failure.id, run: updated });
      }

      const verification = await agentJson<Record<string, unknown>>(env, run.sessionId, "/git/verify-branch", {
        body: JSON.stringify({ baseRef: run.baseBranch, dir: run.repoDir, expectedFiles: run.expectedFiles, ref: run.branch }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }, depth);

      // Verify gate (optional, opt-in). If the caller set verifyWorkflow on
      // dispatch, trigger GitHub Actions here and return `checks_running` —
      // the caller should call verify_worker_run again to poll.
      if (run.verifyWorkflow) {
        const triggered = await triggerVerifyWorkflow({ env, run, ownerEmail });
        if (!triggered) {
          // Couldn't trigger — don't gate the run on an infrastructure failure.
          // Log a non-fatal note in the verification record and proceed to PR.
          const afterVerify = await updateWorkerRun(env, runId, {
            status: "done",
            verification: { ...verification, verifyGate: { triggered: false, reason: "workflow_dispatch failed or missing token" } },
          });
          return await finalizePr(env, afterVerify, ownerEmail, verification);
        }
        const afterTrigger = await updateWorkerRun(env, runId, {
          status: "checks_running",
          verification: {
            ...verification,
            verifyGate: {
              startedAt: new Date().toISOString(),
              workflow: run.verifyWorkflow,
              runId: triggered.runId,
              htmlUrl: triggered.htmlUrl,
            },
          },
          verifyWorkflowRunId: triggered.runId,
          verifyWorkflowHtmlUrl: triggered.htmlUrl,
        });
        return textResult({
          run: afterTrigger,
          status: "checks_running",
          verifyWorkflowHtmlUrl: triggered.htmlUrl,
        });
      }

      // No verify gate — mark done and open PR (existing behavior).
      const updated = await updateWorkerRun(env, runId, { status: "done", verification });
      return await finalizePr(env, updated, ownerEmail, verification);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = await captureFailureSnapshot(env, runId, run.sessionId, run.repoDir, depth);
      const updated = await updateWorkerRun(env, runId, { failureSnapshotId: String(failure.id), lastError: message, status: "failed" });
      return errorResult({ error: message, failureSnapshotId: failure.id, run: updated });
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

  return server;
}
