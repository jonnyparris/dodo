// Session watchdog — autonomous stall detection for long-running prompts.
//
// The CodingAgent registers a recurring schedule (default `*/5 * * * *`)
// that ticks `runWatchdogCheck()`. Each tick reads the session's current
// status, the elapsed time since the last activity stamp, and decides
// whether to take action. The decision logic lives here as pure
// functions so it can be unit-tested without booting a DO.
//
// Fire-once semantics: when a watchdog fires for active prompt P, it
// records P's id. It will not fire again until the active prompt id
// changes (either P aborted/completed or a new prompt started). This
// prevents notification spam on long stalls.

/** Action taken when a prompt is judged stuck. */
export type WatchdogAction = "notify" | "abort" | "nudge";

/** User-supplied watchdog configuration, stored as JSON in agent
 *  metadata under the key `watchdog_config`. */
export type WatchdogConfig = {
  /** Threshold for considering an active prompt stuck (seconds). */
  stallSeconds: number;
  /** What to do when a stall is detected. */
  action: WatchdogAction;
  /** Cron expression for the watchdog tick. Defaults to every 5 minutes. */
  checkCron: string;
  /** Custom nudge prompt body. Only used when `action === "nudge"`.
   *  When omitted, a built-in default is used. */
  nudgePrompt?: string;
};

/** Bounded knobs — picked to keep watchdog cheap and idempotent. */
export const WATCHDOG_LIMITS = {
  /** Minimum stall threshold (60s). Below this you'd just be hitting
   *  every healthy prompt that happened to be mid-tool-call. */
  minStallSeconds: 60,
  /** Maximum stall threshold (24h). Beyond this the schedule itself
   *  is probably the wrong tool. */
  maxStallSeconds: 24 * 60 * 60,
  /** Default check cadence — every 5 minutes is fine; a stall of 10+
   *  minutes is the interesting case. */
  defaultCheckCron: "*/5 * * * *",
  /** Default stall threshold — 10 minutes. */
  defaultStallSeconds: 600,
} as const;

/** Built-in nudge prompt. Asks the agent to summarise where it got
 *  stuck and stop — gives the user a useful breadcrumb without
 *  the watchdog needing to know anything about the underlying task. */
export const DEFAULT_NUDGE_PROMPT =
  "Your previous prompt was aborted by a session watchdog because it appeared stuck (no activity for the configured stall threshold). In one short paragraph, summarise where you got stuck and what you'd try differently next time. Then stop — do not retry the original task.";

/** Validate and normalise a user-supplied config. Throws on bad
 *  input — caller surfaces the message as a 400. */
export function normaliseWatchdogConfig(raw: unknown): WatchdogConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("watchdog config must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const stallSeconds = Number(obj.stallSeconds ?? WATCHDOG_LIMITS.defaultStallSeconds);
  if (!Number.isFinite(stallSeconds) || !Number.isInteger(stallSeconds)) {
    throw new Error("stallSeconds must be an integer");
  }
  if (stallSeconds < WATCHDOG_LIMITS.minStallSeconds || stallSeconds > WATCHDOG_LIMITS.maxStallSeconds) {
    throw new Error(`stallSeconds must be between ${WATCHDOG_LIMITS.minStallSeconds} and ${WATCHDOG_LIMITS.maxStallSeconds}`);
  }
  const action = (obj.action ?? "notify") as WatchdogAction;
  if (action !== "notify" && action !== "abort" && action !== "nudge") {
    throw new Error("action must be one of: notify, abort, nudge");
  }
  const checkCron = String(obj.checkCron ?? WATCHDOG_LIMITS.defaultCheckCron);
  // Loose cron validation — the agent.schedule call will reject malformed
  // expressions, so we don't reimplement parsing here. Just check shape.
  if (checkCron.split(/\s+/).filter(Boolean).length !== 5) {
    throw new Error("checkCron must be a 5-field cron expression");
  }
  const nudgePrompt = obj.nudgePrompt === undefined ? undefined : String(obj.nudgePrompt);
  if (nudgePrompt !== undefined && nudgePrompt.length > 4000) {
    throw new Error("nudgePrompt must be <= 4000 characters");
  }
  return { stallSeconds, action, checkCron, nudgePrompt };
}

/** Snapshot of session state needed to decide watchdog action. */
export type WatchdogObservation = {
  /** Wall clock (epoch seconds) at the moment of the check. */
  nowEpoch: number;
  /** Session status from agent metadata. */
  status: "idle" | "running" | string | null;
  /** Active prompt id, if any. */
  activePromptId: string | null;
  /** Last activity timestamp as an epoch (seconds). When null, the
   *  watchdog treats the session as never-active and does nothing. */
  updatedAtEpoch: number | null;
  /** The prompt id we already fired for in this stall, if any. */
  lastFiredForPromptId: string | null;
};

/** Pure decision: should the watchdog fire on this observation, and if
 *  so, why? Returns `null` when no action is warranted. */
export function decideWatchdog(
  config: WatchdogConfig,
  obs: WatchdogObservation,
): { fire: true; stallSeconds: number; activePromptId: string } | null {
  // Only stall an active prompt
  if (obs.status !== "running") return null;
  if (!obs.activePromptId) return null;
  if (obs.updatedAtEpoch === null) return null;

  // Has it been stuck long enough?
  const elapsed = obs.nowEpoch - obs.updatedAtEpoch;
  if (elapsed < config.stallSeconds) return null;

  // Already fired for this active prompt — don't double-fire.
  if (obs.lastFiredForPromptId === obs.activePromptId) return null;

  return { fire: true, stallSeconds: elapsed, activePromptId: obs.activePromptId };
}

/** Human-readable summary of a fired decision, suitable for a
 *  notification body. */
export function formatStallBody(
  sessionId: string,
  decision: { stallSeconds: number; activePromptId: string },
  action: WatchdogAction,
): string {
  const mins = Math.floor(decision.stallSeconds / 60);
  const lines = [
    `Session: ${sessionId}`,
    `Prompt: ${decision.activePromptId}`,
    `Stalled for: ${mins} minute${mins === 1 ? "" : "s"}`,
    `Action: ${action}`,
  ];
  return lines.join("\n");
}
