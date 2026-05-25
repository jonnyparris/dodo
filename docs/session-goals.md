# Session Goals

A goal-driven session keeps running until the model declares it's finished. Set a goal once; the session auto-prompts itself turn after turn until the model calls `set_goal_status` with `done`, `blocked`, or `needs_input`, or the turn budget runs out.

This is what makes "autopilot" not a special endpoint. The autopilot kickoff is just `POST /session` → `PUT /session/:id/goal` → `POST /session/:id/prompt` with `"Begin."` — three normal API calls. Any session can do the same.

## Why

Without goals, a Dodo session is reactive:

- Human sends a prompt.
- Model multi-steps inside the AI SDK loop, calls tools, emits a stop.
- Session goes idle until the next human message.

If the model says "I'll handle the typecheck next" or leaves the goal half-done, nothing nudges it. Goals invert that — the session is responsible for finishing what it started, and the human gets a notification only when the model explicitly says it's stuck or done.

## Lifecycle

```
none ──set─▶ active ──set_goal_status──▶ done | blocked | needs_input
                │
                └──turn budget hit──▶ exhausted
```

The `metadata` k/v table on the CodingAgent DO holds the goal state:

| Key | Meaning |
|---|---|
| `goal_text` | What the agent is trying to achieve (plain text, no cap enforced server-side) |
| `goal_status` | `none` \| `active` \| `done` \| `blocked` \| `needs_input` \| `exhausted` |
| `goal_set_at` | Unix epoch seconds when the goal was set |
| `goal_turns_used` | How many auto-continue turns have fired |
| `goal_max_turns` | Hard cap (default 50, max 200) |
| `goal_summary` | Last summary the agent wrote when it set status |
| `goal_role` | Optional tag (e.g. `autopilot-worker`) |

After every prompt turn, `finalizePromptFromFiber` runs `maybeAutoContinue`:

1. If `goal_status !== "active"`, stop.
2. If `active_prompt_id` is set (another prompt is in flight), stop. The queue and cron paths win.
3. If `prompt_queue` has rows (a user message is waiting), stop. The user's prompt wins.
4. Otherwise bump `goal_turns_used`. If we just hit the cap, mark `exhausted` and send an `ntfy` to the owner. Otherwise spawn a fresh fiber prompt with a short continue nudge.

Each turn is one assistant response (which itself can multi-step inside the AI SDK loop). The turn budget is *outer* turns — not tool calls.

## Tools the model sees

When `goal_status === "active"`, the system prompt grows a `## Your goal` section:

```
## Your goal

Status: active
Turn 7 of 50.

Investigate one issue in the Dodo codebase and submit a draft PR with a fix.

**Target area:** session creation flow
...

After each turn you'll be auto-prompted to continue until you declare a terminal status.
Call `set_goal_status` with one of:
- `done` when the goal is achieved (include a one-line summary of what you did).
- `blocked` when you genuinely can't proceed (explain the blocker).
- `needs_input` when you need a human decision (explain what's needed).
```

The `set_goal_status` tool is only available when a goal is active. It takes `{ status, summary }` and refuses to fire on a session without an active goal.

## API

```
GET    /session/:id/goal           — read state
PUT    /session/:id/goal           — { text, maxTurns?, role? } — set or replace
DELETE /session/:id/goal           — clear
```

The agent SSE stream emits a `goal_state` event whenever state changes (set, status update, turn increment), so any UI can render the current status without polling.

## Examples

Eight goal-driven session shapes that work today:

### 1. Autopilot self-diagnose

The original use case. `POST /api/admin/autopilot/kickoff` sets:

> Investigate one issue in the Dodo codebase and submit a draft PR with a fix.
> **Target area:** ${user-supplied}
> ...

The session reads logs, picks an issue, edits files, pushes a branch, opens a draft PR, calls `set_goal_status: done`. Or `blocked` if nothing actionable. Or `needs_input` if it hits ambiguity.

### 2. Long refactor

> Rename `getCwd` to `getCurrentWorkingDirectory` everywhere in this repo. Run typecheck and the affected tests; commit when green.

15 files, several batches of edits, one typecheck pass, one commit. The model decides when it's done by checking `git status` and the typecheck output. No human nudge needed mid-flight.

### 3. PRD → implementation

