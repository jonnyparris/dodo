import { Agent } from "agents";
import type { Env } from "./types";

/**
 * TaskAgent — facet (sub-agent) for general read+write coding tasks that
 * need their own LLM turn budget and, optionally, a scratch workspace.
 *
 * Phase 1 scaffold: registers the class with the Agents SDK as a facet and
 * exposes a placeholder `task()` RPC. Phase 4 will port the body of
 * `buildTaskTool.execute` in `agentic.ts` into this class and add
 * `workspaceMode: "shared" | "scratch"` support plus a 24h cleanup alarm.
 *
 * Requires the `"experimental"` compatibility flag.
 */
export interface TaskInvokeOpts {
  /** Natural-language task description. */
  prompt: string;
  /** Optional path prefix restricting the workspace surface. */
  scope?: string;
  /** Optional per-call model override. */
  model?: string;
  /**
   * Workspace isolation mode.
   *
   * - `"shared"` (default): the facet reads+writes the parent session's
   *   workspace directly via a service binding from the parent.
   * - `"scratch"`: the facet gets its own ephemeral workspace rooted at
   *   `workspace/<sessionId>/scratch/<facetName>/`. Parent decides what
   *   (if anything) to merge back via `applyFromScratch()`.
   *
   * Phase 4 implements `"scratch"`; phase 1 only records the intent.
   */
  workspaceMode?: "shared" | "scratch";
}

export interface TaskInvokeResult {
  ok: true;
  facetName: string;
}

export class TaskAgent extends Agent<Env> {
  /**
   * Run a task. Phase 1 returns a placeholder so the RPC surface is wired
   * end-to-end before any behaviour moves. Phase 4 replaces this body.
   */
  async task(opts: TaskInvokeOpts): Promise<TaskInvokeResult> {
    void opts.prompt;
    void opts.scope;
    void opts.model;
    void opts.workspaceMode;

    return {
      ok: true,
      facetName: this.name,
    };
  }
}
