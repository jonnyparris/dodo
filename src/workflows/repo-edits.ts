/**
 * `repo-edits` workflow — deterministic text edits applied to a repo,
 * committed and pushed end-to-end.
 *
 * Today's `run_repo_edits` MCP tool wraps the implementation that
 * lived inline in mcp.ts. This module makes that the workflow
 * contract: payload validated, result typed, lifecycle events emitted.
 *
 * Implementation note: the workflow body still depends on a bag of
 * helpers that live in mcp.ts (`acquireRepoSession`, `prepareRepoBranch`,
 * `createWorkerRun`, …). Rather than relocate all of them in this
 * diff (which would balloon the change without changing behaviour),
 * the workflow takes a `deps` argument with the helpers it needs. The
 * MCP route handler in mcp.ts wires up the deps from its own locals
 * and calls `runWorkflow(workflow, payload, ctx)`.
 *
 * The contract is the win: payload schema, result schema, lifecycle
 * events all live at this layer. The helper plumbing is an
 * implementation detail of the wiring.
 */
import { z } from "zod";
import type { Workflow, WorkflowContext } from "../workflow";
import { RepoEditsPayload, WorkflowRunResult } from "./types";

/**
 * Helpers the workflow needs. Provided by the MCP route handler from
 * its own module-scope locals. Typed as opaque function shapes so this
 * module doesn't import from mcp.ts (which would be a circular dep).
 */
export interface RepoEditsDeps {
  /** Acquire a worker session with the repo cloned at baseBranch. */
  acquireRepoSession(input: {
    repoId: string;
    baseBranch: string;
    title: string;
  }): Promise<{ sessionId: string; viaCache: boolean; reason?: string }>;
  /** Persist the workflow-run row. Returns the assigned id. */
  createRun(input: {
    sessionId: string;
    repoId: string;
    branch: string;
    baseBranch: string;
    commitMessage: string;
    expectedFiles: string[];
    title: string;
  }): Promise<{ id: string }>;
  /** Update the run's status / verification. */
  updateRun(
    id: string,
    patch: {
      status?: string;
      verification?: Record<string, unknown> | null;
      failureSnapshotId?: string | null;
      lastError?: string | null;
    },
  ): Promise<void>;
  /** Prepare the branch (checkout base, force-create feature branch). */
  prepareRepoBranch(input: {
    sessionId: string;
    repoDir: string;
    branch: string;
    baseBranch: string;
  }): Promise<void>;
  /** Apply a single text edit via the session's /file?path= PATCH route. */
  applyEdit(input: {
    sessionId: string;
    path: string;
    search: string;
    replacement: string;
  }): Promise<void>;
  /** Read the session's git status. */
  gitStatus(input: { sessionId: string; repoDir: string }): Promise<{ entries: unknown[] }>;
  /** Stage a repo-relative path. */
  gitAdd(input: { sessionId: string; repoDir: string; filepath: string }): Promise<void>;
  /** Commit staged changes. */
  gitCommit(input: { sessionId: string; repoDir: string; message: string }): Promise<void>;
  /** Push the feature branch and verify the remote diff. */
  gitPushChecked(input: {
    sessionId: string;
    repoDir: string;
    baseRef: string;
    ref: string;
    expectedFiles: string[];
  }): Promise<Record<string, unknown>>;
  /** Resolve the repo descriptor (dir, url) by id. */
  getRepo(repoId: string): { dir: string; url: string };
  /** Capture a failure snapshot for triage. Returns its id. */
  captureFailure(input: {
    runId: string;
    sessionId: string;
    repoDir: string;
  }): Promise<{ id: string }>;
}

export function makeRepoEditsWorkflow(deps: RepoEditsDeps): Workflow<
  z.infer<typeof RepoEditsPayload>,
  z.infer<typeof WorkflowRunResult>
> {
  return {
    name: "repo-edits",
    description:
      "Run a deterministic repo task end-to-end: fork a seeded repo session, create a branch, apply text edits, commit, push, verify, and record state transitions.",
    payloadSchema: RepoEditsPayload,
    resultSchema: WorkflowRunResult,
    async run(ctx: WorkflowContext<z.infer<typeof RepoEditsPayload>>) {
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
        workflow: "repo-edits",
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
      });

      try {
        await deps.prepareRepoBranch({
          sessionId: acquired.sessionId,
          repoDir: repo.dir,
          branch: payload.branch,
          baseBranch: payload.baseBranch,
        });
        await deps.updateRun(run.id, { status: "branch_created" });

        for (const edit of payload.edits) {
          await deps.applyEdit({
            sessionId: acquired.sessionId,
            path: edit.path,
            search: edit.search,
            replacement: edit.replacement,
          });
        }
        await deps.updateRun(run.id, { status: "edit_applied" });

        const status = await deps.gitStatus({ sessionId: acquired.sessionId, repoDir: repo.dir });
        if (!Array.isArray(status.entries) || status.entries.length === 0) {
          throw new Error("No changed files detected after applying deterministic edits");
        }

        const repoPrefix = repo.dir.endsWith("/") ? repo.dir : `${repo.dir}/`;
        for (const file of Array.from(new Set(payload.edits.map((e) => e.path)))) {
          const relPath = file.startsWith(repoPrefix) ? file.slice(repoPrefix.length) : file;
          await deps.gitAdd({ sessionId: acquired.sessionId, repoDir: repo.dir, filepath: relPath });
        }

        await deps.gitCommit({
          sessionId: acquired.sessionId,
          repoDir: repo.dir,
          message: payload.commitMessage,
        });
        await deps.updateRun(run.id, { status: "commit_created" });

        const push = await deps.gitPushChecked({
          sessionId: acquired.sessionId,
          repoDir: repo.dir,
          baseRef: payload.baseBranch,
          ref: payload.branch,
          expectedFiles: payload.expectedFiles,
        });
        await deps.updateRun(run.id, { status: "done", verification: push });

        return {
          sessionId: acquired.sessionId,
          status: "done",
          verification: push,
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
