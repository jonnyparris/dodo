/**
 * `repo-prompt` workflow — dispatch a complex repo task to a worker
 * session that an LLM drives end-to-end.
 *
 * Mirrors `repo-edits` but the "do the work" step is one prompt sent
 * to the worker session, not a deterministic edit list. Result is
 * `running` (the prompt is in flight) — `verify-run` is the workflow
 * the caller invokes later to finalise.
 *
 * Implementation detail: like `repo-edits`, this module declares the
 * contract and takes a `deps` argument with the helpers the MCP route
 * handler already maintains, so the diff stays small while the
 * contract surfaces at the new layer.
 */
import { z } from "zod";
import type { Workflow, WorkflowContext } from "../workflow";
import { RepoPromptPayload, WorkflowRunResult } from "./types";

export interface RepoPromptDeps {
  acquireRepoSession(input: {
    repoId: string;
    baseBranch: string;
    title: string;
  }): Promise<{ sessionId: string; viaCache: boolean; reason?: string }>;
  createRun(input: {
    sessionId: string;
    repoId: string;
    branch: string;
    baseBranch: string;
    commitMessage: string;
    expectedFiles: string[];
    title: string;
    verifyWorkflow: string | null;
  }): Promise<{ id: string }>;
  updateRun(
    id: string,
    patch: {
      status?: string;
      failureSnapshotId?: string | null;
      lastError?: string | null;
    },
  ): Promise<void>;
  prepareRepoBranch(input: {
    sessionId: string;
    repoDir: string;
    branch: string;
    baseBranch: string;
  }): Promise<void>;
  /** Send the assembled prompt to the worker session's /prompt route. */
  dispatchPrompt(input: { sessionId: string; content: string }): Promise<Record<string, unknown>>;
  getRepo(repoId: string): { dir: string; url: string };
  captureFailure(input: {
    runId: string;
    sessionId: string;
    repoDir: string;
  }): Promise<{ id: string }>;
}

export function makeRepoPromptWorkflow(deps: RepoPromptDeps): Workflow<
  z.infer<typeof RepoPromptPayload>,
  z.infer<typeof WorkflowRunResult>
> {
  return {
    name: "repo-prompt",
    description:
      "Dispatch a complex repo task to a worker session using a seeded repo fork, with tracked worker state and later branch verification.",
    payloadSchema: RepoPromptPayload,
    resultSchema: WorkflowRunResult,
    async run(ctx: WorkflowContext<z.infer<typeof RepoPromptPayload>>) {
      const { payload } = ctx;
      const repo = deps.getRepo(payload.repoId);

      const acquired = await deps.acquireRepoSession({
        repoId: payload.repoId,
        baseBranch: payload.baseBranch,
        title: payload.title,
      });
      ctx.emit({
        kind: "step",
        runId: ctx.runId,
        workflow: "repo-prompt",
        at: new Date().toISOString(),
        name: "session-acquired",
        data: { sessionId: acquired.sessionId, viaCache: acquired.viaCache, reason: acquired.reason },
      });

      const run = await deps.createRun({
        sessionId: acquired.sessionId,
        repoId: payload.repoId,
        branch: payload.branch,
        baseBranch: payload.baseBranch,
        commitMessage: payload.commitMessage,
        expectedFiles: payload.expectedFiles,
        title: payload.title,
        verifyWorkflow: payload.verifyWorkflow ?? null,
      });

      try {
        await deps.prepareRepoBranch({
          sessionId: acquired.sessionId,
          repoDir: repo.dir,
          branch: payload.branch,
          baseBranch: payload.baseBranch,
        });
        await deps.updateRun(run.id, { status: "branch_created" });

        const content = [
          `Repository is already cloned at ${repo.dir}.`,
          `You are on the ${payload.baseBranch} branch. Push to remote branch '${payload.branch}' when done.`,
          `Do not clone again. Do not change branch names.`,
          `Do NOT run git_pull or git_fetch — the clone is singleBranch+shallow. The repository is already on the correct branch.`,
          `Use commit message: ${payload.commitMessage}`,
          `Push with git_push_checked and ref set to '${payload.branch}'.`,
          `Use the in-isolate \`typecheck\` tool to verify TypeScript compiles before pushing — it runs \`tsc --noEmit\` against the workspace and returns structured diagnostics. \`npm test\` and \`npm install\` are still unavailable; the dispatching system will run them externally if a verify workflow is configured.`,
          payload.prompt,
        ].join("\n\n");

        await deps.dispatchPrompt({ sessionId: acquired.sessionId, content });
        await deps.updateRun(run.id, { status: "prompt_running" });

        return {
          sessionId: acquired.sessionId,
          status: "running",
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failure = await deps.captureFailure({
          runId: run.id,
          sessionId: acquired.sessionId,
          repoDir: repo.dir,
        });
        await deps.updateRun(run.id, {
          failureSnapshotId: failure.id,
          lastError: message,
          status: "failed",
        });
        return {
          sessionId: acquired.sessionId,
          status: "failed",
          failureSnapshotId: failure.id,
          error: message,
        };
      }
    },
  };
}
