/**
 * Static catalog of orchestrator tools, surfaced to:
 *  - the UI (`GET /api/tool-catalog`) so users can see what their agent
 *    can do without reading the system prompt
 *  - documentation generators (future)
 *
 * This is a **descriptive** catalog, not the source of truth for actual
 * tool registration — that lives in `src/agentic.ts` where each tool is
 * wired with its full schema.
 *
 * **Drift is enforced by tests** (`test/tool-catalog-unit.test.ts`):
 *  - every catalog entry whose `alwaysOn` is true MUST appear in
 *    `getKnownTopLevelToolNames()` (agentic.ts), and vice versa.
 *  - codemode-namespace entries (caveat `"codemode-only"`) MUST appear in
 *    `KNOWN_CODEMODE_GIT_TOOLS` (agentic.ts).
 *  - if the assertion trips, update this file or agentic.ts so the two
 *    agree. The catalog is the user-facing surface; agentic.ts is the
 *    real one — the test ensures they describe the same world.
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
    | "skill"
    | "browser";
  /** True when the tool is always registered at the top level for the
   *  orchestrator. False for tools gated on env/config (browser, codemode)
   *  or only reachable via codemode's `git.*` provider. */
  alwaysOn: boolean;
  /** Optional human-friendly note on when *not* to use this tool, or how
   *  it's actually reachable. */
  caveat?: string;
}

/** Caveat string applied to git tools that are not registered top-level —
 *  they only exist inside codemode as `git.<name>`. The drift test pivots
 *  on this exact string, keep them in sync. */
export const CODEMODE_GIT_CAVEAT =
  "Codemode-only: call via git.<name> from inside a codemode block.";

const ORCHESTRATOR_TOOLS: ToolCatalogEntry[] = [
  // Subagents (cheap, run-often)
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
  // File ops — `list` and `find` are stripped from the top-level set in
  // agentic.ts (they fill the context window with raw listings). They are
  // available inside the `explore` subagent, surfaced separately below in
  // the (read-only) docs comment if we ever add a subagent panel.
  { name: "read", description: "Read file contents with line offsets.", category: "files", alwaysOn: true },
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
    caveat: "Requires the LOADER binding (codemode) to be configured.",
  },
  {
    name: "typecheck",
    description: "Run TypeScript `tsc --noEmit` against the workspace and return diagnostics.",
    category: "execution",
    alwaysOn: true,
  },
  {
    name: "shell",
    description:
      "Run busybox shell commands against the session workspace — pipes, redirection, coreutils.",
    category: "execution",
    alwaysOn: true,
  },
  // Browser tools — gated on BROWSER + LOADER bindings, session-enabled
  // browser config, and admin owner. Listed so users know they exist even
  // when their current session has them off.
  {
    name: "browser_search",
    description: "Search Chrome DevTools Protocol command/event specs.",
    category: "browser",
    alwaysOn: false,
    caveat: "Requires browser bindings, session browser config, and admin owner.",
  },
  {
    name: "browser_execute",
    description: "Run Chrome DevTools Protocol commands against a headless browser session.",
    category: "browser",
    alwaysOn: false,
    caveat: "Requires browser bindings, session browser config, and admin owner.",
  },
  // Git — only the hot-path quartet is top-level. Everything else is
  // reachable inside codemode via the `git.*` provider namespace; flagged
  // with CODEMODE_GIT_CAVEAT so the UI dims them and the drift test can
  // confirm they map to KNOWN_CODEMODE_GIT_TOOLS in agentic.ts.
  { name: "git_status", description: "Show working tree status.", category: "git", alwaysOn: true },
  { name: "git_add", description: "Stage files.", category: "git", alwaysOn: true },
  { name: "git_commit", description: "Commit staged changes.", category: "git", alwaysOn: true },
  { name: "git_diff", description: "Show diff of working tree.", category: "git", alwaysOn: true },
  { name: "git_clone", description: "Clone a git repo into the session workspace.", category: "git", alwaysOn: false, caveat: CODEMODE_GIT_CAVEAT },
  { name: "git_clone_known", description: "Clone one of the built-in known repos by id.", category: "git", alwaysOn: false, caveat: CODEMODE_GIT_CAVEAT },
  { name: "git_push", description: "Push commits to remote.", category: "git", alwaysOn: false, caveat: CODEMODE_GIT_CAVEAT },
  { name: "git_push_checked", description: "Push with extra remote-state checks (no clobber).", category: "git", alwaysOn: false, caveat: CODEMODE_GIT_CAVEAT },
  { name: "git_pull", description: "Pull from remote.", category: "git", alwaysOn: false, caveat: CODEMODE_GIT_CAVEAT },
  { name: "git_branch", description: "List or create branches.", category: "git", alwaysOn: false, caveat: CODEMODE_GIT_CAVEAT },
  { name: "git_checkout", description: "Switch branches.", category: "git", alwaysOn: false, caveat: CODEMODE_GIT_CAVEAT },
  { name: "git_log", description: "Show recent commits.", category: "git", alwaysOn: false, caveat: CODEMODE_GIT_CAVEAT },
  { name: "git_verify_remote_branch", description: "Verify a branch was pushed and is ahead of base.", category: "git", alwaysOn: false, caveat: CODEMODE_GIT_CAVEAT },
  { name: "pr_create", description: "Open a draft PR on GitHub for the pushed branch.", category: "git", alwaysOn: false, caveat: CODEMODE_GIT_CAVEAT },
];

export function getOrchestratorToolCatalog(): ToolCatalogEntry[] {
  return ORCHESTRATOR_TOOLS;
}
