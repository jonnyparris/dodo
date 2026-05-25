# File Map

Source layout. `src/index.ts` is the entry point; everything else hangs off the DOs it routes to.

## Entry & routing

- `src/index.ts` — Worker router (Hono), all HTTP routes, auth middleware, session fork, admin routes
- `src/auth.ts` — Cloudflare Access JWT verification, user allowlist check, admin guard
- `src/rpc-api.ts` / `src/rpc-transport.ts` — JSON-RPC API surface and transport
- `src/share.ts` — session sharing (tokens, permissions, cookies)
- `src/onboarding.ts` — guided passkey and secrets setup

## Agent core

- `src/coding-agent.ts` — per-session agent DO (extends Think, chat via Think.chat(), fibers, workspace, git, cron, prompts, snapshots, SSE). **Contains the system prompt.**
- `src/think-adapter.ts` — Think integration boundary: re-exports, types (DodoConfig, MessageMetadata, SnapshotV2), adapter functions
- `src/agentic.ts` — LLM provider construction (buildProvider), tool composition (buildToolsForThink), git tools
- `src/executor.ts` — DynamicWorkerExecutor wrapper for sandboxed code execution (direct API route)
- `src/typecheck.ts` — in-isolate `tsc --noEmit` tool
- `src/presence.ts` — WebSocket presence tracking

## Per-user / global state

- `src/user-control.ts` — per-user DO (config, sessions, memory, tasks, skills, key envelope, encrypted secrets, fork snapshots)
- `src/shared-index.ts` — global singleton DO (user allowlist, host allowlist, models cache, session shares/permissions)
- `src/crypto.ts` — hybrid envelope encryption (PBKDF2 + HKDF + AES-GCM) for per-user secrets
- `src/rate-limit.ts` — per-user rate limiting

## Skills

- `src/skill-registry.ts` — Claude/OpenCode-compatible SKILL.md loader (parser, manifest renderer, workspace scanner, R2 asset helpers)
- `src/builtin-skills.ts` — built-in SKILL.md content shipped with Dodo

## Git, MCP, outbound

- `src/git.ts` — git helpers via @cloudflare/shell, multi-host token injection (GitHub + GitLab)
- `src/repos.ts` — known repository registry for orchestration
- `src/mcp.ts` — MCP server exposing all Dodo capabilities as tools
- `src/mcp-codemode.ts` — code-mode MCP endpoint (2 tools, minimal context)
- `src/mcp-gatekeeper.ts` — MCP server auth and rate limiting
- `src/mcp-catalog.ts` — curated catalog of recommended MCP servers
- `src/outbound.ts` — AllowlistOutbound WorkerEntrypoint for gated sandbox fetch
- `src/notify.ts` — push notifications via ntfy.sh (per-user topic from encrypted secrets)

## Plumbing

- `src/sql-helpers.ts` — lightweight SQLite query helpers
- `src/health-check.ts` — health endpoint handler
- `src/logger.ts` — structured logging helpers
- `src/types.ts` — shared TypeScript types

## Tests & UI

- `test/dodo.test.ts` — integration tests via vitest-pool-workers
- `public/index.html` — three-panel web UI (mobile-responsive)
- `public/docs.html` — architecture documentation page
- `public/howto.html` — task-oriented how-to guides
