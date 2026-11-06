# ADR 0002 — pi-durable as the agent-loop foundation

Status: accepted, phase 1 shipped (opt-in per session). Date: 2026-10-16.

## Decision

Dodo's agent loop moves from a hand-rolled loop on `@cloudflare/think` to
[`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable)
(the `Harness`). Dodo keeps what is product-specific (tools, system prompt,
prompt lifecycle, goals, watchdog, attachments, SSE protocol) and deletes what
pi-durable already does. Fixes we need in pi go upstream, not into local forks.

Plain explainer with diagrams: [`docs/pi-durable-explainer.html`](../pi-durable-explainer.html).

## Why

Think persists a turn only after the whole multi-step loop finishes. Everything
inside a turn (every model step, every tool result) lives in isolate memory.
Dodo grew ~1,900 lines of policy to cope: own-loop, in-memory tool-result
pruning, overflow retry, mid-loop compaction, final-summary turns, fiber
checkpoints. An eviction still replays the whole turn, including side effects.

pi-durable commits each model response and each tool call before it is shown.
Tool calls are durable tasks with a replay policy. Compaction, retries, abort
cascade, idempotent submissions and prompt-cache-friendly system prompt diffs
are built in, tested upstream, and maintained by someone else.

Verified before building (`test/pi-durable-spike.test.ts`): pi-durable runs in
workerd on Durable Object SQLite, and a run interrupted mid-tool resumes after
close/reopen. TypeBox falls back to interpreted validation where `eval` is
blocked, so tool validation works in production Workers.

## What changed (phase 1)

| Area | Before | After (pi sessions) |
|---|---|---|
| Loop | `onChatMessage` own-loop around `streamText({maxSteps:1})` | `Harness` generation + tool tasks |
| Durability unit | whole turn (fiber `stashFiber` after chat) | each model step and each tool call |
| Eviction mid-turn | replay turn from the top, repeat side effects | reattach by prompt id; read-only tools rerun, others return `interrupted` |
| Compaction | `maybeCompactContext`, `compaction-policy`, `overflow-retry`, `own-loop-prune` | pi background/blocking compaction + overflow retry |
| Provider | AI SDK `createOpenAICompatible` + `addAnthropicCacheMarkers` + manual affinity header | pi-ai `openai-completions` with `compat.cacheControlFormat` / `sessionAffinityFormat`; Anthropic on AI Gateway goes through the Agents SDK `createAI` over the `AI` binding (native Messages wire, no gateway key; `src/cloudflare-ai.ts`), because `/compat` strips `cache_control` |
| Storage | Think tables | `pi_*` tables in the same DO SQLite |
| Tools | AI SDK `tool()` | unchanged; adapted by `src/pi/tools.ts` |

Files: `src/pi/{engine,models,tools}.ts`, `CodingAgent.runPiChat`,
`GET/PUT /session/:id/engine` (`?detail=1` = live tasks + compact transcript).

## Keep / import / delete

**Keep (Dodo product):** tools (`agentic.ts`, `tools/*`, MCP, browser,
codemode), system prompt, `SessionLifecycle` + prompt queue, goals, watchdog,
attachments pipeline, SSE/WS protocol, UserControl/SharedIndex.

**Keep as a pi hook (sprinkle):** doom-loop / same-tool detection
(`loop-policy.ts`, `loop-detection.ts`) — pi has no equivalent; port to a
`GenerationTask.afterTools` / `onYield` hook.

**Delete once pi is the default:** own-loop in `onChatMessage` (~700 lines),
`maybeCompactContext` (~330), `runThinkChat` (~240), `own-loop-prune.ts`,
`overflow-retry.ts`, `compaction-policy.ts`, `final-summary-policy.ts`,
`addAnthropicCacheMarkers`, fiber checkpoint logic in `runFiberPrompt`,
`think-adapter.ts`, `@cloudflare/think`.

**Candidates to import later:** `pi-durable/tools` (read/write/edit/bash over
an `ExecutionEnv`), `pi-durable/codemode` (durable, replayable scripts) in
place of `@cloudflare/codemode`, the subagent pattern (examples 22/23) in place
of `subagent-runner.ts` + facet DOs, `tool-search` for large MCP tool sets,
`outputLimits` in place of `TOOL_OUTPUT_CAPS`.

## Parity gaps before flipping the default

1. Fork / snapshot export+import read Think history → use `root.fork()` and
   pi entries for pi sessions.
2. Session details `contextUsagePercent` / `compactionCount` read Think →
   read `pi.usage` / `pi.live`.
3. Compaction/history admin endpoints read Think.
4. Doom-loop hook (above).
5. Live eviction proof in production: a redeploy mid-turn did not evict the
   running DO (the old version finished the turn), so recovery is proven in
   workerd tests only so far.

Then: set `DODO_AGENT_ENGINE=pi`, soak, delete the Think path.

## Phase 2 (shipped): pi is the only loop

Gaps 1–4 closed. Every prompt runs on pi; `DODO_AGENT_ENGINE` is gone and
`PUT /engine` only accepts `pi`.

- **Think-era sessions migrate on their next prompt** (or import / `/generate`):
  `migrateThinkSessionToPi` copies visible user/assistant text into the pi
  transcript under the same message ids, so metadata and attachment rows still
  line up. Think tool-call parts don't carry over (like a compaction). Reads of
  an unmigrated session (`/messages`, export, fork) still come from Think.
- **Doom-loop guard:** `src/pi/loop-guard.ts`. `GenerationTask.beforeRequest`
  adds the nudge; `ToolTask.beforeTool` refuses the looping tool at the hard bar.
  Thresholds unchanged (identical 3/5, same tool 6/10, narrated 20).
- **Deleted (~2,700 lines):** own-loop `onChatMessage`, `assembleContext`,
  `maybeCompactContext`, `runThinkChat`, `getMaxSteps`; `loop-policy.ts`,
  `compaction-policy.ts`, `overflow-retry.ts`, `own-loop-prune.ts`,
  `final-summary-policy.ts` and their tests.
- **No Think base class.** `CodingAgent extends DodoAgentBase`
  (`src/agent-base.ts`): `withFibers(Agent)` plus config in the same
  `_think_config` row (no data migration) and a read-only `ThinkHistory`
  (`src/think-history.ts`) over Think's tables for unmigrated history.
- **`@cloudflare/think` removed.** File tools (`src/tools/workspace-tools.ts`)
  and codemode `execute` (`src/tools/execute-tool.ts`) are ported with the same
  names, descriptions and schemas. One behaviour fix: `edit` no longer expands
  `$&` / `$1` in `new_string`.
- **Gap 5 closed (2026-10-17):** `POST /session/:id/debug/evict` (admin) resets
  the DO mid-turn; the prompt resumes from the alarm heartbeat with no client
  request, each side effect once. That needed a fix: `CodingAgent.alarm()` was a
  no-op override that never called `Agent.alarm()`, so cron, watchdog and fiber
  recovery had never run from alarms.
- Production validation, all on real data: Think→pi of all 19 Think-era
  sessions (fork diff identical, incl. compaction summaries and screenshots),
  forced compaction (`/debug/compact`), loop guard, abort, explore subagent, MCP,
  vision input, UI streaming.

## Kitebuild and containers

Containers are cheaper now, so "DO-only" is no longer a hard rule. For coding
tasks Dodo starts, [Kitebuild](https://gitlab.cfdata.org/scardita/kitebuild)
(BusyBox on Workers: npm, vite, vitest, tsc, oxlint, wrangler, no VM) runs real
toolchains without a container. Shipped: `ci_run` tool (`src/tools/kitebuild.ts`)
— clone a pushed branch, run commands, return per-stage pass/fail + output tail.
Dormant until `KITEBUILD_URL` + an Access service token
(`KITEBUILD_CLIENT_ID/SECRET`) for the `kickstart-playground` Access org exist.

Next: a pi-durable `ExecutionEnv` backed by a long-lived Kitebuild session (or
a container) so `bash`/`read`/`write` run against a real toolchain, chosen per
conversation (example 29, sandbox per conversation). Kitebuild's own plan to
mount a `@cloudflare/computer` workspace into its `Machine`
(`docs/computer-machine-integration-plan.md`) would let that env share Dodo's
existing workspace instead of cloning.

## Upstream

- pi-ai: header-only credentials (`cf-aig-authorization`) made the OpenAI SDK
  send `Authorization: Bearer unused`, which AI Gateway rejects with 401. Fix +
  test on `~/dev/pi` branch `fix/ai-no-placeholder-bearer`. pi's contribution
  gate requires an issue in the reporter's own words and a maintainer `lgtm`
  before a PR — not filed by an agent.
- `HarnessOptions.models` as a function shipped in pi-durable 1.4.0. Dodo
  passes one (`PiEngineHost.models()`); CodingAgent rebuilds its `Models` only
  when the gateway config changes, and pi reads it at every model request, so
  URL/credential changes apply without reopening. Model and gateway stay
  fixed while a prompt runs (`readAppConfig` keepRunning,
  `ensureThinkConfig`), so the running turn's model ref stays registered; a
  change applies from the next prompt. The previous model stays registered
  too, for a background compaction that outlasts its prompt.

## Pi 1.5 / agents 0.33 (2026-11)

Dodo went from pi 1.3 / agents 0.28 straight to pi 1.5 / agents 0.33 (PR
#153, first written for pi 1.4 / agents 0.30 and retargeted before it
merged), so prod takes one storage migration instead of two.

- **No rollback.** pi 1.4+ migrates the `pi_` SQLite tables to schema v2 on
  first open, and pi 1.5 writes `pi.live` at version 3. Neither 1.3 nor 1.4
  can read a session 1.5 opened. Roll forward to fix a bad deploy.
- **The bridge renders state** (`src/pi/live-bridge.ts`). pi 1.5 removed
  `watchEvents()`. `PiEngine.run()` attaches `Conversation.watch()` before it
  submits (or resumes a recovered run), and `LiveBridge` turns each view into
  Dodo's SSE events. Watch calls fold the commits made while the listener
  runs, and the view's entries are a window, so the bridge renders state, it
  doesn't replay events: new transcript entries (ordered, re-readable) drive
  each step's text, `tool_call` (from the answer's `toolCall` blocks, args
  as the model sent them), `tool_result`, steps and usage; `pi.live` drives
  only the streaming partial, the turn stall guard's snapshot and logs. After
  the settle, `finish()` reads entries no delivered view showed.
- **Turn stall guard** takes a full snapshot per watch call
  (`PiTurnProgress`: open tool calls, pending ones included, and compaction).
- **Restart limit ends work** (no more parking, `retryTask()` is gone). A tool
  call cut off 5 times in a row (`PI_RESTART_LIMIT`) ends with an error result
  the model sees; a model request ends its run `unanswered` with
  `restart_limit`, and a request in flight when the host died counts as a
  failed attempt (`interrupted` once retries run out). Both become a plain
  "send the prompt again" error (`piUnansweredMessage`). `onReport` gets one
  tagged report (`kind`); `task_interrupted` is logged as an error.
- **Deferred progress.** Streamed text and tool output reach watches at once
  and storage in batches (`settings.progress.persistWithinMs`, 1 s). A crash
  loses up to ~1 s of streamed text. `partialIntervalMs` (250 ms) now sets
  the chat's update rate, not the write volume.
- **agents 0.31 browser tool.** `browser_execute`'s code runs in its own
  Dynamic Worker and calls a `browser` global (`browser.cdp(...)`,
  `browser.attachToTarget(...)`); `notice` replaces `restarted`/`newTabs`.
  The tool declares a structured output schema, which Dodo's wrapper passes
  through. The system prompt and the `browser-cdp-perf` skill teach the new API.
- **agents 0.31 MCP peers.** `@modelcontextprotocol/sdk` and
  `@modelcontextprotocol/server` are optional peers now; Dodo lists both
  (`agents/mcp`'s `createMcpHandler` imports the server package).
- **createAI (agents ≥0.29).** No more universal endpoint. Main-session
  Anthropic models resolve by AI Gateway's catalog spelling
  (`anthropic/claude-sonnet-4.6`, `createAISpecifier()`) and run on
  `env.AI.run`; Dodo keeps its own id (`anthropic/claude-sonnet-4-6`) on the
  model so persisted `cloudflare/…` refs still resolve. Subagents' `routed`
  Anthropic models go to the provider-native path over `env.AI.fetch`, which
  `adaptBindingForCreateAI` now wraps (AbortSignal kept local).
