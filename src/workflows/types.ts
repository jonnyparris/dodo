/**
 * Shared payload/result types for the built-in workflows.
 *
 * Lives separate from each workflow file so the index.ts MCP handlers
 * can reference the result types without pulling in the workflow
 * runtime dependencies (workspace ops, fetch helpers, etc.).
 */
import { z } from "zod";

/** Shared shape for `dispatch_repo_prompt` and `run_repo_edits`. */
export const RepoWorkflowPayloadBase = z.object({
  repoId: z.string().min(1),
  title: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().default("main"),
  commitMessage: z.string().min(1),
  expectedFiles: z.array(z.string()).default([]),
});

export const RepoPromptPayload = RepoWorkflowPayloadBase.extend({
  prompt: z.string().min(1),
  verifyWorkflow: z.string().min(1).nullable().optional(),
});
export type RepoPromptPayload = z.infer<typeof RepoPromptPayload>;

export const RepoEditsPayload = RepoWorkflowPayloadBase.extend({
  edits: z
    .array(
      z.object({
        path: z.string().min(1),
        search: z.string().min(1),
        replacement: z.string(),
      }),
    )
    .min(1),
});
export type RepoEditsPayload = z.infer<typeof RepoEditsPayload>;

export const VerifyRunPayload = z.object({
  runId: z.string().min(1),
});
export type VerifyRunPayload = z.infer<typeof VerifyRunPayload>;

/**
 * Common terminal-state result for the repo workflows. The dispatch /
 * edits workflows return this directly; verify-run wraps it with the
 * verify-gate outcome.
 *
 * `verification` carries the git-side verify-branch payload (changed
 * files, remote sha, etc.). `prUrl` is set when the workflow opens a
 * draft PR. `failureSnapshotId` is set when a workflow body throws
 * and the runner captures a snapshot for human triage.
 */
export const WorkflowRunResult = z.object({
  sessionId: z.string().min(1),
  status: z.enum(["done", "running", "failed"]),
  prUrl: z.string().nullable().optional(),
  verification: z.record(z.string(), z.unknown()).nullable().optional(),
  verifyWorkflowRunId: z.string().nullable().optional(),
  verifyWorkflowHtmlUrl: z.string().nullable().optional(),
  failureSnapshotId: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});
export type WorkflowRunResult = z.infer<typeof WorkflowRunResult>;
