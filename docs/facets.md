# Facets — subagents as addressable Durable Objects

Dodo can run two of its subagents (`explore` and `task`) either inline in the
parent turn ("in-process" mode) or as separate, independently-addressable
Durable Objects called **facets**. This doc covers what facets unlock, how to
switch them on, the HTTP surface, and the gotchas.

## Why

The parent `CodingAgent` runs one agentic loop with a finite step budget and a
single request lifetime. Every subagent call inside that loop eats steps and
wall-clock time from the parent. Two real pain points fall out of this:

1. **Parallel exploration is serial in practice.** The model can *describe*
   three parallel searches, but when each one runs as a blocking
   `generateText` call inside the parent turn, they execute one after another.
2. **Long-running side tasks stall the parent.** A task that takes 4-5 minutes
   of tool-calling blocks every other turn-level guardrail (token budget,
   doom-loop detection) until it returns.

Facets split each subagent into its own DO. The parent dispatches work to the
facet and proceeds — the facet has its own request lifetime (up to 10 minutes
for tasks), its own step budget, and can run concurrently with siblings.

## Measured impact

Prod A/B, 2026-04-24, same prompt, same model (`anthropic/claude-haiku-4-5`
for subagents), same repo cloned into the session:

| Mode | Prompt duration | Explore calls | Notes |
|---|---|---|---|
| `inprocess` | 272s (4m32s) | 3 sequential | Each call blocks the parent turn |
| `facet` | 163s (2m43s) | 9 across 3 parallel rounds | ~40% faster, chained fan-outs |

The facet run fired `pool-explore-0`, `pool-explore-1`, and `pool-explore-2`
within the same second and returned within a ten-second window. The
in-process run took steps in strict sequence.

## Configuration

Per-user config fields:

| Field | Values | Default |
|---|---|---|
| `exploreMode` | `inprocess`, `facet` | `inprocess` |
| `taskMode` | `inprocess`, `facet` | `inprocess` |

Set via `PUT /api/config`:

```bash
curl -X PUT https://your-dodo.workers.dev/api/config \
  -H "content-type: application/json" \
  -d '{"exploreMode":"facet","taskMode":"facet"}'
```

Or from the UI config panel. The setting applies to every subsequent prompt
in every session owned by the user — facets don't enrol retroactively.

Invalid values are rejected at the write layer (`z.enum([...])`). The read
path (`toAgentMode`) tolerates poisoned legacy rows and defaults unknowns to
`inprocess` — safe fallback to pre-facet behaviour.

## Architecture

```
CodingAgent (parent DO)          Subagent facets (peer DOs, on-demand)
┌─────────────────────────┐      ┌─────────────────────────┐
│ main chat loop          │      │ ExploreAgent            │
│ ─ step 1: tool call     │ ───▶ │  pool-explore-0          │
│ ─ step 2: tool call     │ ───▶ │  pool-explore-1          │
│ ─ step 3: wait...       │ ───▶ │  pool-explore-2          │
│ ─ merge results         │      └─────────────────────────┘
│ ─ step 4: next thing    │      ┌─────────────────────────┐
└─────────────────────────┘      │ TaskAgent               │
         │                       │  pool-task-0             │
         │ facet_runs SQL ──────▶│  (+ scratch R2 prefix)  │
         │                       └─────────────────────────┘
         │
         └─ /session/:id/facets HTTP reads this table
```

Each facet DO is created on-demand via the Agents SDK `subAgent(Class, name)`
API. Names are stable within a session (the parent uses `pool-explore-N` /
`pool-task-N` pool naming), so a facet instance is reusable across multiple
calls until the 24h cleanup alarm fires on task facets.

The parent persists a row in the `facet_runs` SQL table (in the parent DO's
own sqlite) for every dispatch — type, name, input, workspace mode, tokens,
status, timestamps. This table backs the HTTP surface below.

## HTTP surface

All routes under `/session/:id/` sit behind the session-permission middleware
(owner, admin, or explicit grant via SharedIndex).

