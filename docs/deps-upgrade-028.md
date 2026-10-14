# agents 0.28 / think 0.20 / ai 7 upgrade — spike notes (2026-10-14)

Branch `feat/deps-agents-028`. Deps bump only; **does not typecheck**. Do not merge or deploy.

## Bumped

| pkg | from | to |
|---|---|---|
| agents | 0.8.7 | 0.28.1 |
| @cloudflare/think | 0.1.1 | 0.20.2 |
| ai | 6.0.271 | 7.0.139 |
| @ai-sdk/openai-compatible | 2.x | 3.0.68 |
| @cloudflare/codemode | 0.3.2 | 0.5.4 (agents peer `>=0.5.0`) |
| @cloudflare/computer | 0.2.1 | 0.5.1 |
| @cloudflare/shell | 0.3.0 | 0.4.3 (think dep) |
| @cloudflare/workers-types | 4.x | 5.20261006+ (wrangler 4.150 peer) |

`npm install` from the old lockfile fails ERESOLVE; delete `package-lock.json` + `node_modules` and reinstall.

## tsc after bump: 142 errors

- `src/coding-agent.ts` 131, `think-adapter.ts` 3, `index.ts` 3 (`ExecutionContext<unknown>`), `task-agent.ts` 2 + `explore-agent.ts` 1 (`ReadOperations.readFileBytes` now required), `agentic.ts` 1 (`createExecuteTool` lost `providers`), `browser/tools.ts` 1 (`ResolvedProvider.positionalArgs` gone).

## The blocker is architecture, not type errors

1. **Think owns `streamText`.** `onChatMessage` no longer exists on Think. Dodo's whole loop (`onChatMessage` → own `streamText`, doom-loop breaks, mid-loop compaction, budget warnings, hard-stop wrap-up, narration-aware same-tool break) has to be re-expressed as `beforeTurn` / `beforeStep` / `beforeToolCall` / `onStepFinish` / `onChatResponse`. Same work as the "Not doing" lifecycle migration in the 05-04 plan.
2. **Sessions are singular and async.** `this.sessions.getHistory(id)`, `getCurrentSessionId()`, `createSession()`, `switchSession()`, `getCompactions(id)`, `append(id, …)`, `addCompaction(id, …)` are gone. Now `this.session` (ThinkSession) with async `getHistory()`, `appendMessage()`, `getCompactions()`, `addCompaction()`. `this.messages` is read-only. Sync helpers become async, and that spreads through callers.
3. **Fibers:** `spawnFiber` / `getFiber` / `restartFiber` / `stashFiber` / `onFiberComplete` gone → `runFiber(name, ctx => …)` / `startFiber` / `ctx.stash` / `onFiberRecovered`. `cancelFiber` is back (async). Affects `session-lifecycle.ts` and the async-prompt path.
4. **`assembleContext` is gone.** Dodo's compaction safety net and token-budget drop logic move into `beforeTurn` (return `messages`) or `configureSession().onCompaction().compactAfter()`.
5. **Storage migration is one-way.** First wake on think 0.20 lifts `assistant_messages` / `assistant_compactions` into `cf_agents_session_*`, verifies and **drops** the old tables. `_think_config` moves to `think_config`. Rolling back the Worker afterwards means empty conversations. Needs a canary or a pre-deploy export.
6. **Experimental flag is still needed.** `subAgent()` is `@deprecated` in favour of `this.dynamicAgents`, which is `@experimental`. The Think README still says Experimental. Workers Builds stays off.

## Options

- **A. Rebuild the loop on Think 0.20 hooks.** Biggest change. Gains durable submissions, chat recovery, built-in overflow compaction, media eviction, `agentTool` for explore/task, and `agents/webfetch`.
- **B. Rebase CodingAgent on `AIChatAgent` (`@cloudflare/ai-chat` 0.12.1).** It still has `onChatMessage(onFinish, options)`, so the loop stays as it is. Lose Think's workspace/session/config. Needs a different message-storage migration (`cf_ai_chat_agent_messages`), and Dodo's own compaction table has to be rebuilt.
- **C. Stay on 0.8.7 and pull in only `agents/webfetch` via an npm alias.** Cheapest. Goes against "upgrade separately first".

## Flue check (2026-10-14)

Rejected. `@cloudflare/computer` worker-shell (Dynamic Worker) needs the `experimental` flag no matter which framework we use, so Flue doesn't unblock Workers Builds. Flue also has no per-step hook or message rewrite (the transcript is append-only), its tools aren't AI SDK, and its storage is new. Path A continues.

## browser_execute → SDK `browserTool` (2026-10-14, on this branch)

Done ahead of the Path A loop rebuild, so it lands with the bump instead of after it. Adds 0 tsc errors (142 → 136; it removes the `positionalArgs` error and the `lifecycle` clash).

- `CodingAgent` owns `browser = new Browser({ provider: browserRun(env.BROWSER, { keepAliveMs: 180_000 }) })` and installs it with `this.lifecycle.use(this.browser)`. Dodo's own `SessionLifecycle` field is renamed `sessionLifecycle`: agents 0.28 owns `this.lifecycle`.
- `src/browser/tools.ts` `browser_execute` = `browserTool({ browser, loader: LOADER, scope: sessionId })`, wrapped to keep Dodo's R2 screenshot attachments. The wrapper strips the `{ type: "browser_screenshot", mediaType, data }` payload from the persisted output, uploads it, and gives the model a text line with the attachment URL. `browser_search` is unchanged.
- `src/index.ts` exports `CodemodeRuntime` (browserTool runs code in a codemode facet).
- The model-facing API changed: `cdp.send({ method, params, sessionId: "active" })` (object form), screenshots must be returned as `browser_screenshot` (other base64 is redacted by the SDK), 1 MB cap per `cdp.send` result. The system prompt and the `browser-cdp-perf` builtin skill are rewritten for this.
- **Merging main:** main has the f8d78bf keep_alive pool (`leaseBrowser` etc. in `cdp-session.ts`, `test/browser-pool-unit.test.ts`). Take this branch's `src/browser/tools.ts` and drop the pool. `connectBrowser` stays, because `web-fetch.ts` still uses it.
- Not verified at runtime: the branch doesn't typecheck or deploy yet. Smoke test after the loop rebuild: two `browser_execute` calls in one session share a tab, screenshot renders in the chat, `restarted: true` after keep_alive lapses.
