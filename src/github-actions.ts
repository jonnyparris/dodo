import type { Env, WorkerRunRecord } from "./types";
import { parseGithubRepo } from "./github-pr";
import { getUserControlStub } from "./auth";

/**
 * GitHub Actions verify gate.
 *
 * Triggers a `workflow_dispatch` on the repo's verify workflow for the pushed
 * branch, then polls the workflow run until it reaches a terminal conclusion.
 *
 * This is our external typecheck/test gate — the Workers sandbox can't run
 * `npm install`/`tsc`/`vitest`, so we delegate verification to GitHub Actions
 * on every dispatched PR.
 */

interface VerifyTriggerResult {
  runId: string;
  htmlUrl: string;
}

interface VerifyPollResult {
  conclusion: "success" | "failure" | "cancelled" | "timed_out" | "action_required" | "neutral" | "skipped" | "stale" | "startup_failure";
  htmlUrl: string;
  /** ISO timestamp of when the workflow run finished. */
  completedAt: string | null;
}

/**
 * Resolve a GitHub token. Prefers per-user encrypted secret (`github_token`),
 * falls back to env.GITHUB_TOKEN. Mirrors the resolution in github-pr.ts.
 */
async function resolveGithubToken(env: Env, ownerEmail?: string): Promise<string | undefined> {
  if (ownerEmail) {
    try {
      const stub = getUserControlStub(env, ownerEmail);
      const response = await stub.fetch("https://user-control/internal/secret/github_token", {
        headers: { "x-owner-email": ownerEmail },
      });
      if (response.ok) {
        const { value } = (await response.json()) as { value: string };
        if (value) return value;
      }
    } catch {
      // Fall through to env
    }
  }
  return env.GITHUB_TOKEN;
}

/**
 * Trigger the verify workflow for a branch via `workflow_dispatch`.
 *
 * Returns the newly-created workflow run so the caller can persist the id
 * and poll for completion.
 *
 * `workflow_dispatch` is asynchronous — GitHub responds 204 before the run
 * exists. We then query the runs list to find the one we just triggered.
 *
 * Run identification uses two signals to avoid grabbing an unrelated run
 * (e.g. a concurrent human-dispatched run for the same branch):
 *
 *   1. **head_sha match** (primary). Before dispatching, we look up the
 *      branch's current tip. A `workflow_dispatch` run records that sha as
 *      `head_sha`, so a match is authoritative.
 *   2. **created_at window** (secondary). Fallback when the branch sha
 *      lookup fails. Tight 2-second window accepts real NTP skew while
 *      rejecting runs from humans dispatching the same workflow moments
 *      earlier.
 */
export async function triggerVerifyWorkflow(input: {
  env: Env;
  run: WorkerRunRecord;
  ownerEmail?: string;
}): Promise<VerifyTriggerResult | null> {
  const { env, run, ownerEmail } = input;
  if (!run.verifyWorkflow) return null;
  const parsed = parseGithubRepo(run.repoUrl);
  if (!parsed) return null;
  const token = await resolveGithubToken(env, ownerEmail);
  if (!token) return null;

  // Resolve the branch's current head sha so we can match runs authoritatively.
  const expectedHeadSha = await fetchBranchHeadSha({ owner: parsed.owner, repo: parsed.repo, branch: run.branch, token });

  const triggerUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/actions/workflows/${encodeURIComponent(run.verifyWorkflow)}/dispatches`;
  const triggeredAt = Date.now();
  const triggerRes = await fetch(triggerUrl, {
    method: "POST",
    headers: ghHeaders(token),
    body: JSON.stringify({ ref: run.branch }),
  });

  if (!triggerRes.ok) {
    const errorText = await triggerRes.text();
    console.warn(`[verify-gate] workflow_dispatch failed ${triggerRes.status}:`, errorText.slice(0, 500));
    return null;
  }

  // Find the run we just created. GitHub's API can take a second or two to
  // materialize the run — poll the runs list briefly.
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(500 + attempt * 500);
    const listUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/actions/workflows/${encodeURIComponent(run.verifyWorkflow)}/runs?branch=${encodeURIComponent(run.branch)}&event=workflow_dispatch&per_page=5`;
    const listRes = await fetch(listUrl, { headers: ghHeaders(token) });
    if (!listRes.ok) continue;
    const listData = (await listRes.json()) as { workflow_runs: Array<{ id: number; html_url: string; created_at: string; head_sha?: string }> };
    const candidate = listData.workflow_runs?.find((r) => {
      // Primary: head_sha match is authoritative if we have the expected sha.
      if (expectedHeadSha && r.head_sha === expectedHeadSha) return true;
      if (expectedHeadSha) return false; // have sha, must match — don't fall through to time window

      // Fallback: tight time window. ±2s covers NTP skew; tighter than the
      // typical human reaction time between dispatches.
      const createdMs = Date.parse(r.created_at);
      return Number.isFinite(createdMs) && createdMs >= triggeredAt - 2_000;
    });
    if (candidate) {
      return { runId: String(candidate.id), htmlUrl: candidate.html_url };
    }
  }

  console.warn("[verify-gate] workflow dispatched but run id not found within 5s");
  return null;
}

/**
 * Look up the current head sha for a branch. Returns null on any failure so
 * the caller can fall back to time-window matching.
 */
async function fetchBranchHeadSha(input: {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}): Promise<string | null> {
  try {
    const url = `https://api.github.com/repos/${input.owner}/${input.repo}/branches/${encodeURIComponent(input.branch)}`;
    const res = await fetch(url, { headers: ghHeaders(input.token) });
    if (!res.ok) return null;
    const data = (await res.json()) as { commit?: { sha?: string } };
    return data.commit?.sha ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch the current status of a workflow run. Returns a poll result only if
 * the run has reached a terminal state; returns null while still running.
 */
export async function pollVerifyWorkflow(input: {
  env: Env;
  run: WorkerRunRecord;
  ownerEmail?: string;
}): Promise<VerifyPollResult | null> {
  const { env, run, ownerEmail } = input;
  if (!run.verifyWorkflowRunId) return null;
  const parsed = parseGithubRepo(run.repoUrl);
  if (!parsed) return null;
  const token = await resolveGithubToken(env, ownerEmail);
  if (!token) return null;

  const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/actions/runs/${encodeURIComponent(run.verifyWorkflowRunId)}`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) {
    console.warn(`[verify-gate] poll failed ${res.status}`);
    return null;
  }

  const data = (await res.json()) as {
    status: string;
    conclusion: string | null;
    html_url: string;
    updated_at: string;
  };

  // status is one of: queued, in_progress, completed
  if (data.status !== "completed") return null;
  const conclusion = (data.conclusion ?? "failure") as VerifyPollResult["conclusion"];
  return { conclusion, htmlUrl: data.html_url, completedAt: data.updated_at };
}

function ghHeaders(token: string): Record<string, string> {
  return {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "dodo-dispatch",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
