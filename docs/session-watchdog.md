# Session watchdog

A session watchdog autonomously detects when a running prompt is stuck
— for instance, a sandbox call that has hung, a MCP tool that's not
returning, an LLM that's looped without progress — and takes a
configured action: notify, abort, or nudge.

This is the "auto-resume on stall" feature. It rides on existing
infrastructure (Agent SDK schedules + the notification channel
registry) so there's no new alarm pipeline to operate.

## Quick start

Install a watchdog on a session:

```bash
curl -X PUT https://dodo.example/session/$SESSION_ID/watchdog \
  -H 'Content-Type: application/json' \
  -d '{
    "stallSeconds": 600,
    "action": "notify"
  }'
```

You'll get a notification on ntfy / Signal / any configured channel
the next time that session's active prompt sits idle for 10 minutes.

Remove it:

```bash
curl -X DELETE https://dodo.example/session/$SESSION_ID/watchdog
```

## How it works

```
PUT /session/:id/watchdog       (config stored in agent metadata)
  → agent.schedule(cron, "runWatchdogCheck")
    → tick (every 5 min by default)
      → read status + last activity + active prompt
        → decideWatchdog() → fire? yes/no
          → if yes: optionally abort, optionally nudge, always notify
```

Per session, at most one watchdog. PUT replaces an existing one
cleanly (cancels the previous schedule first).

The watchdog **fires once per stuck prompt**. After firing, it records
the offending prompt id and refuses to fire again until that prompt id
changes (because the user / nudge aborted it, or it eventually
finished). This prevents spam on multi-hour stalls.

## Config

```jsonc
{
  // Threshold (seconds) for considering an active prompt stuck.
  // Range: 60 – 86400. Default: 600 (10 minutes).
  "stallSeconds": 600,

  // What to do when a stall is detected:
  //   "notify" — send a notification only (default)
  //   "abort"  — abort the running prompt + notify
  //   "nudge"  — abort + dispatch a follow-up "summarise where you
  //              got stuck" prompt + notify
  "action": "notify",

  // Cron expression for the watchdog tick. Default: every 5 minutes.
  // Must be a 5-field expression. The watchdog itself is cheap —
  // a metadata read and a clock compare — so finer cadences are fine
  // but rarely useful.
  "checkCron": "*/5 * * * *",

  // (action="nudge" only) Custom nudge prompt body. Max 4000 chars.
  // Omitted → uses a built-in default that asks the agent to
  // summarise its stuck state and stop.
  "nudgePrompt": "..."
}
```

All fields are optional — `PUT` with an empty body installs a watchdog
with defaults (stallSeconds=600, action=notify, checkCron=`*/5 * * * *`).

## State

`GET /session/:id/watchdog` returns:

```jsonc
{
  "armed": true,
  "config": { "stallSeconds": 600, "action": "notify", "checkCron": "*/5 * * * *" },
  "scheduleId": "wd-abc123",
  "lastCheckedAt": "1715900000",         // epoch seconds, or null
  "lastFiredAt": "1715898400",            // epoch seconds, or null
  "lastFiredForPromptId": "prompt-xxx",   // empty string when never fired
  "fireCount": 3
}
```

## Actions

### `notify`

Send a notification with title `Dodo: <session title> (stalled)` and
priority `high`. Body includes session id, prompt id, stall duration,
and action. Notification fans out to all configured channels
(ntfy, webhooks). See [`docs/notifications.md`](./notifications.md).

The prompt continues running. The user can decide what to do.

### `abort`

Abort the running prompt (same path as `POST /session/:id/abort`),
then notify. The session returns to idle. Anything in the prompt queue
will run next.

### `nudge`

Abort, then dispatch a fresh prompt asking the agent to summarise
where it got stuck and stop. Useful when you want a breadcrumb
("got stuck waiting on MCP tool X with 14MB of context") rather than
silence.

The built-in nudge prompt:

> Your previous prompt was aborted by a session watchdog because it
> appeared stuck (no activity for the configured stall threshold).
> In one short paragraph, summarise where you got stuck and what you'd
> try differently next time. Then stop — do not retry the original
> task.

Override with `nudgePrompt` if you want different behaviour.

## When the watchdog is silent

The watchdog deliberately does nothing in these cases:

- Session status is not `running` (no active prompt to watch)
- No active prompt id is set
- Last activity timestamp is missing
- Elapsed time since last activity < `stallSeconds`
- It already fired for the current `active_prompt_id` (fire-once)

If none of these apply and the watchdog still hasn't fired, check that
its cron schedule actually exists:

```bash
# Should show armed: true and a scheduleId
curl https://dodo.example/session/$SESSION_ID/watchdog
```

## Limitations

- **Granularity is bounded by the cron cadence.** Default `*/5 * * * *`
  means a 10-minute stall could be detected anywhere between 10:00 and
  15:00 minutes after the activity stamp.
- **Activity = any metadata write.** A prompt that's busy with a slow
  tool call but writing nothing to its own metadata may look stuck
  even though it isn't. The current activity-stamp is conservative.
- **No retries.** If `abort` or the nudge prompt itself fails, the
  watchdog logs the failure but doesn't try again on the same tick.
  The next tick re-evaluates from scratch.
- **No cross-session coordination.** Each session's watchdog is
  independent. If you want "alert me if *any* session stalls",
  configure a watchdog per session, or write a separate poller.
