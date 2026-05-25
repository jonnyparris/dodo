# AGENTS.md

Autonomous coding agent on Cloudflare Workers. Self-hostable, multi-tenant, sandboxed.

## Focus

- Multi-tenant: per-user state in UserControl DO, global state in SharedIndex DO.
- CodingAgent built on `@cloudflare/think` (chat loop, message persistence, durable fibers).
- Keep publishable and self-hostable. No container- or VM-specific assumptions.
- Correctness and test coverage over feature expansion.

## Commands

- `npm install`
- `npm run typecheck`
- `npm run lint` (CI uses Biome; same signal locally)
- `npm test`
- `npm run dev`
- `npm run deploy:safe` — build + deploy + post-deploy smoke probe. Use plain `npm run deploy` only when you mean to skip the probe.

## Rules

- Run `npm test` and `npm run typecheck` regularly while changing behavior.
- All Think imports route through `src/think-adapter.ts` — never import `@cloudflare/think` directly elsewhere.
- Prefer small, typed modules over large all-in-one files.
- Keep Durable Object state persistent and observable.
- Preserve Cloudflare Access in production; local test bypass is only for test/dev config.

## Where to Look

| Task | Location |
|------|----------|
| Source file map | `docs/file-map.md` |
| System prompt design + tool surface | `docs/system-prompt.md` |
| Skills loader + MCP CRUD | `docs/skills.md` |
| Linting (two-layer, why) | `docs/linting.md` |
| Deploy details + post-deploy probe | `docs/deploying.md` |
| Facets / scheduled sessions / notifications | `docs/facets.md`, `docs/scheduled-sessions.md`, `docs/notifications.md` |
| Goal-driven sessions (self-continuation) | `docs/session-goals.md` |
| Testing patterns | `docs/testing.md` |
| Watchdog | `docs/session-watchdog.md` |

## Git Discipline

**Never commit directly to `main`.** All changes go through feature branches. Two workflows — pick by runtime.

### Inside a Dodo session (sandboxed clone in a DO)

The session's clone *is* the workspace. **No worktrees** — they have no meaning here.

Git is split:
- **Top-level tools:** `git_status`, `git_add`, `git_commit`, `git_diff`.
- **Inside codemode (`git.<name>`):** `git_clone_known`, `git_clone`, `git_push`, `git_push_checked`, `git_pull`, `git_branch`, `git_checkout`, `git_log`, `git_verify_remote_branch`, `pr_create`.

Workflow:

1. After cloning, branch off `main` inside codemode: `await git.git_branch({ name: "feat/x" })` → `await git.git_checkout({ branch: "feat/x" })`.
2. Edit. Use top-level `git_status` / `git_add` / `git_commit`.
3. Push with `git.git_push_checked` (explicit branch ref, never `main`).
4. **Open the draft PR with `git.pr_create` before replying to the user.** Auto-detects GitHub vs GitLab, fills title/body from the latest commit, returns the URL. Quote that URL. If `pr_create` fails (e.g. missing per-user token), fall back to a compare URL and say what's missing — don't leave the user with a pushed branch and no PR.
5. Branch naming: `fix/sse-serialization`, `feat/per-user-auth`, `docs/update-readme`, `chore/<scope>`.

### Local via OpenCode CLI in `~/dev/dodo`

Concurrent agents share `~/dev/dodo`. Use worktrees:

1. `git worktree add ../dodo-<slug> -b <branch>`
2. Work in the worktree, not the main checkout.
3. Commit, push, open PR. Don't merge your own PRs.
4. Clean up: `git worktree remove ../dodo-<slug> && git branch -d <branch>`.

Without worktrees, concurrent agents create divergent histories on `main` and ugly merge commits. Worktrees in the Dodo-session case waste turns solving a problem that doesn't exist.

## File Map (top level)

See `docs/file-map.md` for the full list. Entry points:

- `src/index.ts` — Worker router, HTTP routes, auth, session fork
- `src/coding-agent.ts` — per-session DO. **Contains the system prompt.**
- `src/think-adapter.ts` — Think integration boundary
- `src/agentic.ts` — provider + tool composition
- `src/user-control.ts` — per-user DO
- `src/shared-index.ts` — global singleton DO
- `src/mcp.ts` — MCP server exposing Dodo capabilities
- `src/executor.ts` — DynamicWorkerExecutor for sandboxed code

## Architecture

```
Worker (Hono router + CF Access auth)
+-- SharedIndex DO (global singleton)
|   +-- users, host_allowlist, models_cache, session_shares, session_permissions
+-- UserControl DO (one per user, idFromName(email))
|   +-- user_config, sessions, memory_entries, tasks, key_envelope, encrypted_secrets, fork_snapshots
+-- CodingAgent DO (one per session, extends Think<Env, DodoConfig>)
|   +-- Think tables: assistant_sessions, assistant_messages, _think_config, cf_agents_fibers
|   +-- Dodo tables: metadata, message_metadata, prompts, cron_jobs
|   +-- Goal state: goal_text / goal_status / goal_turns_used in metadata (see docs/session-goals.md)
|   +-- Workspace (@cloudflare/shell, SQLite + optional R2 spill)
|   +-- createExecuteTool (codemode with workspace + git providers, gated outbound)
|   +-- One Think session per DO — single-session invariant
|   +-- Durable fibers — async prompts survive DO eviction
+-- AllowlistOutbound (WorkerEntrypoint, self-referencing service binding)
```

## Key Invariants

1. One Think session per Dodo DO — never more.
2. All Think imports through `src/think-adapter.ts`.
3. No `cf_agent_chat_*` WebSocket messages trigger Think chat.
4. Fiber methods use `stashFiber()` checkpoints — never assume resume-mid-execution.
5. Snapshot import handles both v1 and v2.
6. Git auth flows through Dodo's `resolveRemoteToken()`.
7. SSE/WS event protocol unchanged from the client's perspective.
