# Dodo

Autonomous coding agent on Cloudflare Workers. Multi-tenant; per-user state in Durable Objects; per-session state in a Think-based coding agent.

## Language

### Runtime topology

**Worker**:
The outermost entry point. A Hono router with Cloudflare Access auth that forwards into the Durable Objects.
_Avoid_: server, app, backend.

**SharedIndex DO**:
The single global Durable Object holding cross-user state: user allowlist, host allowlist, models cache, session shares, session permissions, MCP token pointer index.
_Avoid_: global state, index DO.

**UserControl DO**:
The per-user Durable Object (`idFromName(email)`) holding that user's config, sessions list, memory entries, tasks, key envelope, encrypted secrets, fork snapshots, skills, MCP configs, scheduled sessions, OAuth state.
_Avoid_: user DO, account DO.

**CodingAgent DO**:
The per-session Durable Object extending `Think<Env, DodoConfig>`. Owns one **Think session**, the **workspace**, the **fiber** lifecycle for the session, and all per-session state.
_Avoid_: session DO, agent.

**AllowlistOutbound**:
A `WorkerEntrypoint` self-referencing service binding that gates outbound fetches from sandboxed code via host allowlist.
_Avoid_: outbound proxy, fetch gateway.

**DynamicWorkerExecutor**:
The sandbox executor used by codemode. Wires `globalOutbound` to **AllowlistOutbound**; receives workspace + git providers from the parent **CodingAgent**.
_Avoid_: sandbox, executor.

### Session model

**Think session**:
The chat session owned by `@cloudflare/think` inside a **CodingAgent**. One per CodingAgent — single-session invariant.
_Avoid_: chat session, conversation.

**Fiber**:
An async, evictable execution context the **CodingAgent** spawns via `spawnFiber()`. Long-running prompts run as fibers so they survive DO eviction; checkpoints via `stashFiber()`.
_Avoid_: task, background job, worker.

**Workspace**:
The file tree backing a **CodingAgent** — `@cloudflare/shell` over SQLite with optional R2 spill. Tools read/write through it.
_Avoid_: filesystem, project dir.

**Codemode**:
The sandboxed JS execution tool the **CodingAgent** exposes to the model, built on `@cloudflare/codemode` and `DynamicWorkerExecutor`. Also the name of a second MCP server (`/mcp/codemode`) that uses the same orchestration pattern — search + execute. The two are distinct mechanisms that share a naming convention.
_Avoid_: sandbox, exec.

**Subagent**:
A read-only or scratch-workspace child agent (Explore or Task) the **CodingAgent** spawns to explore code or run an isolated subtask. Defined by an **AgentProfile**.
_Avoid_: helper, worker agent.

**AgentProfile**:
A typed record (`EXPLORE_PROFILE`, `TASK_PROFILE`) holding a subagent's system prompt, step budget, model resolver, timeouts, and default result schema.
_Avoid_: agent config.

### Prompt lifecycle

**Prompt**:
A unit of work the **CodingAgent** runs in a **fiber**. Has an id, content, status (`queued | running | completed | failed | aborted`), a source (user / watchdog / cron / goal-autocontinue / queue), and a fiber id. Stored in the `prompts` table.
_Avoid_: turn, message, request.

**SessionLifecycle**:
The module that owns prompt transitions for a **CodingAgent**: start, finish, abort, finalize, auto-continue. The single front door for "start a prompt." Receives a **FiberDriver** port and the **SessionControlPlane** / **WatchdogState** / **GoalState** stores.
_Avoid_: prompt dispatcher, prompt manager.

**SessionControlPlane**:
The typed store of live session-status fields: `status`, `activePromptId`, `title`, `ownerEmail`, `createdAt`, `updatedAt`. Replaces the string-keyed slice of the `metadata` table that today is read from 100+ sites. Only **SessionLifecycle** writes `status` and `activePromptId`.
_Avoid_: session store, session state.

**WatchdogState**:
The typed store of watchdog-related fields (`watchdog_enabled`, `watchdog_threshold_seconds`, `watchdog_nudge_prompt`, `watchdog_last_fired_at`, `watchdog_fire_count`, `watchdog_action`). Today these are 6 separate keys in the `metadata` table.
_Avoid_: watchdog config.

**GoalState**:
The typed store of session-goal fields (`goalText`, `goalStatus`, `goalSummary`, `goalTurnsUsed`, `goalMaxTurns`). Today these are 7 separate keys in `metadata` and have two writers for `goal_status`. **SessionLifecycle** is the only writer post-refactor.
_Avoid_: goal config.

**FiberDriver**:
The narrow port through which **SessionLifecycle** drives **fibers** — `{ spawnFiber, cancelFiber, stashFiber, getFiber }`. Production adapter binds CodingAgent's inherited Think methods; test adapter is in-memory.
_Avoid_: fiber API, fiber adapter.

**Auto-continue**:
The mechanism by which a **prompt** with status `completed` chains to a follow-up prompt when **GoalState** is active and the turn budget is not exhausted. Owned by **SessionLifecycle**; uses pure helpers from `session-goal.ts` (`shouldAutoContinue`, `buildContinuePrompt`).
_Avoid_: self-continuation, autoturn.

**Prompt source**:
The label identifying who originated a **prompt**: `user`, `watchdog`, `cron`, `goal-autocontinue`, `queue`. Source determines policy (concurrent-prompt behaviour, retry count, event-emission shape) via a table inside **SessionLifecycle**.
_Avoid_: prompt origin, prompt kind.

## Relationships

- A **Worker** routes into **SharedIndex DO**, **UserControl DO**, and **CodingAgent DO**.
- A **UserControl DO** owns 0..N sessions; each session is a **CodingAgent DO**.
- A **CodingAgent** owns exactly one **Think session**, one **Workspace**, one **SessionLifecycle**, and one fiber per active **prompt**.
- A **SessionLifecycle** holds references to **SessionControlPlane**, **WatchdogState**, **GoalState**, and a **FiberDriver**.
- **Watchdog**, **cron**, user input, the queue, and **auto-continue** all start prompts via **SessionLifecycle**. No other path exists.
- **AllowlistOutbound** gates every outbound fetch from a **DynamicWorkerExecutor** sandbox.
- A **Subagent** is invoked by an **AgentProfile** through `runSubagentForProfile`; it shares **Think** infrastructure but runs in its own facet DO.

## Flagged ambiguities

- "metadata" historically referred to the k/v table inside CodingAgent's storage holding 20+ unrelated fields. Post-refactor, that grab-bag is broken into typed stores (**SessionControlPlane**, **WatchdogState**, **GoalState**); use the specific store name.
- "codemode" refers to two distinct things: (1) the sandboxed-JS tool inside a **CodingAgent**, and (2) the `/mcp/codemode` MCP server endpoint. They share a naming convention but are unrelated mechanisms.
- "policy" was historically a suffix on shallow extracted modules (`watchdog-policy.ts`, `compaction-policy.ts`, etc.). The decision is in the policy module; the action is back in `coding-agent.ts`. Prefer naming the deeper concept (e.g. **SessionLifecycle** owns the watchdog action; `watchdog.ts` holds the decision).
