# AGENTS.md

Autonomous coding agent repo for Dodo on Cloudflare Workers.

## Focus

- All planned phases are implemented: sessions, chat, workspace, execution, git, cron, memory, allowlist, forking, and UI.
- Keep the implementation publishable and self-hostable.
- Prioritize correctness and test coverage over feature expansion.

## Commands

- `npm install`
- `npm run typecheck`
- `npm test`
- `npm run dev`
- `npm run deploy`

## Rules

- Run `npm test` and `npm run typecheck` regularly while changing behavior.
- Prefer small, typed modules over large all-in-one files.
- Keep Durable Object state persistent and observable.
- Preserve Cloudflare Access in production; local test bypass is allowed only in test/dev config.
- Do not introduce container- or VM-specific assumptions.

## File Map

- `src/index.ts` — Worker router, all HTTP routes, session fork logic
- `src/coding-agent.ts` — per-session agent DO (chat, files, git, execute, cron, prompts, snapshots)
- `src/app-control.ts` — global singleton DO (config, sessions, allowlist, memory, fork snapshots)
- `src/executor.ts` — DynamicWorkerExecutor wrapper for sandboxed code
- `src/git.ts` — isomorphic-git helpers, multi-host token injection
- `src/llm.ts` — gateway-specific LLM calls with abort support
- `src/auth.ts` — Cloudflare Access JWT verification
- `src/types.ts` — shared TypeScript types
- `test/dodo.test.ts` — 10 integration tests via vitest-pool-workers
- `public/index.html` — three-panel web UI

## Test Coverage

| Test | What it covers |
|------|---------------|
| Session + messages | Create session, send message, verify persistence |
| Allowlist + memory | Global CRUD for host allowlist and memory entries |
| Workspace CRUD | File write, list, search, replace, read, delete |
| Code execution | Sandboxed execution against workspace |
| Git operations | Init, add, commit, log, diff |
| Gateway switching | Change config, verify gateway used |
| Async prompts | Start prompt, abort, verify status |
| Cron jobs | Create delayed job, list, delete |
| Session forking | Fork with files + messages, verify in new session |
| SSE events | Verify event stream opens with correct content-type |