> Implement the feature described in this PRD: <paste>.
> Open a draft PR when the happy path is done. Use `needs_input` if the PRD is ambiguous.

This is the case where `needs_input` shines. The model can pause cleanly and the human gets a notification with the question.

### 4. Incident triage

> Investigate why session-prompt latency spiked between 14:00 and 15:00 UTC today. Use `fetch_worker_logs` to pull the relevant window. Write a 5-line finding and call `set_goal_status: done` with the root cause.

Short goal, long investigation. The session may run for 10+ turns through log queries and code reads before producing the summary.

### 5. Scheduled hygiene (combined with cron)

Install a scheduled session that fires every Monday at 09:00 UTC with a goal text like:

> Sweep the JIRA backlog and surface any tickets stuck in "In Progress" for more than 14 days. Post the list to the team's GChat space.

Each cron fire is a fresh goal-driven session. The cron handles recurrence; the goal handles within-fire completion.

### 6. Migration runner

> Apply this database migration to every `*.db` file under `data/`. For each file:
> 1. Back it up.
> 2. Run the migration.
> 3. Run the post-migrate verify query.
> 4. Log pass/fail.
> When done, summarise the results and call `set_goal_status: done`.

Mechanical, batch-y, previously needed babysitting. Now it just runs.

### 7. Doc generation

> Write a `CONTEXT.md` for every package in this monorepo that doesn't already have one. Use the template at `docs/templates/context.md`. Commit each one as a separate commit.

The model iterates packages, reads code, writes docs, commits, moves on. `set_goal_status: done` when no packages are left.

### 8. PR review

> Review PR #123. Read the diff, leave inline comments on the diff, summarise verdict. Call `set_goal_status: done` when comments are posted.

Long, multi-file investigation followed by a discrete delivery. Auto-continue keeps the session running across all the file reads.

## When NOT to set a goal

Goals are wrong for:

- **Open-ended chat.** "Help me think through this design" doesn't have a terminal state. The model would either spin forever or false-`done` itself.
- **Single-step tasks.** "What does this function do?" finishes in one turn. The goal infrastructure adds no value.
- **Tasks that need approval mid-flight.** If you want to review the model's plan before it edits files, don't set a goal — review the first response, then either prompt "go ahead" or adjust. (Goal sessions can also pause via `set_goal_status: needs_input`, but that's a heavier mechanism than a regular chat turn.)

## Safety rails

- **Turn budget is mandatory.** Default 50, hard cap 200. There is no "unlimited."
- **User messages win.** If a human posts a prompt while a goal is active, the queue path takes over and auto-continue defers. The model sees the user message normally; the goal stays active and resumes once the user-driven turn finishes.
- **Notifications on terminal states.** `exhausted` fires a high-priority ntfy. `needs_input` fires a normal-priority ntfy. `done` and `blocked` use the standard prompt-complete path.
- **No racing.** `maybeAutoContinue` checks `active_prompt_id` and `prompt_queue` before spawning. Two prompts can't run at once on the same session DO.

## Composition with other features

- **Scheduled sessions.** A cron creates a fresh session each fire. Set a goal on the spawned session for within-fire auto-continuation, or leave it as a one-shot prompt. The autopilot supervisor uses one-shot; autopilot workers use goals.
- **Watchdog.** The watchdog observes session timing and can nudge or kill stuck sessions. It's orthogonal to goals — a goal-driven session can still get watchdogged if it loops too long.
- **MCP/skill picker.** The picker still applies on session creation. A goal-driven session inherits whatever skills and MCPs were selected.

## Implementation notes

The goal-related code lives in three places:

- `src/session-goal.ts` — pure helpers and types (no DO dependencies). Unit-tested in `test/session-goal-unit.test.ts`.
- `src/coding-agent.ts` — DO-side state (`readGoalState`, `setGoal`, `updateGoalStatus`, `clearGoal`, `incrementGoalTurns`, `declareGoalTerminal`), HTTP routes (`GET/PUT/DELETE /goal`), and the `maybeAutoContinue` hook called from `finalizePromptFromFiber`.
- `src/agentic.ts` — the `set_goal_status` tool definition. Wired via `parentAgent.readGoalState` + `parentAgent.declareGoalTerminal`.

No new SQL tables. Goal state piggybacks on the existing `metadata` k/v table so no migration is needed.
