# Outbound notifications

Dodo can push notifications to multiple targets — today **ntfy** (push to
phones via [ntfy.sh](https://ntfy.sh)) and **generic webhooks** (arbitrary
HTTP POST with a templated body). The same notification fans out to every
configured target, so you can have ntfy on your phone *and* a webhook into
Signal or any other service.

Notifications fire on:

- Worker run terminal states (`done`, `failed`) — when a dispatched repo
  prompt finishes or fails verification.
- Background prompt completions — the LLM-driven prompts launched via
  `/run_prompt`, `/dispatch_repo_prompt`, etc.

The terminal/intermediate split is intentional. We don't fire on every
state change to avoid notification spam.

## ntfy channel

Set a topic and you're done:

- **Per-user secret:** `PUT /api/secrets/ntfy_topic` with `{"value":"your-topic"}`
- **Or env var:** `NTFY_TOPIC` (shared, applies to anyone without a per-user secret)

If neither is set, the ntfy channel is skipped.

### Target server

By default the channel posts to `https://ntfy.sh`. Override with the env
var `NTFY_BASE_URL` to publish to a self-hosted ntfy-compatible worker
instead — for example
[ntfy-worker](https://github.com/jonnyparris/ntfy-worker) deployed at
`https://ntfy-worker.<your-subdomain>.workers.dev`. Trailing slashes are
stripped, so either form works.

### Auth

Public ntfy.sh accepts unauthenticated posts. Self-hosted deployments
typically require a shared bearer token. Set one of:

- **Per-user secret:** `PUT /api/secrets/ntfy_token` with `{"value":"<token>"}`
- **Or env var:** `NTFY_TOKEN`

When set, Dodo sends `Authorization: Bearer <token>` on every publish.
When absent, no auth header is sent — fine for public ntfy.sh; a
self-hosted worker with auth will reject the request.

## Webhook channels

Webhook channels are configured via a single per-user encrypted secret,
`notification_webhooks`, whose value is a JSON array. Each entry creates
one outbound channel. Missing or malformed entries are silently skipped
— a broken config can't stop other channels from delivering.

### Config shape

```jsonc
[
  {
    "id": "signal",                   // human label, used in logs
    "url": "https://signal.example.com/v2/send",
    "method": "POST",                 // optional, default POST
    "headers": {                      // optional literal headers
      "X-Source": "dodo"
    },
    "headerSecrets": {                // optional — header → secret key
      "Authorization": "signal_auth"  // resolves to value of secret `signal_auth`
    },
    "bodyTemplate": "{\"message\":\"{{title}}\\n{{body}}\",\"number\":\"+44XXXXXXXXXX\",\"recipients\":[\"+44XXXXXXXXXX\"]}",
    "contentType": "application/json", // optional, default application/json
    "minPriority": "high"             // optional — skip events below this
  }
]
```

### Body template placeholders

The `bodyTemplate` string supports `{{field}}` placeholders. Available
fields:

| Placeholder      | Source                                       |
|------------------|----------------------------------------------|
| `{{title}}`      | Notification title, e.g. `Dodo: foo done`    |
| `{{body}}`       | Notification body (may contain newlines)     |
| `{{priority}}`   | One of `min`, `low`, `default`, `high`, `urgent` |
| `{{tags}}`       | Comma-separated ntfy-style tags (may be empty) |
| `{{url}}`        | Click-through URL (may be empty)             |

When `contentType` indicates JSON (the default), values are JSON-escaped
automatically — `{{body}}` containing `"` or `\` or newlines stays
valid inside the surrounding JSON template. For non-JSON content types
(e.g. `text/plain`), values are substituted as-is.

### Priority filter

`minPriority` drops events below the configured level. Useful for
"only ping Signal on failures, but ntfy gets everything":

```jsonc
{ "id": "signal", "url": "...", "bodyTemplate": "...", "minPriority": "high" }
```

Priority order: `min < low < default < high < urgent`. Worker run
`done` events are `default`; `failed` events are `high`.

### Signal example

Using [signal-cli-rest-api](https://bbernhard.github.io/signal-cli-rest-api/):

1. Store the channel config:

   ```bash
   curl -X PUT https://dodo.example/api/secrets/notification_webhooks \
     -H 'Content-Type: application/json' \
     -d '{"value":"[{\"id\":\"signal\",\"url\":\"https://signal.mydomain.example/v2/send\",\"bodyTemplate\":\"{\\\"message\\\":\\\"{{title}}\\\\n{{body}}\\\",\\\"number\\\":\\\"+44XXXXXXXXXX\\\",\\\"recipients\\\":[\\\"+44XXXXXXXXXX\\\"]}\"}]"}'
   ```

2. (Optional) If your Signal API is behind an auth proxy, store the
   auth token separately and reference it from `headerSecrets`:

   ```bash
   curl -X PUT https://dodo.example/api/secrets/signal_auth \
     -d '{"value":"Bearer your-proxy-token"}'
   ```

   Then add `"headerSecrets": {"Authorization": "signal_auth"}` to
   the webhook config.

3. Trigger any notification — for instance, dispatch a repo prompt that
   you know will fail — and confirm the Signal message arrives.

### Other targets

The same channel works for anything that takes an HTTP POST. A few
shapes that are known to work:

- **Slack incoming webhook:** `bodyTemplate: "{\"text\":\"*{{title}}*\\n{{body}}\"}"`
- **Discord webhook:** `bodyTemplate: "{\"content\":\"**{{title}}**\\n{{body}}\"}"`
- **Resend / Postmark transactional email:** depends on your provider's
  send-email JSON shape; substitute `{{title}}` → subject, `{{body}}` → body.

## How it fits together

```
sendNotification(env, ctx, payload)
  └─ ctx.waitUntil(
       resolveChannels(env, ownerEmail)
         ├─ ntfy channel (if topic configured)
         └─ webhook channels (zero or more from notification_webhooks)
       → fan out to all channels in parallel
       → each channel swallows its own errors
     )
```

Channels are independent. One returning an error or being misconfigured
does not prevent the others from firing. Notification failures never
surface as user-visible errors — the request that triggered the
notification has already returned by then.

## Limits

- Webhook body must be valid for whatever the receiver expects. Dodo
  doesn't validate the rendered output — if the template produces bad
  JSON, the receiver returns 4xx and the notification is silently
  dropped.
- No retries. If the receiver is down, the notification is lost. This
  is intentional — notifications are advisory.
- No outbound allowlist today. The Worker can `fetch` any HTTPS URL
  configured in the secret. Don't put a webhook config in someone
  else's account, basically.
