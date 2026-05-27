/**
 * `verify-run` workflow — finalise a previously-dispatched
 * `repo-prompt` run by polling its worker prompt, verifying the
 * remote branch, optionally running a GitHub Actions verify gate,
 * and opening a draft PR.
 *
 * This is the most stateful of the three workflows because it has
 * multiple terminal states surfaced as `running` (the caller polls
 * back): the worker prompt may still be in flight, or the verify
 * gate is still queued, or the run is fully done. The result schema
 * captures whichever terminal state the call reached.
 *
 * As with the other workflows in this module, the implementation
 * keeps its dependencies on mcp.ts's existing helpers via the `deps`
 * argument so the diff stays small.
 */
import { z } from "zod";
import type { Workflow, WorkflowContext } from "../workflow";
import { VerifyRunPayload, WorkflowRunResult } from "./types";

/**
 * Subset of the legacy `WorkerRunRecord` shape the workflow needs to
 * read. Kept here as a structural type to avoid coupling this module
 * to the full DB-row shape — only the fields the workflow body
 * actually inspects.
 */
export interface WorkerRunSnapshot {
  id: string;
  sessionId: string;
  status: string;
  strategy: "deterministic" | "agent";
  baseBranch: string;
  branch: string;
  repoDir: string;
  expectedFiles: string[];
  verification: Record<string, unknown> | null;
  verifyWorkflow: string | null;
  verifyWorkflowRunId: string | null;
  verifyWorkflowHtmlUrl: string | null;
  prUrl: string | null;
}

/**
 * Helpers the verify-run workflow needs. The shape is bigger than the
 * other two workflows' deps because verify-run reaches into git
 * verify-branch, GitHub Actions triggers, PR creation, and run-state
 * polling — every one of those is a real I/O effect we don't want to
 * inline here.
 */
export interface VerifyRunDeps {
  /** Fetch the current run record (the workflow polls this). */
  getRun(id: string): Promise<WorkerRunSnapshot>;
  updateRun(
    id: string,
    patch: {
      status?: string;
      verification?: Record<string, unknown> | null;
      verifyWorkflowRunId?: string | null;
      verifyWorkflowHtmlUrl?: string | null;
      prUrl?: string | null;
      failureSnapshotId?: string | null;
      lastError?: string | null;
    },
  ): Promise<WorkerRunSnapshot>;
  /** List the recent prompts for the worker session. */
  listSessionPrompts(sessionId: string): Promise<Array<{ error: string | null; status: string }>>;
  /** Run git verify-branch and return the structured outcome. */
  verifyBranch(input: {
    sessionId: string;
    repoDir: string;
    baseRef: string;
    ref: string;
    expectedFiles: string[];
  }): Promise<Record<string, unknown>>;
  /** Trigger the GitHub Actions verify gate; null if it couldn't fire. */
  triggerVerifyWorkflow(run: WorkerRunSnapshot): Promise<{ runId: string; htmlUrl: string } | null>;
  /** Poll the verify gate; null while still in-flight. */
  pollVerifyWorkflow(
    run: WorkerRunSnapshot,
  ): Promise<{ conclusion: "success" | "failure" | "timed_out"; htmlUrl: string } | null>;
  /** Create the draft PR. Returns null when the PR couldn't be opened. */
  createDraftPr(run: WorkerRunSnapshot): Promise<string | null>;
  /** Capture a failure snapshot for triage. Returns its id. */
  captureFailure(input: {
    runId: string;
    sessionId: string;
    repoDir: string;
  }): Promise<{ id: string }>;
  /** Hard cap for the verify-gate poll. */
  verifyGateTimeoutMs: number;
}

export function makeVerifyRunWorkflow(deps: VerifyRunDeps): Workflow<
  z.infer<typeof VerifyRunPayload>,
  z.infer<typeof WorkflowRunResult>