### `GET /session/:id/facets`

List facet runs on this session, newest first. Returns the rows in
`facet_runs` with ISO timestamps. Example:

```json
{
  "runs": [
    {
      "id": 8,
      "facetType": "explore",
      "facetName": "pool-explore-2",
      "input": "How does authentication middleware work? ...",
      "summaryPreview": "## Explore results ...",
      "workspaceMode": null,
      "tokenInput": 151741,
      "tokenOutput": 3975,
      "startedAt": "2026-04-24T14:37:22.000Z",
      "finishedAt": "2026-04-24T14:38:07.000Z",
      "status": "completed"
    }
  ]
}
```

### `GET /session/:id/facets/:facetName/transcript`

Full message log for a facet run. Returns 404 if the name has no row in
`facet_runs` — protects against spawning empty facet DOs via unknown names.

### `POST /session/:id/facets/:facetName/apply`

Merge a subset of a scratch-mode `task` facet's writes back into the parent
workspace.

**Body:** `{ "paths": ["/some/file.txt", "/other.txt"] }`

**Constraints:**

- `paths` must be a non-empty array of strings, max 500 entries per call.
- The facet name must exist in `facet_runs` (otherwise 404).
- Each path must have actually been written during a scratch run on this
  facet (otherwise it lands in `skipped` with a reason).

**Response:**

```json
{
  "ok": true,
  "applied": ["/experiments/a.txt"],
  "skipped": [
    { "path": "/never-written.txt", "reason": "not among the files the facet wrote during scratch runs" }
  ]
}
```

Idempotent — re-applying the same paths overwrites the parent workspace file
with the latest scratch content.

## Scratch workspace mode (task only)

When a `task` facet runs with `workspaceMode: "scratch"`, writes go to
`workspace/<parentSessionId>/scratch/<facetName>/` in R2 instead of the
parent workspace. The facet's tool set (`write`, `edit`, `mkdir`) all target
this scratch prefix; reads fall through to the parent for anything not yet
written in scratch.

The scratch write index is backed by a `scratch_writes` SQLite table inside
the facet DO — survives eviction, unlike the original in-memory `Set<string>`
implementation. Merge-back reads from this table to decide what's eligible.

### Lifecycle

```
task() invoked with workspaceMode="scratch"
  → scratch R2 prefix created if absent
  → parentSessionId persisted to DO KV storage (durable across eviction)
  → writes go to scratch
  → task returns, scratch persists

Parent merges some paths:
  POST /facets/:name/apply { paths: [...] }
  → copies files from scratch → parent workspace

Parent discards (does nothing):
  → scheduled cleanup alarm fires 24h after the task completed
  → R2 prefix wiped, scratch_writes SQL index cleared
  → facet DO storage removed by parent via deleteSubAgent
```

### Why parentSessionId is persisted

Tests previously caught a real bug: after a DO eviction, the facet's in-memory
`parentSessionId` was lost. A later `applyFromScratch` request then returned
"scratch workspace not found" for every path. The fix persists the id
eagerly via `ctx.storage.put("parentSessionId", ...)` **awaited** before the
first tool can fire, and caches the latest value in-process to avoid redundant
writes.

### Cleanup alarm

Scheduled callback `cleanupScratchFacet` runs 24h after the last scratch task
completed on a facet. Two actions:

