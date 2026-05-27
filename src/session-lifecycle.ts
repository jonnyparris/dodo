/**
 * SessionLifecycle — the single front door for prompt transitions.
 *
 * See ADR-0001 (docs/adr/0001-session-lifecycle-owns-prompt-transitions.md)
 * for the design decision and CONTEXT.md for vocabulary.
 *
 * This module collapses six previously-duplicated "start a prompt fiber"
 * call sites in coding-agent.ts into one operation. Source identifies the
 * caller; a typed SOURCE_POLICIES table maps source to behaviour
 * (busy-policy, retry count, whether to emit state events / sync session
 * index / send notifications).
 *
 * The state machine:
 *
 *   idle → start(intent) → either:
 *     - "started": activePromptId set, status=running, fiber spawned
 *     - "queued":  appended to prompt_queue, no state change
 *     - "rejected": no state change, caller decides how to respond
 *
 *   running → finish(promptId, cause):
 *     - prompt row updated, fiber abort controller cleared
 *     - status=idle, activePromptId cleared
 *     - dequeueNext → if a queued user prompt exists, start it
 *     - else autoContinue → if GoalState says so, start a continue prompt
 *     - else session goes truly idle
 *
 * Invariants:
 *  - At most one fiber per session at any time. Enforced by
 *    SessionControlPlane.activePromptId being the gate.
 *  - On `finish`: at most ONE of {dequeueNext, autoContinue} fires.
 *    Queued user prompts win (matches pre-refactor behaviour of
 *    `maybeAutoContinue`'s queue check).
 *  - `goal_turns_used` increments only on the autoContinue branch.
 *  - The abort path always cancels the AbortController BEFORE writing
 *    the prompt row so a late-arriving "completed" cannot overwrite the
 *    "aborted" status.
 */

import type { GoalState } from "./session-goal";
import { buildContinuePrompt, isTerminalStatus, shouldAutoContinue } from "./session-goal";
import type { GoalStateStore } from "./goal-state-store";
import type { NotificationInput as NotifyInput } from "./notify";
import type {
  SessionControlPlane,
  SessionControlSnapshot,
  SessionStatus,
} from "./session-control-plane";

// ─── Source policy table ────────────────────────────────────────────────

/** Who originated a prompt — determines policy via SOURCE_POLICIES. */
export type PromptSource =
  | "user"
  | "watchdog"
  | "cron"
  | "queue"
  | "goal-autocontinue"
  | "image-gen";

/**
 * Per-source policy. Adding a new source = one row.
 *
 *  - onBusy: what to do when activePromptId is already set.
 *  - maxRetries: passed to FiberDriver.spawnFiber.
 *  - syncIndex: emit a sync to UserControl (status + title).
 *  - emitState: emit an SSE "state" event.
 *  - notifyOnError / notifyOnComplete: send ntfy notifications on finish.
 *  - synchronous: prompt runs inline (image-gen); no fiber spawned.
 *  - emitOnFire: extra SSE event type to emit when this source starts
 *    successfully (watchdog uses "watchdog_fired" instead of "state").
 *  - authorEmailLabel: fallback author when caller doesn't supply one.
 */
export interface SourcePolicy {
  readonly onBusy: "queue" | "skip" | "reject";
  readonly maxRetries: number;
  readonly syncIndex: boolean;
  readonly emitState: boolean;
  readonly notifyOnError: boolean;
  readonly notifyOnComplete: boolean;
  readonly synchronous?: boolean;
  readonly emitOnFire?: string;
  readonly authorEmailLabel?: string;
}

export const SOURCE_POLICIES: Record<PromptSource, SourcePolicy> = {
  user: {
    onBusy: "queue",
    maxRetries: 3,
    syncIndex: true,
    emitState: true,
    notifyOnError: true,
    notifyOnComplete: true,
  },
  watchdog: {
    onBusy: "skip",
    maxRetries: 1,
    syncIndex: false,
    emitState: false,
    notifyOnError: false,
    notifyOnComplete: false,
    authorEmailLabel: "watchdog",
  },
  cron: {
    onBusy: "skip",
    maxRetries: 3,
    syncIndex: false,
    emitState: false,
    notifyOnError: true,
    notifyOnComplete: true,
    authorEmailLabel: "cron",
  },
  queue: {
    onBusy: "skip", // queue is internal — should never be called when busy
    maxRetries: 3,
    syncIndex: true,
    emitState: true,
    notifyOnError: true,
    notifyOnComplete: true,
  },
  "goal-autocontinue": {
    onBusy: "skip",
    maxRetries: 3,
    syncIndex: false,
    emitState: false,
    notifyOnError: false,
    notifyOnComplete: false,
    authorEmailLabel: "goal-autocontinue",
  },
  "image-gen": {
    onBusy: "reject",
    maxRetries: 0,
    syncIndex: false,
    emitState: false,
    notifyOnError: false,
    notifyOnComplete: false,
    synchronous: true,
  },
};