> {
  return {
    name: "verify-run",
    description:
      "Verify a tracked worker run. For prompt-based runs, waits for prompt completion, verifies the remote branch, optionally runs a GitHub Actions verify workflow (typecheck/tests), then opens a draft PR and marks the run done.",
    payloadSchema: VerifyRunPayload,
    resultSchema: WorkflowRunResult,
    async run(ctx: WorkflowContext<z.infer<typeof VerifyRunPayload>>) {
      const run = await deps.getRun(ctx.payload.runId);

      // Deterministic runs are already finalised by repo-edits — bail
      // out fast so verify-run is safe to call as a unified entry
      // point for any run id.
      if (run.strategy === "deterministic" && run.status === "done") {
        return {
          sessionId: run.sessionId,
          status: "done",
          verification: run.verification,
          prUrl: run.prUrl,
        };
      }

      try {
        // Resume an in-flight verify-gate poll. The caller is expected
        // to call verify-run again on a `running` result; that's the
        // polling contract.
        if (run.status === "checks_running" && run.verifyWorkflowRunId) {
          return await pollAndFinalize(run, deps);
        }
        if (run.status === "checks_passed") {
          return {
            sessionId: run.sessionId,
            status: "done",
            verification: run.verification,
            prUrl: run.prUrl,
          };
        }

        const prompts = await deps.listSessionPrompts(run.sessionId);
        const active = prompts[0];
        if (!active || active.status === "queued" || active.status === "running") {
          return {
            sessionId: run.sessionId,
            status: "running",
          };
        }
        if (active.status === "failed" || active.status === "aborted") {
          const failure = await deps.captureFailure({
            runId: run.id,
            sessionId: run.sessionId,
            repoDir: run.repoDir,
          });
          const message = active.error ?? `Worker prompt ${active.status}`;
          await deps.updateRun(run.id, {
            failureSnapshotId: failure.id,
            lastError: message,
            status: "failed",
          });
          return {
            sessionId: run.sessionId,
            status: "failed",
            failureSnapshotId: failure.id,
            error: message,
          };
        }

        const verification = await deps.verifyBranch({
          sessionId: run.sessionId,
          repoDir: run.repoDir,
          baseRef: run.baseBranch,
          ref: run.branch,
          expectedFiles: run.expectedFiles,
        });

        if (run.verifyWorkflow) {
          const triggered = await deps.triggerVerifyWorkflow(run);
          if (!triggered) {
            const afterVerify = await deps.updateRun(run.id, {
              status: "done",
              verification: {
                ...verification,
                verifyGate: { triggered: false, reason: "workflow_dispatch failed or missing token" },
              },
            });
            return await finalizePr(afterVerify, deps);
          }
          const afterTrigger = await deps.updateRun(run.id, {
            status: "checks_running",
            verification: {
              ...verification,
              verifyGate: {
                startedAt: new Date().toISOString(),
                workflow: run.verifyWorkflow,
                runId: triggered.runId,
                htmlUrl: triggered.htmlUrl,
              },
            },
            verifyWorkflowRunId: triggered.runId,
            verifyWorkflowHtmlUrl: triggered.htmlUrl,
          });
          return {
            sessionId: afterTrigger.sessionId,
            status: "running",
            verification: afterTrigger.verification,
            verifyWorkflowRunId: triggered.runId,
            verifyWorkflowHtmlUrl: triggered.htmlUrl,
          };
        }

        const updated = await deps.updateRun(run.id, { status: "done", verification });
        return await finalizePr(updated, deps);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failure = await deps.captureFailure({
          runId: run.id,
          sessionId: run.sessionId,
          repoDir: run.repoDir,
        });
        await deps.updateRun(run.id, {
          failureSnapshotId: failure.id,
          lastError: message,
          status: "failed",
        });
        return {
          sessionId: run.sessionId,
          status: "failed",
          failureSnapshotId: failure.id,
          error: message,
        };
      }
    },
  };
}

/**
 * Open the draft PR if the run reached `done` without one already
 * recorded. PR creation failures are non-fatal — the run stays `done`
 * and the caller can retry.
 */
