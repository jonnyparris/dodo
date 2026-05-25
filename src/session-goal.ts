/**
 * Session goals — make any session goal-directed and self-continuing.
 *
 * Today, a Dodo session runs one prompt → one assistant turn (multi-step
 * inside the AI SDK loop) → idle. If the model stops mid-task, the session
 * waits for a human to nudge it. Goals invert that: when a goal is `active`,
 * the agent finishing a turn auto-issues a "continue" prompt until the model
 * declares a terminal status via the `set_goal_status` tool, or the turn
 * budget is exhausted.
 *
 * State lives in the `metadata` k/v table on the CodingAgent DO:
 *
 *   goal_text         — what the agent is trying to achieve (plain text)
 *   goal_status       — one of GoalStatus
 *   goal_set_at       — unix epoch seconds when the goal was set
 *   goal_turns_used   — how many auto-continue turns have fired
 *   goal_max_turns    — hard cap (default 50)
 *   goal_summary      — last summary the agent wrote when it set status
 *   goal_role         — optional tag (e.g. "autopilot-worker"); cosmetic
 *
 * This module is pure helpers + types. The DO-side wiring lives in
 * coding-agent.ts; the tool lives in agentic.ts.
 */

export type GoalStatus =
  | "none"          // no goal set
  | "active"        // working toward it; auto-continue is on
  | "done"          // model declared success; stop
  | "blocked"       // model gave up with a reason; stop
  | "needs_input"   // model is waiting for a human answer; stop + notify
  | "exhausted";    // turn budget hit; stop

export interface GoalState {
  text: string | null;
  status: GoalStatus;
  setAt: number | null;
  turnsUsed: number;
  maxTurns: number;
  summary: string | null;
  role: string | null;
}

export const DEFAULT_GOAL_MAX_TURNS = 50;
export const HARD_GOAL_MAX_TURNS = 200;

/** Statuses where the auto-continue loop should keep firing. */
export function shouldAutoContinue(status: GoalStatus): boolean {
  return status === "active";
}

/** Statuses where the goal is considered finished (good or bad). */
export function isTerminalStatus(status: GoalStatus): status is "done" | "blocked" | "needs_input" | "exhausted" {
  return status === "done" || status === "blocked" || status === "needs_input" || status === "exhausted";
}

/**
 * Build the system-prompt snippet the agent sees when a goal is active.
 * Kept short — the model needs a reminder, not a treatise. Returns null
 * when there's no active goal so the caller can omit the section.
 */
export function renderGoalSystemPromptSection(state: GoalState): string | null {
  if (state.status === "none" || !state.text) return null;
  const lines = [
    "## Your goal",
    "",
    `Status: ${state.status}`,
    `Turn ${state.turnsUsed + 1} of ${state.maxTurns}.`,
    "",
    state.text.trim(),
    "",
  ];
  if (shouldAutoContinue(state.status)) {
    lines.push(
      "After each turn you'll be auto-prompted to continue until you declare a terminal status.",
      "Call `set_goal_status` with one of:",
      "- `done` when the goal is achieved (include a one-line summary of what you did).",
      "- `blocked` when you genuinely can't proceed (explain the blocker).",
      "- `needs_input` when you need a human decision (explain what's needed).",
      "",
      "Don't call `set_goal_status` just to narrate progress — only to declare a terminal state.",
    );
  }
  return lines.join("\n");
}

/** Build the auto-continue prompt for the next turn. Intentionally short. */
export function buildContinuePrompt(state: GoalState): string {
  // The system prompt already carries the goal and turn count. The
  // continue prompt is a nudge — anything more wastes tokens on something
  // the model just saw.
  const remaining = Math.max(0, state.maxTurns - state.turnsUsed);
  if (remaining <= 5) {
    return `Continue. You have ${remaining} turn${remaining === 1 ? "" : "s"} left before the budget is exhausted — wrap up and call set_goal_status.`;
  }
  return "Continue toward your goal. Call set_goal_status when you reach a terminal state.";
}
