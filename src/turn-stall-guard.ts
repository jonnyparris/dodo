// Fail a prompt turn that stops making progress anywhere, not only inside
// a model request.
//
// On 10-21 session f25c9901 sat in one turn for 30 minutes with no AI
// Gateway traffic until an outside abort ended it. PR #140
// (src/pi/stream-idle-timeout.ts) covers a model request that goes quiet.
// It does not cover the steps before the first request (app config read,
// Think migration, MCP connect, context warm-up, tool build, pi prepare and
// submit), and the hang point in f25c9901 was never found. Several of
// those steps await network or other DOs with no timeout of their own.
//
// The guard keeps a "last progress" clock. The turn moves it forward at
// each setup step (touch(phase)) and on every pi agent event (event(e)).
// If the clock stops for longer than the limit, the guard rejects
// `run()`'s race with a TurnStallError and calls `onStall` (the caller
// aborts the turn). The race matters: an await that ignores the abort
// signal can't hold the prompt open, so the session takes new prompts.
//
// Long work with no events in between gets a longer limit: while a tool
// call (or a compaction) is open, `longMs` applies instead of `idleMs`.
// The longest known tools finish well inside it (Kitebuild 15 min,
// task subagent 10 min, see src/tools/kitebuild.ts and agent-profile.ts).
//
// Limits are generous on purpose. A false positive fails a healthy turn,
// and a stalled model request already fails and retries after 5 minutes
// (each retry is an event, so it moves the clock).

/** No progress for this long outside a tool call fails the turn. */
export const DEFAULT_TURN_STALL_IDLE_MS = 15 * 60_000;
/** No progress for this long while a tool call (or compaction) is open fails the turn. */
export const DEFAULT_TURN_STALL_LONG_MS = 30 * 60_000;
/** Longest gap between stall checks. */
const MAX_CHECK_MS = 30_000;

export interface TurnStallLimits {
  /** 0 turns the guard off. */
  idleMs: number;
  longMs: number;
}

export const DEFAULT_TURN_STALL_LIMITS: TurnStallLimits = {
  idleMs: DEFAULT_TURN_STALL_IDLE_MS,
  longMs: DEFAULT_TURN_STALL_LONG_MS,
};

/**
 * Limits from env: TURN_STALL_SECONDS (idle) and TURN_STALL_TOOL_SECONDS
 * (while a tool runs). TURN_STALL_SECONDS=0 turns the guard off. Bad or
 * missing values use the defaults. The long limit is never below the idle one.
 */
export function turnStallLimitsFromEnv(env: { TURN_STALL_SECONDS?: string; TURN_STALL_TOOL_SECONDS?: string }): TurnStallLimits {
  const seconds = (raw: string | undefined): number | null => {
    if (raw === undefined || raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  };
  const idle = seconds(env.TURN_STALL_SECONDS);
  const long = seconds(env.TURN_STALL_TOOL_SECONDS);
  const idleMs = idle === null ? DEFAULT_TURN_STALL_IDLE_MS : idle * 1000;
  if (idleMs === 0) return { idleMs: 0, longMs: 0 };
  const longMs = long === null || long === 0 ? DEFAULT_TURN_STALL_LONG_MS : long * 1000;
  return { idleMs, longMs: Math.max(longMs, idleMs) };
}

export interface TurnStallInfo {
  /** The last step or event seen before the stall. */
  phase: string;
  idleMs: number;
  limitMs: number;
  /** Open tool calls, by name. */
  openTools: string[];
  /** Events seen this turn. */
  events: number;
}

export class TurnStallError extends Error {
  readonly info: TurnStallInfo;
  constructor(info: TurnStallInfo) {
    const tools = info.openTools.length ? `, waiting on tool ${info.openTools.join(", ")}` : "";
    super(
      `Turn stalled: no progress for ${Math.round(info.idleMs / 1000)}s (last step: ${info.phase}${tools}). ` +
        "Dodo stopped the turn so the session can take new prompts. Try again.",
    );
    this.name = "TurnStallError";
    this.info = info;
  }
}

/** The subset of pi agent events the guard reads. */
export interface TurnStallEvent {
  type: string;
  toolCallId?: string;
  toolName?: string;
}

export interface TurnStallGuard {
  /** A setup step started. Moves the clock. */
  touch(phase: string): void;
  /** A pi agent event arrived. Moves the clock and tracks open tool calls. */
  event(event: TurnStallEvent): void;
  /** Race `work` against the stall. The loser's rejection is swallowed. */
  run<T>(work: Promise<T>): Promise<T>;
  /** The stall, once it fired. */
  readonly fired: TurnStallError | null;
  /** Stop checking. Safe to call more than once. */
  stop(): void;
}

export interface TurnStallGuardOptions {
  limits: TurnStallLimits;
  /** Called once, when the stall fires (abort the turn, log). */
  onStall?: (error: TurnStallError) => void;
  /** Called on every touch/event (e.g. to keep the session's updated_at fresh). */
  onProgress?: () => void;
  now?: () => number;
}

export function createTurnStallGuard(options: TurnStallGuardOptions): TurnStallGuard {
  const now = options.now ?? Date.now;
  const { idleMs, longMs } = options.limits;
  let last = now();
  let phase = "start";
  let events = 0;
  let fired: TurnStallError | null = null;
  let stopped = idleMs <= 0;
  const openTools = new Map<string, string>();
  let compacting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectStall: ((err: TurnStallError) => void) | undefined;
  const stalled = new Promise<never>((_, reject) => {
    rejectStall = reject;
  });
  // Nobody may be racing yet when it fires; don't report it as unhandled.
  stalled.catch(() => {});

  const limit = () => (openTools.size > 0 || compacting ? longMs : idleMs);

  const check = () => {
    timer = undefined;
    if (stopped) return;
    const idle = now() - last;
    const lim = limit();
    if (idle >= lim) {
      stopped = true;
      fired = new TurnStallError({ phase, idleMs: idle, limitMs: lim, openTools: [...openTools.values()], events });
      rejectStall?.(fired);
      try {
        options.onStall?.(fired);
      } catch {
        // onStall is best-effort; the race already rejected.
      }
      return;
    }
    schedule(lim - idle);
  };

  const schedule = (dueInMs: number) => {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(check, Math.max(1, Math.min(dueInMs, MAX_CHECK_MS)));
  };

  const progress = (p: string) => {
    if (stopped) return;
    last = now();
    phase = p;
    try {
      options.onProgress?.();
    } catch {
      // never let bookkeeping break the turn
    }
  };

  if (!stopped) schedule(idleMs);

  return {
    touch(p) {
      progress(p);
    },
    event(e) {
      if (stopped) return;
      events++;
      if (e.type === "tool_execution_start" && e.toolCallId) openTools.set(e.toolCallId, e.toolName ?? "tool");
      else if (e.type === "tool_execution_end" && e.toolCallId) openTools.delete(e.toolCallId);
      else if (e.type === "compaction_start") compacting = true;
      else if (e.type === "compaction_end") compacting = false;
      progress(e.toolName ? `${e.type}:${e.toolName}` : e.type);
    },
    run<T>(work: Promise<T>): Promise<T> {
      // If the stall wins, `work` may still settle later; don't let its
      // rejection surface as unhandled.
      work.catch(() => {});
      if (stopped && !fired) return work;
      return Promise.race([work, stalled]);
    },
    get fired() {
      return fired;
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
