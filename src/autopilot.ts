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
 * Build the diagnose prompt template injected into a self-diagnose worker
 * session. The prompt is intentionally direct, hard-capped on turns, and
 * stops short of merging anything.
 *
 * `targetArea` is optional — when set, the worker is told to focus on that
 * area; otherwise it picks the highest-impact issue from the log sweep.
 */
export function buildDiagnosePrompt(opts: {
  targetArea?: string;
  contextNotes?: string;
  sinceHours?: number;
  branchPrefix?: string;
}): string {
  const sinceHours = opts.sinceHours ?? 24;
  const branchPrefix = opts.branchPrefix ?? "autopilot/diagnose";
  const focus = opts.targetArea
    ? `**Target area:** ${opts.targetArea}\n`
    : "**Target area:** pick the single highest-impact issue from the log sweep.\n";
  const notes = opts.contextNotes
    ? `\n**Supervisor notes:**\n${opts.contextNotes}\n`
    : "";

  return [
    "You are a Dodo autopilot worker session. Your job is to investigate one issue in the Dodo codebase and submit a draft PR with a fix.",
    "",
    focus.trim(),
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
    "5. Make the minimum viable fix. Run `npm test` (the focused tests for the area you changed — not the full suite). Add or extend a test that covers the bug.",
    `6. Create a branch named \`${branchPrefix}-{short-sha}-{slug}\` and commit with a clear message.`,
    "7. Push to GitHub and open a **draft** pull request. Title prefix: `[autopilot] `. Body: link to the log evidence, describe the fix, list the test you added.",
    "8. If you can't find an actionable issue, write a short note to the session log explaining what you saw and stop. Don't open a PR.",
    "",
    "**Hard rules:**",
    "",
    "- Hard cap: 50 tool turns. If you're not close to a PR by turn 40, write a status note and stop.",
    "- NEVER auto-merge. Draft PR only. Human review required.",
    "- NEVER force-push or rewrite history.",
    "- NEVER touch `wrangler.jsonc` migrations without an explicit instruction in the supervisor notes.",
    "- NEVER edit secrets or `.dev.vars`.",
    "- If the fix would change more than 5 files, stop and write a note instead — the supervisor will break it down.",
    "",
    "Begin by reading recent worker logs.",
  ].join("\n");
}

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
 * Build the supervisor prompt. The supervisor runs on a cron, reads
 * aggregated logs and the last few worker runs, then dispatches one or
 * more workers via `dispatch_autopilot_worker`. Stops itself if the last
 * N runs produced no actionable issue (cooldown signal).
 */
export function buildSupervisorPrompt(opts: { sinceHours?: number } = {}): string {
  const sinceHours = opts.sinceHours ?? 12;
  return [
    "You are the Dodo autopilot supervisor. You run on a schedule. Your job is to decide whether anything in the Dodo codebase needs investigating right now, and if so, dispatch worker sessions to do the investigation.",
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
    "- Write a short note to the session log explaining what you saw (or didn't see).",
    "- Do NOT dispatch workers if you can't articulate a concrete target area.",
    "",
    "**Stuck-pattern detection:**",
    "",
    "- If the same error pattern appears in `list_failed_sessions` for the third supervisor run in a row WITHOUT a worker successfully fixing it, send a `high`-priority `autopilot_notify` titled 'autopilot paused — repeated failure pattern' with the pattern details. Then write a note and stop. Do not dispatch more workers for that pattern.",
    "",
    "**Hard rules:**",
    "",
    "- Max 3 worker dispatches per supervisor run.",
    "- Never dispatch a worker for a problem that's already in flight (status=running on an existing autopilot session).",
    "- Never auto-merge anything. Workers always open draft PRs.",
    "- Keep your own analysis short — you're a router, not an investigator. The workers do the deep work.",
    "",
    "Begin by listing failed sessions.",
  ].join("\n");
}
