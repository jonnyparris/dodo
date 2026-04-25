/**
 * Built-in skills shipped with Dodo. These are baked into the bundle as
 * static markdown — no R2 lookup, no DO query. The model sees them in the
 * `<available_skills>` manifest like any other skill and loads them on
 * demand via the `skill` tool.
 *
 * Each entry must include the same fields a parsed SKILL.md file would
 * produce: `name`, `description`, `body`. Add new built-ins by appending
 * to BUILTIN_SKILLS.
 *
 * Personal skills with the same name override built-ins (see mergeSkills
 * precedence in skill-registry.ts). That lets users tweak a built-in
 * without forking Dodo.
 */

import type { Skill } from "./skill-registry";

const BUILTIN_SKILLS: Array<Pick<Skill, "name" | "description" | "body">> = [
  {
    name: "dodo-self",
    description:
      "Reference for Dodo's own architecture — sessions, Durable Objects, R2 spillage, the agentic loop, and how subagents (explore/task) work. Load when the user asks how Dodo works internally, where data lives, or how to extend the agent.",
    body: [
      "# Dodo internals reference",
      "",
      "Dodo runs on Cloudflare Workers with three Durable Objects:",
      "- **CodingAgent** — one per session. Owns the chat loop, workspace, and tool execution.",
      "- **UserControl** — one per user (`idFromName(email)`). Holds config, memory, skills, MCP setup.",
      "- **SharedIndex** — global singleton. Tracks users, host allowlist, models cache.",
      "",
      "## Storage",
      "- Per-DO SQLite holds structured data (config, sessions, skills, memory, tasks).",
      "- R2 (`WORKSPACE_BUCKET`) holds workspace file spill, attachments, and bundled skill assets.",
      "- No KV, no D1.",
      "",
      "## Agentic loop",
      "- Lives in `src/coding-agent.ts:onChatMessage()`. Runs `streamText({ maxSteps: 1 })` per iteration.",
      "- Per iteration: detect doom loops (same tool+args 3×), check token budget, trigger compaction at 50%.",
      "- System prompt assembled by `getSystemPrompt()` at the same file.",
      "",
      "## Subagents",
      "- `explore` — read-only search subagent. Uses cheaper model (default Haiku 4.5).",
      "- `task` — read+write subagent for delegated work.",
      "- Two modes: `inprocess` (blocking generateText in parent) or `facet` (separate DO peer).",
      "",
      "## Skills",
      "- Three sources: personal (UserControl SQLite), workspace (`.claude/skills/`, `.opencode/skill/`, etc.), built-in (this file).",
      "- Two-stage progressive disclosure: name + description in system prompt, full body via the `skill` tool.",
    ].join("\n"),
  },
  {
    name: "skill-authoring",
    description:
      "How to write a SKILL.md file that loads in Dodo, Claude Code, and OpenCode. Use when asked to create a new skill, document a workflow as a skill, or convert existing instructions into the SKILL.md format.",
    body: [
      "# Authoring SKILL.md",
      "",
      "Skills are markdown files with YAML frontmatter. The format is identical across Dodo, Claude Code, and OpenCode — write once, run everywhere.",
      "",
      "## Required frontmatter",
      "```yaml",
      "---",
      "name: my-skill                # lowercase, hyphens or underscores, max 64 chars",
      "description: One-sentence description that says WHAT and WHEN to use this skill.",
      "---",
      "```",
      "",
      "The `description` is the only thing the model sees at startup — write it like a tool description. Include both *what* the skill does and *when* to invoke it. Max 1024 characters.",
      "",
      "## Body conventions",
      "- Markdown after the frontmatter is the skill body. Loaded on demand by the `skill` tool.",
      "- Reference bundled files by relative path: e.g. `see references/typescript/errors.md`.",
      "- Keep bodies focused — under 32 KB. Larger content goes in `references/`.",
      "",
      "## Bundled resources",
      "Optional sibling directories next to SKILL.md:",
      "- `references/` — lazy-loaded reference docs",
      "- `scripts/` — executable helpers",
      "- `assets/` — static templates (HTML, SVG)",
      "",
      "Bundled files are *listed* by the `skill` tool but never auto-loaded. The model decides what to read.",
      "",
      "## Storing in Dodo",
      "Three places a skill can live:",
      "1. **Personal** (recommended for everyday skills) — created via the `skill_write` MCP tool, stored in UserControl DO.",
      "2. **Workspace** — drop a `.dodo/skills/<name>/SKILL.md` (or `.claude/skills/...`, `.opencode/skill/...`) into the cloned repo.",
      "3. **Built-in** — extend `src/builtin-skills.ts` and rebuild Dodo.",
    ].join("\n"),
  },
];

export function listBuiltinSkills(): Skill[] {
  return BUILTIN_SKILLS.map((entry) => ({
    name: entry.name,
    description: entry.description,
    body: entry.body,
    source: "builtin" as const,
    location: `builtin://${entry.name}`,
    assetPaths: [],
    enabled: true,
  }));
}
