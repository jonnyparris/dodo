# Dodo

Self-hostable autonomous coding agent on Cloudflare Workers + Durable Objects.

## What it does

Dodo is a turnkey coding agent backend and UI. Each session gets its own Durable Object with a persistent SQLite-backed workspace, chat history, sandboxed code execution, and git operations. A global control plane manages LLM gateway config, host allowlists, and long-term memory.

## Features

- **Sessions** -- create, list, delete, fork sessions with full state
- **Chat** -- synchronous `POST /session/:id/message` and async `POST /session/:id/prompt` with abort
- **Workspace** -- file CRUD, search, in-file replace via `@cloudflare/shell`
- **Code execution** -- sandboxed JS via Worker Loaders and `@cloudflare/codemode`
- **Git** -- init, clone, add, commit, branch, checkout, pull, push, diff, remote (isomorphic-git)
- **Cron** -- schedule delayed, cron, or interval tasks that run prompts
- **Session forking** -- snapshot files + messages into a new session
- **Config** -- switchable LLM gateway (OpenCode / AI Gateway), model, git author
- **Allowlist** -- manage outbound hostnames the sandbox can access
- **Memory** -- global key-value memory store with text search
- **SSE** -- real-time event stream per session for messages, state, files, prompts, execution
- **Web UI** -- three-panel app: session list + config, chat, workspace + git + prompts + cron + memory
- **Auth** -- Cloudflare Access JWT verification in production, dev bypass for tests
- **Tests** -- 10 integration tests covering all major flows

## Commands

```bash
npm install
npm run typecheck
npm test
npm run dev
npm run deploy
```

## Secrets (via `wrangler secret put`)

| Secret | Purpose |
|--------|---------|
| `OPENCODE_GATEWAY_TOKEN` | Auth token for the OpenCode gateway |
| `AI_GATEWAY_KEY` | Auth key for the AI Gateway fallback |
| `GITHUB_TOKEN` | Git push/pull to GitHub repos |
| `GITLAB_TOKEN` | Git push/pull to GitLab repos |

## Architecture

```
Worker (Hono router)
+-- AppControl DO (singleton)
|   +-- app_config, sessions, host_allowlist, memory_entries, fork_snapshots
+-- CodingAgent DO (one per session, extends Agent SDK)
    +-- metadata, messages, message_parts, prompts, cron_jobs
    +-- Workspace (@cloudflare/shell, SQLite + optional R2)
    +-- DynamicWorkerExecutor (@cloudflare/codemode)
```

## License

MIT
