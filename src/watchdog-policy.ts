/**
 * Watchdog policy — pure decision function for session stall detection.
 *
 * The core logic (`decideWatchdog`) already lives in `./watchdog` and is
 * fully unit-tested there. This module provides an adapter that matches the
 * interface expected by the `improve-codebase-architecture` audit (#3) so
 * that `CodingAgent.runWatchdogCheck()` can be expressed as:
 *
 *   build snapshot → evaluateSession(snapshot, now) → apply recommendation
 *
 * The adapter is intentionally thin — the real decision work is in
 * `decideWatchdog`.
 */

import {
  decideWatchdog,
  type WatchdogConfig,
  type WatchdogObservation,
} from "./watchdog";

export interface WatchdogSnapshot {
  /** Session status: "running", "idle", etc. */
  status: string | null;
  /** Active prompt id, or null if none. */
  activePromptId: string | null;
  /** Last activity timestamp (epoch seconds). */
  lastActivityAt: number;
  /** Prompt id the watchdog already fired for, or null. */
  lastFiredForPromptId: string | null;
  /** Watchdog configuration (stall threshold, action, etc.). */
  config: WatchdogConfig;
}

export type WatchdogVerdict =
  | { kind: "healthy" }
  | {
      kind: "stalled";
      reasonCode: string;
      humanReason: string;
      /** Recommended action derived from the configured action. */
      recommend: "nudge" | "abort" | "wait";
      stallSeconds: number;
      activePromptId: string;
    };

/**
 * Evaluate whether the watchdog should fire on the given snapshot.
 *
 * This is a thin wrapper around `decideWatchdog` from `./watchdog`. The
 * canonical tests for the decision logic live in
 * `test/watchdog-unit.test.ts`.
 */
export function evaluateSession(
  snapshot: WatchdogSnapshot,
  now: number,
): WatchdogVerdict {
  const obs: WatchdogObservation = {
    nowEpoch: Math.floor(now / 1000),
    status: snapshot.status,
    activePromptId: snapshot.activePromptId,
    updatedAtEpoch: Number.isFinite(snapshot.lastActivityAt)
      ? snapshot.lastActivityAt
      : null,
    lastFiredForPromptId: snapshot.lastFiredForPromptId,
  };

  const decision = decideWatchdog(snapshot.config, obs);

  if (!decision) {
    return { kind: "healthy" };
  }

  const recommend = snapshot.config.action;

  return {
    kind: "stalled",
    reasonCode: "stall_threshold_exceeded",
    humanReason: `No activity for ${decision.stallSeconds}s (threshold: ${snapshot.config.stallSeconds}s)`,
    recommend: recommend === "notify" ? "wait" : recommend,
    stallSeconds: decision.stallSeconds,
    activePromptId: decision.activePromptId,
  };
}
