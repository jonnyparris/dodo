# AGENTS.md

Autonomous coding agent repo for Dodo on Cloudflare Workers.

## Focus

- Multi-tenant architecture: per-user state via UserControl DO, global state via SharedIndex DO.
- All planned phases are implemented: sessions, chat, workspace, execution, git, cron, memory, allowlist, forking, secrets, MCP, notifications, and UI.
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

- `src/index.ts` — Worker router (Hono), all HTTP routes, auth middleware, session fork, admin routes
- `src/coding-agent.ts` — per-session agent DO (chat, files, git, execute, cron, prompts, snapshots, SSE)
- `src/user-control.ts` — per-user DO (config, sessions, memory, tasks, key envelope, encrypted secrets, fork snapshots)
- `src/shared-index.ts` — global singleton DO (user allowlist, host allowlist, models cache, session shares/permissions)
- `src/app-control.ts` — legacy global DO (kept for migration, being phased out)
- `src/agentic.ts` — LLM integration: generateText/streamText with Vercel AI SDK, tool composition with codemode
- `src/executor.ts` — DynamicWorkerExecutor wrapper for sandboxed code
- `src/git.ts` — isomorphic-git helpers via @cloudflare/shell, multi-host token injection (GitHub + GitLab)
- `src/mcp.ts` — MCP server exposing all Dodo capabilities as tools
- `src/crypto.ts` — hybrid envelope encryption (PBKDF2 + HKDF + AES-GCM) for per-user secrets
- `src/auth.ts` — Cloudflare Access JWT verification, user allowlist check, admin guard
- `src/notify.ts` — push notifications via ntfy.sh (per-user topic from encrypted secrets)
- `src/outbound.ts` — AllowlistOutbound WorkerEntrypoint for gated sandbox fetch
- `src/sql-helpers.ts` — lightweight SQLite query helpers
- `src/types.ts` — shared TypeScript types
- `test/dodo.test.ts` — 24 integration tests via vitest-pool-workers
- `public/index.html` — three-panel web UI (mobile-responsive)
- `public/docs.html` — architecture documentation page

## Architecture

```
Worker (Hono router + CF Access auth)
+-- SharedIndex DO (global singleton)
|   +-- users, host_allowlist, models_cache, session_shares, session_permissions
+-- UserControl DO (one per user, idFromName(email))
|   +-- user_config, sessions, memory_entries, tasks, key_envelope, encrypted_secrets, fork_snapshots
+-- CodingAgent DO (one per session, extends Agent SDK)
|   +-- metadata, messages, prompts, cron_jobs
|   +-- Workspace (@cloudflare/shell, SQLite + optional R2 spill)
|   +-- DynamicWorkerExecutor (@cloudflare/codemode, gated outbound)
+-- AppControl DO (legacy, migration target)
+-- AllowlistOutbound (WorkerEntrypoint, self-referencing service binding)
```

## Test Coverage (24 tests)

| Test | What it covers |
|------|---------------|
| Session + messages | Create session, send message, verify persistence |
| Allowlist + memory | Global CRUD for host allowlist and per-user memory entries |
| Workspace CRUD | File write, list, search, replace, read, delete |
| Code execution | Sandboxed execution against workspace |
| Git operations | Init, add, commit, log, diff |
| Gateway switching | Change config, verify gateway used |
| Async prompts | Start prompt, abort, verify status |
| Cron jobs | Create delayed job, list, delete |
| Session forking | Fork with files + messages, verify in new session |
| SSE events | Verify event stream opens with correct content-type |
| Path traversal | Reject `../` in file paths |
| Root delete | Reject deleting workspace root |
| Concurrent prompts | Return 409 when prompt already running |
| LLM failure | Return 502 on gateway error |
| Input validation | Reject invalid JSON bodies |
| Session cleanup | Verify storage destroyed on delete |
| CORS | Verify CORS headers present |
| Models + status | Models list and status endpoint |
| Task CRUD | Create, update, list, delete tasks |
| Token totals | Verify token tracking in session state |
| MCP auth | Reject unauthenticated MCP requests |
| MCP tools | Verify MCP server lists all tools |
| Notifications | Verify ntfy called on completion |
| Failure notifications | Verify ntfy called on LLM failure |
