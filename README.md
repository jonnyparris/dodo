# Dodo

![Dodo](assets/dodo.svg)

Self-hostable autonomous coding agent on Cloudflare Workers + Durable Objects.

## What it does

Dodo is a turnkey coding agent backend and UI. Each session gets its own Durable Object with a persistent SQLite-backed workspace, chat history, sandboxed code execution, and git operations. Per-user state (config, sessions, memory, tasks, encrypted secrets) lives in a UserControl DO. A shared index manages the user allowlist, host allowlist, and models cache.

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
- **Memory** -- per-user key-value memory store with text search
- **Tasks** -- per-user Kanban backlog with auto-dispatch to sessions
- **Secrets** -- encrypted per-user secret storage (envelope encryption with passkey + server key)
- **MCP** -- Model Context Protocol server exposing all tools (sessions, files, git, memory, tasks)
- **Notifications** -- push notifications via ntfy.sh on completion/failure
- **SSE** -- real-time event stream per session for messages, state, files, prompts, execution
- **Web UI** -- three-panel responsive app: session list + config, chat, workspace + git + prompts + cron + memory + secrets
- **Auth** -- Cloudflare Access JWT verification, user allowlist, admin controls
- **Multi-tenant** -- per-user isolation via UserControl DOs, admin user management
- **Tests** -- 24 integration tests covering all major flows

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
| `SECRETS_MASTER_KEY` | 32-byte hex key for server-side envelope encryption |
| `DODO_MCP_TOKEN` | Bearer token for MCP endpoint auth |

Per-user secrets (GitHub token, GitLab token, ntfy topic, gateway token) are stored encrypted in each user's UserControl DO after passkey onboarding.

## Architecture

```
Worker (Hono router + CF Access auth)
+-- SharedIndex DO (global singleton)
|   +-- users, host_allowlist, models_cache, session_shares, session_permissions
+-- UserControl DO (one per user, idFromName(email))
|   +-- user_config, sessions, memory_entries, tasks
|   +-- key_envelope, encrypted_secrets (envelope encryption)
|   +-- fork_snapshots, mcp_configs
+-- CodingAgent DO (one per session, extends Agent SDK)
|   +-- metadata, messages, prompts, cron_jobs
|   +-- Workspace (@cloudflare/shell, SQLite + optional R2 spill)
|   +-- DynamicWorkerExecutor (@cloudflare/codemode)
+-- AllowlistOutbound (WorkerEntrypoint, gated sandbox fetch)
+-- AppControl DO (legacy, kept for migration)
```

## License

MIT