// ─── Public types ───────────────────────────────────────────────────────

export interface StartIntent {
  source: PromptSource;
  content: string;
  authorEmail?: string | null;
  /** Optional image attachments (user-prompt only today). */
  images?: Array<{ data: string; mediaType: string }>;
  /** Override the title derivation; used by snapshot-import paths. */
  titleHint?: string;
}

export type StartOutcome =
  | { kind: "started"; promptId: string; fiberId: string | null; title: string }
  | { kind: "queued"; promptId: string; position: number }
  | { kind: "rejected"; reason: "busy" | "empty"; message: string }
  | { kind: "skipped"; reason: "busy" };

export type FinishCause =
  | {
      kind: "completed";
      resultMessageId?: string;
      text?: string;
      tokenInput?: number;
      tokenOutput?: number;
    }
  | { kind: "failed"; error: string }
  | { kind: "aborted"; reason?: string };

export type AbortOutcome =
  | { kind: "aborted"; promptId: string }
  | { kind: "noop" };

// ─── Injected ports ─────────────────────────────────────────────────────

/**
 * FiberDriver — the narrow port through which SessionLifecycle drives
 * Think fibers. Production: bound CodingAgent inherited methods. Test:
 * in-memory fake.
 */
export interface FiberDriver {
  spawnFiber(method: string, payload: unknown, opts?: { maxRetries?: number }): string;
  cancelFiber(id: string): void;
  readPromptFiberId(promptId: string): string | null;
  setPromptFiberId(promptId: string, fiberId: string): void;
}

/** SQL row interface for the prompts and prompt_queue tables. */
export interface PromptRepo {
  insert(opts: {
    promptId: string;
    content: string;
    status: "queued" | "running";
    source: string | null;
  }): void;
  update(
    promptId: string,
    patch: {
      status: "completed" | "failed" | "aborted";
      error?: string;
      resultMessageId?: string;
    },
  ): void;
  enqueue(content: string, authorEmail: string | null): { promptId: string; position: number };
  dequeue(): { promptId: string; content: string; authorEmail: string | null } | null;
  emitQueueUpdate(): void;
}

/** Re-export so callers don't need to import from notify.ts directly. */
export type NotificationInput = NotifyInput;

export type EmitEvent = (event: { type: string; data: unknown }) => void;
export type Notify = (n: NotificationInput) => void;
export type SyncIndex = (patch: { status: SessionStatus; title?: string }) => Promise<void>;

/**
 * The fiber body itself is owned by CodingAgent (it calls runThinkChat
 * inside Think's chat loop). Lifecycle just spawns it with a typed payload.
 */
export interface FiberPromptPayload {
  promptId: string;
  content: string;
  authorEmail?: string;
  title: string;
  images?: Array<{ data: string; mediaType: string }>;
}

// ─── Module-private helpers ─────────────────────────────────────────────

function deriveTitle(content: string, intent: StartIntent, current: SessionControlSnapshot): string {
  if (intent.titleHint) return intent.titleHint;
  if (current.title) return current.title;
  // Match the longer of the two pre-refactor derivations (HTTP path used
  // 72 chars; WS path used 50). 72 wins — more context, same code.
  return content.length > 72 ? content.slice(0, 72) + "…" : content;
}

function resolveAuthor(intent: StartIntent, policy: SourcePolicy): string | undefined {
  if (intent.authorEmail) return intent.authorEmail;
  return policy.authorEmailLabel;
}

// ─── The lifecycle ──────────────────────────────────────────────────────