1. List and delete every object under the scratch R2 prefix (re-listing per
   iteration, not cursor-advancing, so deletes can't desync the listing).
2. `DELETE FROM scratch_writes` in the facet's SQLite.

If the Worker is down when the alarm fires, Durable Object alarms retry until
success — so cleanup is "eventually consistent" by design.

## Safety and guards

The HTTP surface has two guards worth knowing about:

- **404 on unknown facet names.** `POST /session/:id/facets/:name/apply` and
  `GET /session/:id/facets/:name/transcript` both check `facet_runs` before
  touching `subAgent(Class, name)`. Without this gate, a caller with `write`
  permission could spawn unbounded empty facet DOs by looping random names
  through the apply route (real billable DO storage, real log noise).
- **Path count cap.** Apply requests are limited to 500 paths per call.

Both guards are tested (`test/facet-transcript-unit.test.ts`) and enforced in
prod.

## Step budgets and timeouts

| Constant | Value | Notes |
|---|---|---|
| `EXPLORE_MAX_STEPS` | 16 | Same in both modes. Raised from 12 after prod A/B showed 12 exhausted the budget before the summary. Prompt tells the model to reserve the last 2 steps for a summary. |
| `EXPLORE_TIMEOUT_MS` | 60_000 | Only applies in-process; facet runs have their own DO lifetime. |
| `TASK_MAX_STEPS` | 20 | Same in both modes. Raised from 15 alongside EXPLORE_MAX_STEPS. |
| `TASK_TIMEOUT_MS` | 180_000 | In-process timeout. |
| `TASK_FACET_TIMEOUT_MS` | 600_000 | Facet-mode task gets 10 minutes — escapes the parent's turn budget. |
| `SUBAGENT_MSG_WINDOW` | 4 | Number of trailing assistant+tool message groups kept between steps (see "Message pruning" below). |

## Token efficiency

Subagents have **two layers of context control** to stop tool-result volume from dominating cost:

### Per-tool output caps

`capToolOutputs` in `agentic.ts` wraps every tool's `execute` function and truncates results before they enter the message history:

| Tool | Cap |
|---|---|
| `grep`, `find`, `list` | 100 entries |
| `read` | 200 lines |
| `codemode` | 32 KB |

If the model wants more, it passes offset/limit or narrows the query. This is the "OpenCode pattern" — cap at the tool, not in post-processing.

### Message-history pruning between steps

Tool caps bound any single tool result, but a 16-step explore still accumulates all 16 prior results in the `messages` array for step 17. Observed in prod: a single facet run racked up ~300k input tokens across its step budget, entirely from stale tool-result history being re-fed on every step.

`subagentPrepareStep` (wired into every `generateText` call site — in-process and facet) is a `prepareStep` callback that keeps:

- The original user query (goal anchor)
- The most recent `SUBAGENT_MSG_WINDOW` assistant+tool_result groups

…and replaces the dropped middle with a single marker message so the model knows history was compacted, not corrupted. This gives the model roughly two working tool-call cycles of memory plus the current turn — enough to chain reasoning, not enough to let history balloon.

Tests in `test/subagent-prune-unit.test.ts` lock in the contract.

## When to flip the switch

Turn `exploreMode: facet` on when:

- You routinely dispatch three or more investigations per turn.
- You're hitting the parent step budget because explores eat it up.
- You want each explore to run against its own cheap model independently.

Turn `taskMode: facet` on when:

- You need the task to write multiple files across several tool calls without
  blocking the parent for 3+ minutes.
- You want **scratch mode** specifically — e.g. "try a risky refactor, show
  me the diff, I'll decide what to merge."

Stay on `inprocess` when:

- The overhead of spinning up a peer DO isn't worth it for a one-shot search.
- Your step budget is fine and you prefer everything in one transcript.
- You're debugging and want the transcript inline.

Both modes share the same test coverage, tools, and models — the only
difference is where the `generateText` call executes. Flipping the switch is
safe; there's no data migration required.

## Testing locally

The unit tests under `test/facet-*.test.ts` cover the full surface: scaffold,
explore (single + parallel), task (scratch + shared), HTTP transcript and
apply routes, scratch-writes DO-eviction durability, cleanup alarm, 404
guards. Run with:

```bash
npx vitest run test/facet-scaffold-unit.test.ts test/facet-explore-unit.test.ts \
  test/facet-explore-parallel-unit.test.ts test/facet-task-scratch-unit.test.ts \
  test/facet-transcript-unit.test.ts
```

For end-to-end smoke testing against a real Worker, the A/B test in the
"Measured impact" section above can be replicated with any prompt that
requests three independent investigations.
