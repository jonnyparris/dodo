# Dodo client for pi

Attach [pi](https://github.com/earendil-works/pi) to a Dodo session. What you type goes to Dodo. Dodo's replies, tool calls and streamed text show in pi as they happen. The session runs on Dodo, so it keeps going when you close the laptop. Attach again later from any machine.

```
/dodo                 pick a session (or start a new one) and attach
/dodo new [prompt]    new session, attach, and send a first prompt if given
/dodo attach <id>     attach by id or id prefix
/dodo detach          stop forwarding; pi talks to its local model again
/dodo model [id]      set this session's model (picker without an id; "default" clears)
/dodo abort           stop the running prompt
/dodo status          model, status, tokens, context use
/dodo open            open the session in the browser
```

While attached, everything you type except `/commands` and `!shell` goes to Dodo. The footer shows `🦤 <session> · <model>`. When a prompt waits for a Workers AI capacity slot, the live panel shows `⏳ waiting for model capacity` with a countdown, so a queued turn doesn't look stalled. If you close pi while attached, it attaches again when you reopen that pi session, and shows the messages you missed.

`/dodo model` changes only the attached session (`PUT /session/:id/model-override`). Your default model and your other sessions stay as they are. It takes effect from the next prompt. A prompt that is already running keeps its main model (in facet mode, subagents it starts later pick up the change), so while it runs the footer shows `<running model> → <next model>`. Only the session owner can change it.

## Setup

You need three values: the Dodo URL and a Cloudflare Access **service token** (client id + secret) that the Dodo Access app accepts.

1. **Create a service token.** Zero Trust → Access → Service credentials → Create. Use one token per device so you can revoke one without touching the others.
2. **Allow it on the Dodo app.** Add the token to a policy with the action **Service Auth** (`non_identity`) on the Access app in front of Dodo. Dodo maps service tokens to `ADMIN_EMAIL` (`src/auth.ts`), so the token acts as the admin. Treat it like a password.
3. **Store the values.**

   macOS keychain (recommended):
   ```bash
   security add-generic-password -U -s dodo-pi-client -a url -w https://your-dodo.example.com
   security add-generic-password -U -s dodo-pi-client -a client_id -w <client-id>
   security add-generic-password -U -s dodo-pi-client -a client_secret -w <client-secret>
   ```
   Or environment variables (any OS): `DODO_URL`, `DODO_ACCESS_CLIENT_ID`, `DODO_ACCESS_CLIENT_SECRET`. These win over the keychain.

4. **Load the extension.** Add it to `~/.pi/agent/settings.json`:
   ```json
   { "extensions": ["~/dev/dodo/clients/pi/dodo.ts"] }
   ```
   Or try it once: `pi -e ./clients/pi/dodo.ts`.

To revoke a device, delete its service token in Zero Trust. Nothing else changes.

## Limits

- Thinking level can't be set yet. Dodo sends every model through an OpenAI-compatible gateway with reasoning off.
- Only messages and top-level tool calls show. Subagent internals, file panels and the live browser stay in the web UI (`/dodo open`).
- On attach, the client shows the last 6 messages. `/dodo open` has the full history.
- Each attach adds entries to the local pi session file. They render in pi's transcript but are never sent to pi's local model.
