# Scheduled new-session jobs

Dodo can schedule the **creation of a brand new session** at a future time
and run a prompt inside it. This complements `POST /session/:id/cron`
(which schedules prompts inside an **existing** session) by providing the
"create-and-run" workflow.

## When to use it

- "Start a fresh session in 10 minutes and run this prompt in it."
- "Every weekday at 09:00 UTC, fork this seed session and ask it to check
  for dependency updates."
- "In 24 hours, run this follow-up task in a clean session so results
  aren't mixed with the current conversation."

## Design in one line

Per-user `UserControl` DO alarms drive schedules. No Worker-level cron
ticker, no central queue — every user's schedules are precise and
isolated.

```
POST /api/scheduled-sessions          (authenticated)
  → UserControl DO (per-user)
    → storage.setAlarm(nextRunEpoch)
      → alarm() fires
        → create session (fresh or fork)
          → dispatch prompt to CodingAgent
            → emit scheduled_session_fired on /api/events SSE
```

## API

All routes sit under the standard CF Access auth middleware.

### `POST /api/scheduled-sessions`

Create a scheduled new-session job.

**Body** (discriminated on `type` and `source`):

```jsonc
{
  "description": "string, 1-500 chars",
  "prompt": "string, 1-100000 chars",

  // Exactly one schedule shape:
  "type": "delayed",     "delayInSeconds": 600
  // or
  "type": "scheduled",   "date": "2026-05-01T09:00:00Z"
  // or
  "type": "cron",        "cron": "*/5 * * * *"
  // or
  "type": "interval",    "intervalSeconds": 600

  // Exactly one source shape:
  "source": "fresh",     "title": "optional session title"
  // or
  "source": "fork",      "sourceSessionId": "uuid", "title": "optional"
}
```

**Minimums** (rejected at create time):

| Field              | Minimum              |
|--------------------|----------------------|
| `delayInSeconds`   | 1 (max 90 days)      |
| `date`             | must be in the future|
| `intervalSeconds`  | 300 (5 minutes)      |
| `cron` gap         | next-3-match gap ≥ 300s |

**Fork source permission:** if `source: "fork"`, the caller must have
write access on the source session at create time. Fork sources are
resolved via `resolveSessionPermission` — session owner, platform admin,
SharedIndex grant, or a valid share cookie.

**Cap:** 50 scheduled sessions per user. Returns 400 with a clear message
when exceeded.

**Response 201**: a `ScheduledSessionRecord`.

### `GET /api/scheduled-sessions`

List the caller's scheduled jobs, newest first.

### `GET /api/scheduled-sessions/:id`

Fetch a single job. Useful for polling `lastSessionId` after a fire.

### `DELETE /api/scheduled-sessions/:id`

Cancel a scheduled job. Recomputes the DO alarm to `MIN(next_run_epoch)`.

### `POST /api/scheduled-sessions/:id/retry`

Clear a stalled job's `stalled_at` and `failure_count`, recompute
`next_run_epoch`, and re-arm the alarm. Use this after fixing the
underlying cause of the stall (e.g. restoring a deleted fork source).

## ScheduledSessionRecord shape

```ts
{
  id: string;
  description: string;
  prompt: string;
  scheduleType: "delayed" | "scheduled" | "cron" | "interval";
  delaySeconds: number | null;
  targetEpoch: number | null;
  cronExpression: string | null;
  intervalSeconds: number | null;
  sourceType: "fresh" | "fork";
  sourceSessionId: string | null;
  title: string | null;
  nextRunAt: string | null;    // ISO datetime; null when stalled
  lastRunAt: string | null;
  lastSessionId: string | null;
  runCount: number;
  failureCount: number;
  stalledAt: string | null;
  lastError: string | null;
  createdAt: string;
  createdBy: string;
}
```

## Firing semantics

- **Rate-limit.** Each fire counts against the owner's prompt limiter
  (60 prompts/hour). Rate-limited fires defer `next_run_epoch` by the
  limiter's `retryAfter` — they don't count as failures.
- **Session creation** happens locally in the owning DO to avoid
  DO-to-self deadlock:
  - `fresh` → register a new row in the local `sessions` table with
    `createdBy: "scheduled-session"`.
  - `fork` → snapshot the source agent, store payload in the local
    `fork_snapshots` table, register the new session, then ask the
    target agent to import the snapshot. If the source session is gone,
    the fire fails with `source_session_missing`.
- **Prompt dispatch** reads the owner's **current** config (model,
  gateway, base URLs) — the model you get is the model set on the
  account when the prompt runs, not when the schedule was created.
- **One-shot schedules** (`delayed`, `scheduled`) delete the row on
  success. **Recurring schedules** (`cron`, `interval`) update
  `lastRunAt`/`lastSessionId`/`runCount` and compute the next fire.

## Failure and stall handling

- Each failure bumps `failure_count` and applies exponential backoff:
  60s × 2ⁿ, capped at 3600s.
- After 5 consecutive failures, `stalled_at` is set and `next_run_epoch`
  cleared. The alarm skips the row. Call `POST .../retry` to resume.
- Rate-limit hits **do not** count as failures.

## Alarm batching

The alarm handler processes up to 10 due rows per invocation. If more
remain overdue, it re-arms for `now + 1s` so the next batch runs quickly
without starving fetch handlers.

## SSE events

Each fire emits a `scheduled_session_fired` event on the user's
`/api/events` SSE stream:

```jsonc
{ "type": "scheduled_session_fired", "id": "...", "ok": true,  "lastSessionId": "..." }
{ "type": "scheduled_session_fired", "id": "...", "ok": false, "error": "rate_limited" }
```

## Constraints explicitly **not** supported (yet)

- **No editing** of a schedule after creation — delete + recreate.
- **No cross-user shared schedules** — each schedule belongs to exactly
  one user.
- **No TTL / auto-cleanup** on sessions created by fires — they count
  against the user's session budget until manually deleted.
- **No MCP tool yet** — scheduling today is API-only. An MCP tool is on
  the roadmap so agents can schedule their own follow-ups.

## Related endpoints

- `POST /session/:id/cron` — schedule a prompt inside an **existing**
  session (uses the Agents SDK `this.schedule()` primitive).
- `POST /session/:id/fork` — fork a session on demand. The scheduled
  `fork` source type reuses the same snapshot+import pipeline.
