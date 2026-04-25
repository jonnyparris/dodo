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

## Deploying

**Deploys are manual.** Run `npm run deploy` locally after merging to `main`. Workers Builds CI is disabled because the `"experimental"` compat flag (required by `@cloudflare/think` and the Agents SDK `subAgent()` facet API) blocks non-local deploys by design — see [issue #46](https://github.com/jonnyparris/dodo/issues/46). When Think graduates out of experimental, this can be re-enabled.

## Git Discipline — Pick the Workflow That Matches Your Runtime

**Never commit directly to `main`.** All changes go through feature branches. The exact mechanics differ depending on where you're running.

### If you're a Dodo session (sandboxed clone in a Durable Object)

This is the case when the agent reading this file is running inside Dodo itself — the workspace is an ephemeral clone in a session DO, you have `git_*` tools (not a shell), and there is no `~/dev/dodo` parent checkout to share with.

**Do not use `git worktree`.** It has no meaning here — there's nothing to share with, no concurrent local agents to collide with, and no `..` parent dir. The session's clone *is* the workspace.

Workflow:

1. After cloning, create a branch directly: `git_branch` then `git_checkout`, or `git_checkout` with a `new` flag. Branch off `main`.
2. Make changes. Stage specific files. Commit with a clear message.
3. Push with `git_push_checked` — pass an explicit branch ref, never push to `main`.
4. **Open the draft PR before replying to the user.** If you have a `dodo_dispatch_repo_prompt`-style tool that opens the PR for you, use it. Otherwise construct the GitHub compare URL (`https://github.com/<owner>/<repo>/compare/main...<branch>?expand=1`) and include it in your final message. The user should never have to ask "where's the PR?" — that's a workflow failure.
5. Branch naming: `fix/sse-serialization`, `feat/per-user-auth`, `docs/update-readme`, `chore/<scope>`.

### If you're running locally via OpenCode CLI in `~/dev/dodo`

This is the case when the agent reading this file is running on a developer laptop, has shell access, and shares `~/dev/dodo` with potentially-concurrent agents. Use the worktree workflow:

1. **Create a worktree branch** before making any changes:
   ```bash
   git worktree add ../dodo-<short-description> -b <branch-name>
   ```
2. **Work in the worktree directory**, not in the main checkout.
3. **Commit and push** the branch, then open a PR on GitHub.
4. **Do not merge your own PRs** — let the repo owner review and merge.
5. **Clean up** the worktree after the PR is merged:
   ```bash
   git worktree remove ../dodo-<short-description>
   git branch -d <branch-name>
   ```

### Why the split

Without worktrees in the local case, concurrent agents create divergent histories on `main` that require merge commits and conflict resolution. This has already caused confusing commit graphs and near-loss of work.

In the Dodo-session case, worktrees solve a problem that doesn't exist — there's no shared checkout. Trying to use them wastes turns and confuses the agent (it tried, the tool didn't exist, then it improvised badly).

## File Map

- `src/index.ts` — Worker router (Hono), all HTTP routes, auth middleware, session fork, admin routes
- `src/coding-agent.ts` — per-session agent DO (extends Think, chat via Think.chat(), fibers, workspace, git, cron, prompts, snapshots, SSE). **Contains the system prompt.**
- `src/think-adapter.ts` — Think integration boundary: re-exports, types (DodoConfig, MessageMetadata, SnapshotV2), adapter functions
- `src/agentic.ts` — LLM provider construction (buildProvider), tool composition (buildToolsForThink), git tools
- `src/user-control.ts` — per-user DO (config, sessions, memory, tasks, key envelope, encrypted secrets, fork snapshots)
- `src/shared-index.ts` — global singleton DO (user allowlist, host allowlist, models cache, session shares/permissions)
- `src/executor.ts` — DynamicWorkerExecutor wrapper for sandboxed code execution (direct API route)
- `src/git.ts` — git helpers via @cloudflare/shell, multi-host token injection (GitHub + GitLab)
- `src/mcp.ts` — MCP server exposing all Dodo capabilities as tools
- `src/crypto.ts` — hybrid envelope encryption (PBKDF2 + HKDF + AES-GCM) for per-user secrets
- `src/auth.ts` — Cloudflare Access JWT verification, user allowlist check, admin guard
- `src/notify.ts` — push notifications via ntfy.sh (per-user topic from encrypted secrets)
- `src/outbound.ts` — AllowlistOutbound WorkerEntrypoint for gated sandbox fetch
- `src/presence.ts` — WebSocket presence tracking
- `src/sql-helpers.ts` — lightweight SQLite query helpers
- `src/health-check.ts` — health endpoint handler
- `src/logger.ts` — structured logging helpers
- `src/mcp-catalog.ts` — curated catalog of recommended MCP servers
- `src/mcp-codemode.ts` — code-mode MCP endpoint (2 tools, minimal context)
- `src/mcp-gatekeeper.ts` — MCP server auth and rate limiting
- `src/notify.ts` — push notifications via ntfy.sh
- `src/onboarding.ts` — guided passkey and secrets setup
- `src/rate-limit.ts` — per-user rate limiting
- `src/repos.ts` — known repository registry for orchestration
- `src/rpc-api.ts` — JSON-RPC API surface
- `src/rpc-transport.ts` — JSON-RPC transport layer
- `src/share.ts` — session sharing (tokens, permissions, cookies)
- `src/types.ts` — shared TypeScript types
- `test/dodo.test.ts` — integration tests via vitest-pool-workers
- `public/index.html` — three-panel web UI (mobile-responsive)
- `public/docs.html` — architecture documentation page
- `public/howto.html` — task-oriented how-to guides

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
|   +-- Workspace (@cloudflare/shell, SQLite + optional R2 spill)
|   +-- createExecuteTool (codemode with workspace + git providers, gated outbound)
|   +-- One Think session per DO — single-session invariant
|   +-- Durable fibers — async prompts survive DO eviction
+-- AllowlistOutbound (WorkerEntrypoint, self-referencing service binding)
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
| Doing tasks | Todo discipline: explicit lists of task shapes that always need todos (cloned-repo work, multi-file edits, review/audit/investigate tasks) vs. shapes that can skip them; post-compaction `todo_list` re-grounding hint; when to delegate with `task` |
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
