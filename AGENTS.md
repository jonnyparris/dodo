# AGENTS.md

Autonomous coding agent on Cloudflare Workers. Self-hostable, multi-tenant, sandboxed.

## Focus

- Multi-tenant architecture: per-user state via UserControl DO, global state via SharedIndex DO.
- CodingAgent built on `@cloudflare/think` for message persistence, chat loop, and durable fibers.
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
- All Think imports route through `src/think-adapter.ts` — never import `@cloudflare/think` directly elsewhere.

## File Map

- `src/index.ts` — Worker router (Hono), all HTTP routes, auth middleware, session fork, admin routes
- `src/coding-agent.ts` — per-session agent DO (extends Think, chat via Think.chat(), fibers, workspace, git, cron, prompts, snapshots, SSE). **Contains the system prompt.**
- `src/think-adapter.ts` — Think integration boundary: re-exports, types (DodoConfig, MessageMetadata, SnapshotV2), adapter functions
- `src/agentic.ts` — LLM provider construction (buildProvider), tool composition (buildToolsForThink), git tools
- `src/user-control.ts` — per-user DO (config, sessions, memory, tasks, key envelope, encrypted secrets, fork snapshots)
- `src/shared-index.ts` — global singleton DO (user allowlist, host allowlist, models cache, session shares/permissions)
- `src/app-control.ts` — legacy global DO (kept for migration, being phased out)
- `src/executor.ts` — DynamicWorkerExecutor wrapper for sandboxed code execution (direct API route)
- `src/git.ts` — isomorphic-git helpers via @cloudflare/shell, multi-host token injection (GitHub + GitLab)
- `src/mcp.ts` — MCP server exposing all Dodo capabilities as tools
- `src/crypto.ts` — hybrid envelope encryption (PBKDF2 + HKDF + AES-GCM) for per-user secrets
- `src/auth.ts` — Cloudflare Access JWT verification, user allowlist check, admin guard
- `src/notify.ts` — push notifications via ntfy.sh (per-user topic from encrypted secrets)
- `src/outbound.ts` — AllowlistOutbound WorkerEntrypoint for gated sandbox fetch
- `src/presence.ts` — WebSocket presence tracking
- `src/sql-helpers.ts` — lightweight SQLite query helpers
- `src/types.ts` — shared TypeScript types
- `test/dodo.test.ts` — integration tests via vitest-pool-workers
- `public/index.html` — three-panel web UI (mobile-responsive)
- `public/docs.html` — architecture documentation page

## Architecture

```
Worker (Hono router + CF Access auth)
+-- SharedIndex DO (global singleton)
|   +-- users, host_allowlist, models_cache, session_shares, session_permissions
+-- UserControl DO (one per user, idFromName(email))
|   +-- user_config, sessions, memory_entries, tasks, key_envelope, encrypted_secrets, fork_snapshots
+-- CodingAgent DO (one per session, extends Think<Env, DodoConfig>)
|   +-- Think tables: assistant_sessions, assistant_messages, _think_config, cf_agents_fibers
|   +-- Dodo tables: metadata, message_metadata, prompts, cron_jobs, approval_queue
|   +-- Workspace (@cloudflare/shell, SQLite + optional R2 spill)
|   +-- createExecuteTool (codemode with workspace + git providers, gated outbound)
|   +-- One Think session per DO — single-session invariant
|   +-- Durable fibers — async prompts survive DO eviction
+-- AllowlistOutbound (WorkerEntrypoint, self-referencing service binding)
+-- AppControl DO (legacy, migration target)
```

## Key Invariants

1. One Think session per Dodo DO — never more
2. All Think imports through `src/think-adapter.ts`
3. No `cf_agent_chat_*` WebSocket messages trigger Think chat
4. Fiber methods use `stashFiber()` checkpoints — never assume resume-mid-execution
5. Snapshot import handles both v1 and v2
6. Git auth flows through Dodo's `resolveRemoteToken()`
7. SSE/WS event protocol unchanged from client perspective

---

## System Prompt Design

The system prompt lives in `src/coding-agent.ts` as `const SYSTEM_PROMPT`. It's a static string — not dynamically assembled from config or user preferences. The `CodingAgent` class returns it via `getSystemPrompt()`.

### Design principles

**Teach the tools, not the model.** The prompt documents what tools exist and when to use each one. It doesn't teach the model how to code — that's what the model already knows. The prompt bridges the gap between the model's general capabilities and Dodo's specific tool surface.

**Match reality.** Every tool mentioned in the prompt must actually exist. Every constraint mentioned (30s timeout, 10-step limit, sandboxed network) must be accurate. The prompt is a contract with the model.

**Concise over exhaustive.** A Sonnet-class model doesn't need 1500 lines of instruction. Cover identity, tool surface, key behaviors, safety rules, and limits. Trust the model for everything else.

**No sycophancy instructions.** The model should be direct and technically accurate. No "Great question!" or "I'd be happy to help." Focus on the work.

### Sections

| Section | Purpose |
|---------|---------|
| Identity | "You are Dodo" — establishes the agent's name and platform |
| Tone and style | Concise, markdown, no emojis, prefer edits over new files |
| Doing tasks | Read-before-write, plan multi-step work, stay focused, delete dead code, security awareness |
| Workspace tools | Documents read_file, write_file, search_files, replace_in_file |
| Code execution | Documents codemode: sandboxed JS, fetch with auto-auth, 30s timeout |
| Git | Documents all git tools, auto-auth for GitHub/GitLab |
| Git safety | Stage specific files, clear commit messages, no force-push |
| Working with errors | State what failed, fix it, move on |
| Limits | 10-step cap, ephemeral workspace, no shell |

### Changing the prompt

When modifying the system prompt:

1. Keep it factual. If you add a section about a tool, verify the tool exists in `buildToolsForThink()`.
2. Test with real prompts. The prompt shapes every interaction — small wording changes can have outsized effects on behavior.
3. Don't duplicate tool descriptions. The AI SDK sends tool schemas automatically. The prompt should explain *when* and *why* to use tools, not re-document their parameters.
4. The max steps limit (10) is set in `getMaxSteps()` on the `CodingAgent` class. If you change it, update the prompt too.

### Tool surface

These tools are available to the agent at runtime (built in `src/agentic.ts`):

**Workspace tools** (from `@cloudflare/think/tools/workspace`):
- `read_file` — read file contents
- `write_file` — create or overwrite a file
- `search_files` — glob + content search
- `replace_in_file` — find-and-replace within a file

**Git tools** (built in `buildGitTools()`):
- `git_clone`, `git_status`, `git_add`, `git_commit`, `git_push`, `git_pull`
- `git_branch`, `git_checkout`, `git_diff`, `git_log`

**Code execution** (from `@cloudflare/think/tools/execute`):
- `codemode` — sandboxed JS execution with workspace filesystem and git access, gated outbound fetch

All tools are registered as top-level tools. Codemode also has access to workspace and git tools internally as providers.
