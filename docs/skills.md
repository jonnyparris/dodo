# Skills

Dodo supports SKILL.md files compatible with both Claude Code and OpenCode. Three sources merged into one deduplicated list (precedence: personal > workspace > builtin):

1. **Personal** — per-user, stored in UserControl DO SQLite. Created via the `skill_write` MCP tool or `POST /api/skills`. Bundled assets live in R2 under `skills/{userId}/{skillName}/...`.
2. **Workspace** — scanned from the cloned repo's `.dodo/skills/`, `.claude/skills/`, `.agents/skills/`, `.opencode/skill/`, `.opencode/skills/` directories. Read-only — promote to personal to edit.
3. **Builtin** — shipped with Dodo via `src/builtin-skills.ts`.

## Loading model

Two-stage progressive disclosure (matches Claude Code / OpenCode):

- **Session start:** `getSystemPrompt()` injects `<available_skills>` with name + description per enabled skill (~150 tokens each, capped at 4 KB total).
- **On demand:** the `skill` tool returns the full SKILL.md body and a sampled list of bundled file paths. Bundled files are NOT auto-loaded — the model uses `read` to fetch.

## MCP tools

- `skill_list` — list personal skills
- `skill_read` — get full body of a personal skill
- `skill_write` — create/update a personal skill
- `skill_enable` — toggle enabled flag
- `skill_delete` — remove a personal skill
- `skill_import_url` — fetch a SKILL.md from a URL and store it as personal

Workspace and built-in skills are visible from inside the chat (via the `skill` tool) but cannot be modified through the MCP CRUD surface. To edit a workspace skill, copy its body into a personal skill via `skill_write`.