export interface SessionLifecycleDeps {
  control: SessionControlPlane;
  goal: GoalStateStore;
  fibers: FiberDriver;
  prompts: PromptRepo;
  emit: EmitEvent;
  notify: Notify;
  syncIndex: SyncIndex;
  /**
   * Returns the active AbortController so abort can signal the in-flight
   * LLM call. May return null if none is active.
   */
  getAbortController(): AbortController | null;
  setAbortController(c: AbortController | null): void;
  /** Logger callback for diagnostic output (info / warn). */
  log?: (level: "info" | "warn", message: string, fields?: Record<string, unknown>) => void;
  /** UUID generator (injectable for tests). */
  uuid?: () => string;
  /**
   * The Think config refresh — called once before each fresh prompt
   * spawn, matching pre-refactor `readAppConfig()` calls.
   */
  readAppConfig: () => Promise<unknown>;
}

export interface SessionLifecycle {
  start(intent: StartIntent): Promise<StartOutcome>;
  finish(promptId: string, cause: FinishCause): Promise<void>;
  abortActive(): Promise<AbortOutcome>;
  /** Read-only snapshot for SSE / HTTP responders. */
  snapshot(): SessionControlSnapshot;
  /** Read goal state via the underlying store. Convenience accessor. */
  readGoalState(): GoalState;
}