async function finalizePr(
  run: WorkerRunSnapshot,
  deps: Pick<VerifyRunDeps, "createDraftPr" | "updateRun">,
): Promise<z.infer<typeof WorkflowRunResult>> {
  if (run.prUrl) {
    return {
      sessionId: run.sessionId,
      status: "done",
      verification: run.verification,
      prUrl: run.prUrl,
    };
  }
  const prUrl = await deps.createDraftPr(run);
  if (prUrl) {
    const withPr = await deps.updateRun(run.id, { prUrl });
    return {
      sessionId: withPr.sessionId,
      status: "done",
      verification: withPr.verification,
      prUrl: withPr.prUrl,
    };
  }
  return {
    sessionId: run.sessionId,
    status: "done",
    verification: run.verification,
    prUrl: null,
  };
}

/**
 * Poll the in-flight verify gate. On success: mark `checks_passed`,
 * then open the PR. On failure: capture a snapshot and mark `failed`.
 * Still in flight: return `running` so the caller can poll again.
 */
async function pollAndFinalize(
  run: WorkerRunSnapshot,
  deps: VerifyRunDeps,
): Promise<z.infer<typeof WorkflowRunResult>> {
  const verification = (run.verification ?? {}) as Record<string, unknown>;
  const poll = await deps.pollVerifyWorkflow(run);

  if (!poll) {
    const gate = (run.verification ?? {}) as { verifyGate?: { startedAt?: string } };
    const startedAt = gate.verifyGate?.startedAt ? Date.parse(gate.verifyGate.startedAt) : NaN;
    if (Number.isFinite(startedAt) && Date.now() - startedAt > deps.verifyGateTimeoutMs) {
      const htmlUrl = run.verifyWorkflowHtmlUrl ?? null;
      const message = `Verify workflow timed out after ${Math.round(
        deps.verifyGateTimeoutMs / 60_000,
      )} minutes${htmlUrl ? ` — see ${htmlUrl}` : ""}`;
      const failure = await deps.captureFailure({
        runId: run.id,
        sessionId: run.sessionId,
        repoDir: run.repoDir,
      });
      await deps.updateRun(run.id, {
        status: "failed",
        failureSnapshotId: failure.id,
        lastError: message,
        verification: {
          ...verification,
          verifyGate: {
            ...(verification.verifyGate as Record<string, unknown> | undefined),
            conclusion: "timed_out",
            htmlUrl,
            timedOutAt: new Date().toISOString(),
          },
        },
      });
      return {
        sessionId: run.sessionId,
        status: "failed",
        failureSnapshotId: failure.id,
        error: message,
        verifyWorkflowHtmlUrl: htmlUrl,
      };
    }
    return {
      sessionId: run.sessionId,
      status: "running",
      verifyWorkflowRunId: run.verifyWorkflowRunId,
      verifyWorkflowHtmlUrl: run.verifyWorkflowHtmlUrl,
    };
  }

  if (poll.conclusion === "success") {
    const passed = await deps.updateRun(run.id, {
      status: "checks_passed",
      verification: {
        ...verification,
        verifyGate: {
          ...(verification.verifyGate as Record<string, unknown> | undefined),
          conclusion: "success",
          htmlUrl: poll.htmlUrl,
          completedAt: new Date().toISOString(),
        },
      },
    });
    return await finalizePr(passed, deps);
  }

  // Failure or timed_out from the workflow itself.
  const failure = await deps.captureFailure({
    runId: run.id,
    sessionId: run.sessionId,
    repoDir: run.repoDir,
  });
  const message = `Verify workflow conclusion: ${poll.conclusion}${poll.htmlUrl ? ` — see ${poll.htmlUrl}` : ""}`;
  await deps.updateRun(run.id, {
    status: "failed",
    failureSnapshotId: failure.id,
    lastError: message,
    verification: {
      ...verification,
      verifyGate: {
        ...(verification.verifyGate as Record<string, unknown> | undefined),
        conclusion: poll.conclusion,
        htmlUrl: poll.htmlUrl,
        completedAt: new Date().toISOString(),
      },
    },
  });
  return {
    sessionId: run.sessionId,
    status: "failed",
    failureSnapshotId: failure.id,
    error: message,
    verifyWorkflowHtmlUrl: poll.htmlUrl,
  };
}
