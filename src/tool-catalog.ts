/**
 * Static catalog of orchestrator tools, surfaced to:
 *  - the UI (`GET /api/tool-catalog`) so users can see what their agent
 *    can do without reading the system prompt
 *  - documentation generators (future)
 *
 * This is a **descriptive** catalog, not the source of truth for actual
 * tool registration — that lives in `src/agentic.ts` where each tool is
 * wired with its full schema. Keep this list in sync when adding/removing
 * tools. The cost of drift is small: the UI section under-promises if a
 * tool was added without updating here, and over-promises if a tool was
 * removed. A unit test (`test/tool-catalog-unit.test.ts`) checks that
 * every catalog entry has a matching tool name registered in the system
 * prompt's tool table.
 */
export interface ToolCatalogEntry {
  /** Stable tool id used by the model. */
  name: string;
  /** One-line description for the UI. */
  description: string;
  /** Coarse grouping for UI sectioning. */
  category:
    | "discovery"
    | "files"
    | "edit"
    | "planning"
    | "git"
    | "execution"
    | "subagent"
    | "skill";
  /** True when the tool is always available regardless of session
   *  configuration. False for tools gated on env/config (e.g. browser). */
  alwaysOn: boolean;
  /** Optional human-friendly note on when *not* to use this tool. */
  caveat?: string;
}

const ORCHESTRATOR_TOOLS: ToolCatalogEntry[] = [
  // Discovery (cheap, run-often)
  {
    name: "explore",
    description:
      "Search agent for codebase discovery — returns a compact summary in a separate context window.",
    category: "subagent",
    alwaysOn: true,
    caveat:
      "Falls back to direct read/grep when the subagent is unavailable.",
  },
  {
    name: "task",
    description:
      "Delegate a bounded sub-task to a fresh subagent with read+write workspace tools.",
    category: "subagent",
    alwaysOn: true,
  },
  // File ops
  { name: "read", description: "Read file contents with line offsets.", category: "files", alwaysOn: true },
  { name: "list", description: "List directory entries.", category: "files", alwaysOn: true },
  { name: "find", description: "Find files by glob.", category: "files", alwaysOn: true },
  { name: "grep", description: "Search file contents by regex.", category: "files", alwaysOn: true },
  { name: "write", description: "Create or overwrite a file.", category: "edit", alwaysOn: true },
  { name: "edit", description: "Find-and-replace a unique snippet in one file.", category: "edit", alwaysOn: true },
  { name: "replace_all", description: "Replace all occurrences of a string in one file.", category: "edit", alwaysOn: true },
  { name: "delete", description: "Remove a file or directory.", category: "edit", alwaysOn: true },
  // Planning
  { name: "todo_list", description: "List session todos.", category: "planning", alwaysOn: true },
  { name: "todo_add", description: "Append a todo.", category: "planning", alwaysOn: true },
  { name: "todo_update", description: "Update a todo's status, content, or priority.", category: "planning", alwaysOn: true },
  { name: "todo_clear", description: "Clear all todos.", category: "planning", alwaysOn: true },
  // Skill loader
  {
    name: "skill",
    description: "Load a SKILL.md by name to inject its instructions and assets.",
    category: "skill",
    alwaysOn: true,
  },
  // Code execution / typecheck
  {
    name: "codemode",
    description:
      "Execute JavaScript in a sandboxed dynamic worker against the session workspace.",
    category: "execution",
    alwaysOn: false,
    caveat: "Requires codemode bindings to be configured.",
  },
  {
    name: "typecheck",
    description: "Run TypeScript `tsc --noEmit` against the workspace and return diagnostics.",
    category: "execution",
    alwaysOn: true,
  },
  // Git
  { name: "git_clone", description: "Clone a git repo into the session workspace.", category: "git", alwaysOn: true },
  { name: "git_clone_known", description: "Clone one of the built-in known repos by id.", category: "git", alwaysOn: true },
  { name: "git_status", description: "Show working tree status.", category: "git", alwaysOn: true },
  { name: "git_add", description: "Stage files.", category: "git", alwaysOn: true },
  { name: "git_commit", description: "Commit staged changes.", category: "git", alwaysOn: true },
  { name: "git_push", description: "Push commits to remote.", category: "git", alwaysOn: true },
  { name: "git_push_checked", description: "Push with extra remote-state checks (no clobber).", category: "git", alwaysOn: true },
  { name: "git_pull", description: "Pull from remote.", category: "git", alwaysOn: true },
  { name: "git_branch", description: "List or create branches.", category: "git", alwaysOn: true },
  { name: "git_checkout", description: "Switch branches.", category: "git", alwaysOn: true },
  { name: "git_diff", description: "Show diff of working tree.", category: "git", alwaysOn: true },
  { name: "git_log", description: "Show recent commits.", category: "git", alwaysOn: true },
  { name: "git_verify_remote_branch", description: "Verify a branch was pushed and is ahead of base.", category: "git", alwaysOn: true },
  { name: "pr_create", description: "Open a draft PR on GitHub for the pushed branch.", category: "git", alwaysOn: true },
];

const SUBAGENT_TOOLS: ToolCatalogEntry[] = [
  // explore subagent surface — read-only
  { name: "read", description: "Read file contents.", category: "files", alwaysOn: true },
  { name: "list", description: "List directory entries.", category: "files", alwaysOn: true },
  { name: "find", description: "Find files by glob.", category: "files", alwaysOn: true },
  { name: "grep", description: "Search file contents by regex.", category: "files", alwaysOn: true },
];

export function getOrchestratorToolCatalog(): ToolCatalogEntry[] {
  return ORCHESTRATOR_TOOLS;
}

export function getSubagentToolCatalog(): ToolCatalogEntry[] {
  return SUBAGENT_TOOLS;
}
