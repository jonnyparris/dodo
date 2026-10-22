# System Prompt Design

The system prompt lives in `src/coding-agent.ts` as `const SYSTEM_PROMPT`. It's a static string — not dynamically assembled from config or user preferences. The `CodingAgent` class returns it via `getSystemPrompt()`.

## Design principles

**Teach the tools, not the model.** The prompt documents what tools exist and when to use each one. It doesn't teach the model how to code — that's what the model already knows. The prompt bridges the gap between the model's general capabilities and Dodo's specific tool surface.

**Match reality.** Every tool mentioned in the prompt must actually exist. Every constraint mentioned (30s timeout, 10-step limit, sandboxed network) must be accurate. The prompt is a contract with the model.

**Concise over exhaustive.** A Sonnet-class model doesn't need 1500 lines of instruction. Cover identity, tool surface, key behaviors, safety rules, and limits. Trust the model for everything else.

**No sycophancy instructions.** The model should be direct and technically accurate. No "Great question!" or "I'd be happy to help." Focus on the work.

## Sections

| Section | Purpose |
|---------|---------|
| Identity | "You are Dodo" — establishes the agent's name and platform |
| Tone and style | Concise, markdown, no emojis, prefer edits over new files |
| Doing tasks | Todo discipline: explicit lists of task shapes that always need todos (cloned-repo work, multi-file edits, review/audit/investigate tasks) vs. shapes that can skip them; post-compaction `todo_list` re-grounding hint; when to delegate with `task` |
| Workspace tools | Documents read_file, write_file, search_files, replace_in_file |
| Code execution | Documents codemode: sandboxed JS, allowlisted fetch with no token injection (credential headers stripped unless the host has `allowCredentials`; see `x-dodo-stripped-headers`; only hosts in the `sandbox` scope, some limited to GET/HEAD with a 405; Dodo blocks carry `x-dodo-blocked`), 30s timeout |
| Git | Documents all git tools, auto-auth for GitHub/GitLab |
| Git safety | Stage specific files, clear commit messages, no force-push |
| Working with errors | State what failed, fix it, move on |
| Limits | 10-step cap, ephemeral workspace, no shell |

## Dynamic sections

`getSystemPrompt()` layers the static base with runtime context. In priority order (outermost wraps innermost):

| Source | When present |
|---|---|
| Admin global prefix | When SharedIndex `global_config.system_prompt_prefix` is set (admin-managed, applies to every session) |
| User prefix | When the session owner has `systemPromptPrefix` configured |
| Static base | Always (the `SYSTEM_PROMPT` const) |
| `<available_skills>` block | Always (warmed each turn from personal + workspace + builtin sources, capped at 4 KB) |
| Browser tools section | When `browser_enabled` metadata is true |
| **`## Your goal` section** | **When `goal_status === "active"`** — shows the goal text, current turn / max, and the `set_goal_status` contract. See [`session-goals.md`](session-goals.md). |
| `## Current workspace` | First turn only — bounded root listing |
| `## Project instructions` | When `AGENTS.md` / `CLAUDE.md` exists in the workspace |

## Changing the prompt

When modifying the system prompt:

1. Keep it factual. If you add a section about a tool, verify the tool exists in `buildToolsForThink()`.
2. Test with real prompts. The prompt shapes every interaction — small wording changes can have outsized effects on behavior.
3. Don't duplicate tool descriptions. The AI SDK sends tool schemas automatically. The prompt should explain *when* and *why* to use tools, not re-document their parameters.
4. The agent loop is pi-durable (`src/pi/engine.ts`); it has no fixed step cap. Goals have a turn budget (`docs/session-goals.md`) and subagents have their own step budgets (`src/agent-profile.ts`).

## Tool surface

These tools are available to the agent at runtime (built in `src/agentic.ts`):

**Workspace tools** (`src/tools/workspace-tools.ts`):
- `read` — read file contents with line offsets
- `write` — create or overwrite a file
- `edit` / `replace_all` — find-and-replace in one file
- `grep` / `find` / `list` — search and browse the workspace
- `delete` — remove a file or directory

**Shell** (`src/tools/shell.ts`):
- `shell` — busybox-style shell (pipes, redirects, coreutils) on the workspace. Not a container: no `npm install` or test runners

**Browser** (`src/browser/`):
- `browser_execute` — the session's persistent Chrome via CDP (admins; `BROWSER` binding)
- `browser_markdown` / `browser_triage` — read a page as markdown / rank URLs before fetching

**Clef** (`src/clef.ts`):
- `image_check` — yes/no, choice or score questions about an image, for models without vision

**Session** (`src/tools/session-tools.ts`, top-level turns only):
- `schedule_prompt` / `list_schedules` / `cancel_schedule` — run a prompt later in this session (once, at a time, cron, interval)
- `request_user_input` — stop for a person (login, CAPTCHA, decision): sets `needsInput`, keeps the browser alive, then the turn ends

**Git tools** (built in `buildGitTools()`):
- **Top-level (hot path):** `git_status`, `git_add`, `git_commit`, `git_diff`
- **Inside codemode only (call as `git.<name>`):** `git_clone_known`, `git_clone`, `git_push`, `git_push_checked`, `git_pull`, `git_branch`, `git_checkout`, `git_log`, `git_verify_remote_branch`, `pr_create`

The lower-frequency git tools are reachable via codemode's `git` provider namespace rather than as individual top-level tools. This saves roughly 1k tokens of tool-schema budget per turn without losing any capability — see `buildTools()` in `src/agentic.ts` for the split.

**Code execution** (`src/tools/execute-tool.ts`):
- `codemode` — sandboxed JS execution with workspace filesystem and git access, gated outbound fetch

**Typecheck** (from `src/typecheck.ts`):
- `typecheck` — runs `tsc --noEmit` against the workspace inside the CodingAgent DO. Bundles `typescript` and every `lib.*.d.ts` into the Worker so the check happens without a subprocess. Honours user `tsconfig.json`; refuses oversized projects (> 50 .ts/.tsx files or > 5 MB) with a structured `skipped` payload. Pass `extraStrict: true` to layer `noUnusedLocals` + `noUnusedParameters` + `noImplicitReturns` + `noFallthroughCasesInSwitch` on top of the user's tsconfig — a cheap stand-in for a real linter at zero extra bundle cost. Lib map (`src/typecheck-libs.generated.ts`) is checked in and regenerated by `scripts/generate-typecheck-libs.mjs` during `npm run build`. Manual validation: `npm run test:typecheck-smoke`.

**Skill loader** (`src/skill-registry.ts`):
- `skill` — load a SKILL.md body on demand. The system prompt's `<available_skills>` block lists name + description per skill; this tool returns the full body when the model picks one. Two-stage progressive disclosure mirrors Claude Code / OpenCode.

The hot-path tools (workspace primitives, the four top-level git tools, `codemode`, the subagent tools, and `skill`) are top-level. The rest of the git surface is exposed only through codemode's provider namespaces.
