/**
 * Autopilot — Dodo's self-diagnose loop.
 *
 * Two layers:
 *
 * 1. **Worker sessions** (this module's `kickoffWorkerSession`) — short-lived,
 *    forked from a seed clone of the Dodo repo, ask an LLM to investigate a
 *    target area and submit a draft PR.
 * 2. **Supervisor session** (scheduled via `/api/admin/autopilot/schedule`,
 *    not implemented in 4c-i) — long-lived, reads aggregated logs every
 *    N hours, dispatches one or more workers, accretes state in an
 *    `autopilot-state.md` file in its workspace.
 *
 * 4c-i (this commit): manual kickoff only. The admin clicks a button, the
 * server creates a fresh session, attaches the diagnose prompt template,
 * and lets the LLM go. 4c-ii adds the scheduled supervisor + worker fan-out.
 */

import type { Env } from "./types";

/**
 * Build the diagnose goal text — the description of what an autopilot
 * worker is trying to accomplish. Used as the `goal_text` on the worker
 * session; the session self-continues until the model calls
 * `set_goal_status` with `done`, `blocked`, or `needs_input`.
 *
 * `targetArea` is optional — when set, the worker focuses on that area;
 * otherwise it picks the highest-impact issue from the log sweep.
 */
export function buildDiagnoseGoal(opts: {
  targetArea?: string;
  contextNotes?: string;
  sinceHours?: number;
  branchPrefix?: string;
}): string {
  const sinceHours = opts.sinceHours ?? 24;
  const branchPrefix = opts.branchPrefix ?? "autopilot/diagnose";
  const focus = opts.targetArea
    ? `**Target area:** ${opts.targetArea}`
    : "**Target area:** pick the single highest-impact issue from the log sweep.";
  const notes = opts.contextNotes
    ? `\n**Supervisor notes:**\n${opts.contextNotes}\n`
    : "";

  return [
    "Investigate one issue in the Dodo codebase and submit a draft PR with a fix.",
    "",
    focus,
    notes.trim(),
    "",
    "**Workspace:** the Dodo repo is already cloned (forked from the autopilot seed).",
    "",
    "**Steps:**",
    "",
    `1. Call \`fetch_worker_logs\` (sinceHours=${sinceHours}, errorOnly=true) and skim recent exception patterns. If a target area is set, also call \`fetch_worker_logs\` with that as the needle.`,
    "2. Call `list_failed_sessions` for additional triage signal (stalled schedules, client errors).",
    "3. Pick ONE concrete, fixable issue. Skip anything that needs human judgement or product input.",
    "4. Investigate the relevant source files. Use `read`, `grep`, `glob` aggressively before changing anything.",
    "5. Make the minimum viable fix. Run focused tests for the area you changed. Add or extend a test that covers the bug.",
    `6. Create a branch named \`${branchPrefix}-{short-sha}-{slug}\` and commit with a clear message.`,
    "7. Push to GitHub and open a **draft** pull request. Title prefix: `[autopilot] `. Body: link to the log evidence, describe the fix, list the test you added.",
    "",
    "**Terminal states:**",
    "",
    "- After opening a draft PR, call `set_goal_status` with `status: \"done\"` and a one-line summary of what you fixed.",
    "- If you couldn't find an actionable issue, call `set_goal_status` with `status: \"blocked\"` and a short note on what you looked at.",
    "- If a human needs to make a decision (e.g. ambiguous root cause), call `set_goal_status` with `status: \"needs_input\"` and the question.",
    "",
    "**Hard rules:**",
    "",
    "- NEVER auto-merge. Draft PR only. Human review required.",
    "- NEVER force-push or rewrite history.",
    "- NEVER touch `wrangler.jsonc` migrations without an explicit instruction in the supervisor notes.",
    "- NEVER edit secrets or `.dev.vars`.",
    "- If the fix would change more than 5 files, call `set_goal_status: blocked` with a note instead — the supervisor will break it down.",
  ].join("\n");
}

/**
 * @deprecated kept temporarily for the autopilot kickoff endpoint while it
 * transitions to goal-based flow. Use `buildDiagnoseGoal` instead.
 */
export const buildDiagnosePrompt = buildDiagnoseGoal;

/** Marker stored on a session's metadata to flag it as an autopilot run. */
export const AUTOPILOT_METADATA_KEY = "is_autopilot";

/**
 * Resolve the admin email — autopilot sessions always belong to the admin.
 * Throws if no admin is configured (the kickoff endpoint guards on this).
 */
export function resolveAutopilotOwner(env: Env): string {
  const admin = env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!admin) {
    throw new Error("ADMIN_EMAIL not configured — autopilot needs an admin to act on behalf of.");
  }
  return admin;
}

/**
 * Build the supervisor prompt. The supervisor runs on a cron and is
 * **not** goal-driven across turns — each cron fire is a fresh
 * single-prompt session that lists failed sessions, decides whether to
 * dispatch workers, and finishes. The cron is the continuation
 * mechanism, not auto-continue.
 *
 * Workers dispatched via `dispatch_autopilot_worker` ARE goal-driven —
 * they self-continue until `set_goal_status` fires.
 */
export function buildSupervisorGoal(opts: { sinceHours?: number } = {}): string {
  const sinceHours = opts.sinceHours ?? 12;
  return [
    "Decide whether anything in the Dodo codebase needs investigating right now, and if so, dispatch worker sessions to investigate.",
    "",
    "**Steps:**",
    "",
    `1. Call \`list_failed_sessions\` with sinceHours=${sinceHours}. Look at the worker exceptions, the top client-error groups, and the stalled scheduled sessions.`,
    "2. Call `list_autopilot_workers` to see what previous workers did. Read titles + statuses.",
    "3. Decide: is there a concrete, fixable issue that no worker has already investigated?",
    "",
    "**If yes:**",
    "",
    "- For each distinct issue (max 3 per supervisor run): call `dispatch_autopilot_worker` with a clear `targetArea` and `contextNotes` that include the log evidence.",
    "- Call `autopilot_notify` with a short summary: how many workers you dispatched and what they're investigating.",
    "",
    "**If no:**",
    "",
    "- Write a short note explaining what you saw (or didn't see) and stop. Do NOT dispatch workers if you can't articulate a concrete target area.",
    "",
    "**Stuck-pattern detection:**",
    "",
    "- If the same error pattern appears in `list_failed_sessions` for the third supervisor run in a row WITHOUT a worker successfully fixing it, send a `high`-priority `autopilot_notify` titled 'autopilot paused — repeated failure pattern' with the pattern details. Don't dispatch more workers for that pattern.",
    "",
    "**Hard rules:**",
    "",
    "- Max 3 worker dispatches per supervisor run.",
    "- Never dispatch a worker for a problem that's already in flight (status=running on an existing autopilot session).",
    "- Never auto-merge anything. Workers always open draft PRs.",
    "- Keep your own analysis short — you're a router, not an investigator. The workers do the deep work.",
  ].join("\n");
}

/** @deprecated use {@link buildSupervisorGoal}. */
export const buildSupervisorPrompt = buildSupervisorGoal;
