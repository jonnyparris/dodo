# SessionLifecycle owns all prompt transitions

Before: six call sites in `coding-agent.ts` (WS user prompt, watchdog nudge, cron, HTTP handlePrompt, queue dequeue, goal auto-continue) each open-coded the "start a prompt fiber" ritual — write metadata triplet, insert prompt row, optionally sync session index, optionally emit state event, spawn fiber, record fiber id. Variations across the six were per-policy (`ifBusy`, `maxRetries`, source label) and quietly diverged. Finalization, abort, and goal auto-continue had a symmetric problem on the back-edge — `finalizePromptFromFiber → maybeAutoContinue → spawnFiber` re-entered the duplicated dispatch code through a different door.

Decided: introduce a **SessionLifecycle** module that owns every prompt transition for a **CodingAgent** — start, finish, abort, finalize, auto-continue. One front door (`startPrompt`) for every source; one back door (`finishPrompt`) that consults **GoalState** and chains via the same front door. Source identifies the caller; a policy table inside the lifecycle maps source to `ifBusy` / `maxRetries` / event-emission shape. The lifecycle holds three typed stores (**SessionControlPlane**, **WatchdogState**, **GoalState**) that replace the string-keyed `metadata` k/v table, and a **FiberDriver** port (injected, not inherited) that exposes `{ spawnFiber, cancelFiber, stashFiber, getFiber }` for testability.

Why: the prompt-lifecycle is the actual concept; today every shallow "policy" module (`watchdog-policy`, `compaction-policy`, `loop-detection`) returns a decision and hands it back to coding-agent.ts for execution, where the bugs live. The deletion test for the policy modules concentrates complexity in the wrong place. Centralising the lifecycle moves the bugs into a typed surface — `SessionLifecycle` becomes the **test surface**, the "policy" modules become pure inputs to its decisions.

Status: accepted.

## Interface shape

Two verbs plus one carve-out. Source policy lives as a typed data table, not a registry.

```ts
export type PromptSource =
  | "user" | "watchdog" | "cron" | "queue" | "goal-autocontinue" | "image-gen";

export interface SourcePolicy {
  onBusy: "queue" | "skip" | "reject";
  maxRetries: number;
  syncIndex: boolean;
  emitState: boolean;
  notifyOnError: boolean;
  synchronous?: boolean;          // image-gen
  emitOnFire?: string;             // watchdog
}

export const SOURCE_POLICIES: Record<PromptSource, SourcePolicy> = { /* ... */ };

export interface SessionLifecycle {
  start(intent: StartIntent): Promise<StartOutcome>;
  finish(promptId: string, cause: FinishCause): Promise<void>;
  /** Thin wrapper around start({ source: "image-gen", ... }) returning a typed sync result. */
  startImageGen(intent: ImageGenIntent): Promise<ImageGenResult>;
}
```

`StartOutcome` is a discriminated union: `started | queued | rejected`. `FinishCause` is `completed | failed | aborted`. `finish` is the single decision point for the dequeue-vs-auto-continue race — queued user prompt wins; otherwise consult GoalState; otherwise idle.

## Considered options

- **Caller picks `ifBusy` per dispatch.** Rejected — pushes policy back to callers; same six-copy problem with one more parameter.
- **Mixin / base class between Think and CodingAgent.** Rejected — overweight; CodingAgent is the only consumer.
- **Lifecycle holds a reference to its owning CodingAgent.** Rejected — couples to the ~200-method surface; hard to test.
- **Big-bang refactor on one branch.** Rejected — high blast radius; strangler-style with passthrough stores is safer.
- **Extension-rich interface (middleware, subscribers, open-set events, open-set stores).** Rejected — three call sites need each of those today: zero. The "future supervisor-autopilot" case is handled by adding one row to `SOURCE_POLICIES`. Don't pay for extensions without consumers.
- **Method-per-source with an `internal` namespace (`lifecycle.sendPrompt` + `lifecycle.internal.fromWatchdog` etc.).** Rejected — readability win on the common case is real, but every change to the orchestration has to be made in N methods. Locality wins over the readability gain.
- **Image-gen as a discriminated `start()` outcome variant.** Rejected — image-gen is synchronous-ish and forces every async caller to handle an impossible branch. Carved out as `startImageGen()` with a separate typed result. Internally still routes through `start({source:"image-gen"})`.

## Consequences

- The `metadata` k/v table no longer holds `status` / `active_prompt_id` / `title` / `owner_email` / `watchdog_*` / `goal_*` after migration — those live in typed stores with their own DDL.
- `session-goal.ts` stays as pure helpers (`shouldAutoContinue`, `buildContinuePrompt`, `renderGoalSystemPromptSection`); GoalState owns storage.
- `watchdog.ts` stays as the pure decision (`decideWatchdog`); `watchdog-policy.ts` becomes a thin adapter or is deleted; **SessionLifecycle** owns the action.
- The auto-continue back-edge collapses — `maybeAutoContinue` disappears; `finishPrompt` consults GoalState and chains directly.
- Tests at the **SessionLifecycle** interface replace tests in the deleted helpers and at the six former call sites.
