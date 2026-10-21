# File Map

Source layout. `src/index.ts` is the entry point; everything else hangs off the DOs it routes to.

## Entry & routing

- `src/index.ts` — Worker router (Hono), all HTTP routes, auth middleware, session fork, admin routes
- `src/auth.ts` — Cloudflare Access JWT verification, user allowlist check, admin guard
- `src/rpc.ts` — JSON-RPC API surface
- `src/share.ts` — session sharing (tokens, permissions, cookies)
- `src/onboarding.ts` — guided passkey and secrets setup

## Agent core

- `src/coding-agent.ts` — per-session agent DO: prompts + queue, workspace, git, cron, goals, watchdog, attachments, snapshots, SSE/WS. **Contains the system prompt.**
- `src/agent-base.ts` — `DodoAgentBase extends Agent` (agents SDK): SDK fibers (`startFiber` / `onFiberRecovered`), `_think_config` table, `migrateLegacyFiberTable` for pre-0.28 sessions
- `src/session-lifecycle.ts` — prompt lifecycle (start, queue, abort, busy handling) driven by fibers
- `src/pi/engine.ts` — PiEngine: the agent loop on `@earendil-works/pi-durable` (Harness on DO SQLite, `pi_` tables), SSE event bridge, transcript view. See `docs/adr/0002-pi-durable-foundation.md`
- `src/pi/models.ts` — Dodo gateways as a pi-ai `openai-completions` provider
- `src/pi/tools.ts` — adapts AI SDK `tool()` objects to durable pi tools; `REPLAY_SAFE_TOOLS`
- `src/pi/loop-guard.ts` — repeated-tool-call detection as a pi hook
- `src/think-history.ts` / `src/transcript.ts` — read-only reader for pre-pi (Think-era) history, migrated lazily on the next prompt
- `src/agentic.ts` — LLM provider construction (`buildProvider`), tool composition (`buildToolsForThink`, name kept for history), git tools, `set_goal_status`
- `src/tools/workspace-tools.ts` — read / write / edit / grep / find tools on the session workspace
- `src/tools/execute-tool.ts` — codemode `execute` (sandboxed JS in a Dynamic Worker; `withJsonSafeBytes` for binary data)
- `src/tools/shell.ts` / `src/tools/shell-patch.ts` — busybox-style shell (just-bash on `@cloudflare/computer`), patched so redirects write raw bytes
- `src/tools/image-check.ts` / `src/clef.ts` — Clef decision models: `image_check`, image edit-vs-answer routing (ADR 0003)
- `src/browser/session-browser.ts` — one SDK `Browser` per session + `browser_execute`; Live View
- `src/browser/web-fetch.ts` — `browser_markdown` / `browser_triage` (fetch first, Browser Run fallback, Clef page checks)
- `src/tools/kitebuild.ts` — `ci_run`: verify a pushed branch in Kitebuild (enabled by `KITEBUILD_*` config)
- `src/explore-agent.ts` / `src/task-agent.ts` / `src/subagent-runner.ts` — `explore` and `task` subagents (in-process or facet DOs)
- `src/typecheck.ts` — in-isolate `tsc --noEmit` tool
- `src/session-goal.ts` — goal helpers + types. See `docs/session-goals.md`
- `src/watchdog.ts` — stall detection for long prompts. See `docs/session-watchdog.md`
- `src/chat-monitor-agent.ts` — polls a Google Chat space and forwards messages into a session
- `src/presence.ts` — WebSocket presence tracking
- `src/autopilot.ts` — self-diagnose loop: `buildDiagnoseGoal`, `buildSupervisorGoal`, owner resolution
- `src/cloudflare-logs.ts` — Workers Observability wrapper for admin self-introspection

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
- `src/tools/session-tools.ts` — agent tools on its own session: `schedule_prompt` / `list_schedules` / `cancel_schedule` (cron jobs) and `request_user_input` (needs-input handoff)
- `src/completion-webhook.ts` — `callbackUrl` doorbell POSTed when a prompt finishes
- `src/mcp.ts` — MCP server exposing Dodo as 75 tools
- `src/mcp-codemode.ts` — code-mode MCP endpoint (2 tools, minimal context)
- `src/mcp-catalog.ts` — curated catalog of recommended MCP servers
- `src/mcp-step-up.ts` — mid-session OAuth re-authorization for OAuth MCP servers (403 `insufficient_scope` step-up, failed refresh): hub parks the connection in `authenticating` so the callback keeps the code; session raises a needs-input card with an **Approve access** link
- `src/outbound.ts` — AllowlistOutbound WorkerEntrypoint for gated sandbox fetch
- `src/notify.ts` — push notifications via ntfy.sh (per-user topic from encrypted secrets)

## Plumbing

- `src/sql-helpers.ts` — lightweight SQLite query helpers
- `src/health-check.ts` — health endpoint handler
- `src/logger.ts` — structured logging helpers
- `src/types.ts` — shared TypeScript types

## Tests & UI

- `test/` — ~100 test files on vitest-pool-workers (real workerd + Durable Objects); models mocked via `test/helpers/pi-models-mock.ts`
- `public/index.html` — three-panel web UI (mobile-responsive)
- `public/docs.html` — architecture documentation page
- `public/howto.html` — task-oriented how-to guides