export function createSessionLifecycle(deps: SessionLifecycleDeps): SessionLifecycle {
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  const log = deps.log ?? (() => {});

  /**
   * Core "spawn a prompt" sequence used by every start path.
   * Assumes the busy check has already been done.
   */
  async function spawnPrompt(
    promptId: string,
    intent: StartIntent,
    policy: SourcePolicy,
    title: string,
  ): Promise<{ fiberId: string | null }> {
    deps.control.beginPrompt(promptId, title);
    deps.prompts.insert({
      promptId,
      content: intent.content,
      status: "queued",
      source: resolveAuthor(intent, policy) ?? null,
    });

    if (policy.syncIndex) {
      await deps.syncIndex({ status: "running", title }).catch(() => {});
    }

    if (policy.emitState) {
      deps.emit({ data: deps.control.read(), type: "state" });
    }

    if (policy.synchronous) {
      // image-gen and similar: caller runs the body inline and calls finish
      // when done. No fiber spawned.
      return { fiberId: null };
    }

    await deps.readAppConfig();
    const payload: FiberPromptPayload = {
      promptId,
      content: intent.content,
      authorEmail: resolveAuthor(intent, policy),
      title,
      images: intent.images,
    };
    const fiberId = deps.fibers.spawnFiber("runFiberPrompt", payload, {
      maxRetries: policy.maxRetries,
    });
    deps.fibers.setPromptFiberId(promptId, fiberId);
    return { fiberId };
  }

  async function start(intent: StartIntent): Promise<StartOutcome> {
    if (!intent.content || !intent.content.trim()) {
      return { kind: "rejected", reason: "empty", message: "Empty prompt content" };
    }

    const policy = SOURCE_POLICIES[intent.source];
    const current = deps.control.read();
    const busy = !!current.activePromptId;

    if (busy) {
      switch (policy.onBusy) {
        case "queue": {
          const { promptId, position } = deps.prompts.enqueue(
            intent.content,
            intent.authorEmail ?? null,
          );
          return { kind: "queued", promptId, position };
        }
        case "skip":
          return { kind: "skipped", reason: "busy" };
        case "reject":
          return {
            kind: "rejected",
            reason: "busy",
            message: "Another prompt is already running",
          };
      }
    }

    const promptId = uuid();
    const title = deriveTitle(intent.content, intent, current);
    const { fiberId } = await spawnPrompt(promptId, intent, policy, title);
    return { kind: "started", promptId, fiberId, title };
  }

  async function finish(promptId: string, cause: FinishCause): Promise<void> {
    const current = deps.control.read();
    // Stale-fiber guard: if a different prompt is active (or none is),
    // this finish call is from a fiber that already lost.
    if (current.activePromptId !== promptId) {
      log("info", "lifecycle.finish: stale finish ignored", {
        promptId,
        activePromptId: current.activePromptId,
        cause: cause.kind,
      });
      return;
    }

    const title = current.title ?? promptId;
    const ownerEmail = current.ownerEmail ?? undefined;
    // Resolve the policy for the source of the *currently-active* prompt.
    // We don't store the source on the prompt row today; default to the
    // user policy which has the most permissive notification settings.
    // TODO: persist source on prompts table and look up real policy here.
    const policy = SOURCE_POLICIES.user;

    // 1. Write the prompt row
    if (cause.kind === "completed") {
      deps.prompts.update(promptId, {
        status: "completed",
        resultMessageId: cause.resultMessageId,
      });
    } else if (cause.kind === "failed") {
      deps.prompts.update(promptId, { status: "failed", error: cause.error });
    } else {
      deps.prompts.update(promptId, {
        status: "aborted",
        error: cause.reason ?? "Prompt aborted",
      });
    }

    // 2. Clear active prompt, set status=idle
    deps.control.endPrompt();
    deps.setAbortController(null);

    // 3. Sync session index — always (covers both completed and aborted paths)
    await deps.syncIndex({ status: "idle", title }).catch(() => {});

    // 4. Dispatch notification per policy + cause
    if (cause.kind === "completed" && policy.notifyOnComplete) {
      deps.notify({
        kind: "prompt-complete",
        title: `Dodo: ${title}`,
        body: (cause.text ?? "").slice(0, 200),
        tags: "white_check_mark,robot",
        ownerEmail,
      });
    } else if (cause.kind === "failed" && policy.notifyOnError) {
      deps.notify({
        kind: "prompt-error",
        title: `Dodo: ${title} (failed)`,
        body: cause.error,
        tags: "x,robot",
        priority: "high",
        ownerEmail,
      });
    } else if (cause.kind === "aborted") {
      deps.notify({
        kind: "prompt-aborted",
        title: `Dodo: ${title} (aborted)`,
        body: cause.reason ?? "Prompt was cancelled",
        tags: "stop_sign,robot",
        ownerEmail,
      });
    }

    // 5. Decide what happens next.
    //    Invariant: at most ONE of {dequeueNext, autoContinue} fires.
    //    Queued user prompts always win. Aborted prompts do not chain.
    if (cause.kind !== "aborted") {
      const dequeued = deps.prompts.dequeue();
      if (dequeued) {
        deps.prompts.emitQueueUpdate();
        const result = await start({
          source: "queue",
          content: dequeued.content,
          authorEmail: dequeued.authorEmail,
        });
        // start() is responsible for all subsequent events; nothing more to do.
        if (result.kind !== "started") {
          log("warn", "lifecycle.finish: dequeued prompt failed to start", {
            promptId: dequeued.promptId,
            outcome: result.kind,
          });
        }
        return;
      }

      // No queued prompt. Try auto-continue if a goal is active.
      if (cause.kind === "completed") {
        await maybeAutoContinue(title);
      }
    }
  }

  /**
   * Pure auto-continue dispatch. Idempotent — no-ops if a prompt became
   * active during this call (shouldn't happen under the DO input gate
   * but defensive coding doesn't hurt).
   */
  async function maybeAutoContinue(title: string): Promise<void> {
    const before = deps.goal.read();
    if (!shouldAutoContinue(before.status)) return;
    if (deps.control.readActivePromptId()) return; // belt and braces

    const after = deps.goal.incrementTurns();
    if (isTerminalStatus(after.status)) {
      // Just hit the budget. Notify the owner that the agent stopped.
      const ownerEmail = deps.control.readOwnerEmail();
      deps.notify({
        kind: "prompt-error",
        title: `Dodo: ${title} — goal exhausted`,
        body: `Used all ${after.maxTurns} auto-continue turns without reaching a terminal state.`,
        tags: "warning,robot",
        priority: "high",
        ownerEmail: ownerEmail ?? undefined,
      });
      return;
    }

    const content = buildContinuePrompt(after);
    const result = await start({
      source: "goal-autocontinue",
      content,
    });
    if (result.kind === "started") {
      log("info", "goal-autocontinue", {
        promptId: result.promptId,
        turnsUsed: after.turnsUsed,
        maxTurns: after.maxTurns,
      });
    }
  }

  async function abortActive(): Promise<AbortOutcome> {
    const promptId = deps.control.readActivePromptId();
    if (!promptId) return { kind: "noop" };

    // Signal the in-flight AbortController BEFORE marking the row
    // aborted so a late-arriving "completed" from runThinkChat can't
    // overwrite the abort.
    const controller = deps.getAbortController();
    if (controller) {
      controller.abort();
      deps.setAbortController(null);
    }

    const fiberId = deps.fibers.readPromptFiberId(promptId);
    if (fiberId) deps.fibers.cancelFiber(fiberId);

    await finish(promptId, { kind: "aborted", reason: "Prompt aborted" });
    return { kind: "aborted", promptId };
  }

  return {
    start,
    finish,
    abortActive,
    snapshot: () => deps.control.read(),
    readGoalState: () => deps.goal.read(),
  };
}
