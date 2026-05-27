/**
 * GoalStateStore — typed store of session-goal fields.
 *
 * Today this is a passthrough over the `metadata` k/v table on the
 * CodingAgent DO. It groups the 7 `goal_*` keys into one typed surface
 * with a single writer for `goal_status` (formerly split between
 * `updateGoalStatus` and `incrementGoalTurns`).
 *
 *   goal_text         — what the agent is trying to achieve
 *   goal_status       — one of GoalStatus
 *   goal_set_at       — epoch seconds when the goal was set
 *   goal_turns_used   — auto-continue turns fired
 *   goal_max_turns    — hard cap
 *   goal_summary      — last summary the model wrote
 *   goal_role         — optional tag
 *
 * The pure helpers (`shouldAutoContinue`, `buildContinuePrompt`,
 * `renderGoalSystemPromptSection`, `isTerminalStatus`) stay in
 * `./session-goal`. This module owns *storage* only.
 */

import type { MetadataKv } from "./session-control-plane";
import {
  DEFAULT_GOAL_MAX_TURNS,
  type GoalState,
  type GoalStatus,
  HARD_GOAL_MAX_TURNS,
} from "./session-goal";
import { nowEpoch } from "./sql-helpers";

const GOAL_KEYS = [
  "goal_text",
  "goal_status",
  "goal_set_at",
  "goal_turns_used",
  "goal_max_turns",
  "goal_summary",
  "goal_role",
] as const;

export interface GoalStateStore {
  read(): GoalState;
  /** Set or replace the active goal. Resets turn counter. */
  set(opts: { text: string; maxTurns?: number; role?: string }): GoalState;
  /** Update the goal status (called from the `set_goal_status` tool). */
  updateStatus(status: GoalStatus, summary?: string): GoalState;
  /** Clear all goal state. */
  clear(): void;
  /**
   * Increment the turn counter; flips `goal_status` to `exhausted` when
   * the budget is reached. Returns the new state.
   */
  incrementTurns(): GoalState;
}

export function createGoalStateStore(kv: MetadataKv): GoalStateStore {
  function read(): GoalState {
    const status = (kv.read("goal_status") as GoalStatus | null) ?? "none";
    const maxRaw = kv.read("goal_max_turns");
    const turnsRaw = kv.read("goal_turns_used");
    const setAtRaw = kv.read("goal_set_at");
    return {
      text: kv.read("goal_text"),
      status,
      setAt: setAtRaw ? Number(setAtRaw) : null,
      turnsUsed: turnsRaw ? Number(turnsRaw) : 0,
      maxTurns: maxRaw ? Number(maxRaw) : DEFAULT_GOAL_MAX_TURNS,
      summary: kv.read("goal_summary"),
      role: kv.read("goal_role"),
    };
  }

  return {
    read,

    set(opts) {
      const max = Math.min(
        Math.max(1, Math.floor(opts.maxTurns ?? DEFAULT_GOAL_MAX_TURNS)),
        HARD_GOAL_MAX_TURNS,
      );
      kv.write("goal_text", opts.text);
      kv.write("goal_status", "active");
      kv.write("goal_set_at", String(nowEpoch()));
      kv.write("goal_turns_used", "0");
      kv.write("goal_max_turns", String(max));
      if (opts.role) {
        kv.write("goal_role", opts.role);
      } else {
        kv.delete("goal_role");
      }
      kv.delete("goal_summary");
      return read();
    },

    updateStatus(status, summary) {
      kv.write("goal_status", status);
      if (summary) kv.write("goal_summary", summary);
      return read();
    },

    clear() {
      for (const key of GOAL_KEYS) {
        kv.delete(key);
      }
    },

    incrementTurns() {
      const state = read();
      const next = state.turnsUsed + 1;
      kv.write("goal_turns_used", String(next));
      if (next >= state.maxTurns) {
        kv.write("goal_status", "exhausted");
      }
      return read();
    },
  };
}
