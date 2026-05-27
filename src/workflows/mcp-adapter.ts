/**
 * Adapter that wires the typed workflow contracts in `src/workflows/`
 * to the existing helpers in `mcp.ts`.
 *
 * The workflows themselves are decoupled from mcp.ts — they receive a
 * `deps` bag containing only the function shapes they need. This file
 * builds that bag from mcp.ts's module-scope helpers and exposes a
 * single `dispatchWorkflow(...)` entry point the tool handlers call.
 *
 * Why a separate file: the workflow modules can't import from mcp.ts
 * directly without circular dependencies. The adapter sits between
 * them, owning the deps mapping.
 *
 * Lifecycle events emit through the session's event stream when the
 * `emitEvent` dep is wired. Today the adapter logs to the structured
 * logger; the proper wire-up to `/session/:id/events` is a follow-up
 * inside the same Steal #2 scope and lives below the workflow
 * contract layer so no consumer changes when it lands.
 */
import type { Workflow, WorkflowContext, WorkflowEvent } from "../workflow";
import { runWorkflow } from "../workflow";
import type { Env } from "../types";
import { log } from "../logger";

/**
 * Default event sink — logs through the structured logger so workflow
 * runs are observable in Workers Observability today, even before the
 * SSE wire-up lands.
 */
function defaultEventSink(event: WorkflowEvent): void {
  if (event.kind === "run_start") {
    log("info", `workflow.${event.workflow}.start`, { runId: event.runId, at: event.at });
  } else if (event.kind === "run_end") {
    log(event.ok ? "info" : "error", `workflow.${event.workflow}.end`, {
      runId: event.runId,
      at: event.at,
      ok: event.ok,
      error: event.error,
    });
  } else {
    log("info", `workflow.${event.workflow}.step`, {
      runId: event.runId,
      at: event.at,
      step: event.name,
      data: event.data,
    });
  }
}

/**
 * Run a workflow against a payload. The adapter assigns a fresh runId,
 * routes lifecycle events through the configured sink, and returns the
 * validated result.
 *
 * The `runId` returned here is the workflow's own identifier — separate
 * from the legacy `worker_run.id` written to the DB. The workflow body
 * persists the legacy row via its own deps; the new runId is what the
 * `/api/workflows/runs` route exposes once that route is wired.
 */
export async function dispatchWorkflow<TPayload, TResult>(input: {
  workflow: Workflow<TPayload, TResult>;
  payload: unknown;
  sessionId: string;
  env?: Env;
  emit?: (event: WorkflowEvent) => void;
  signal?: AbortSignal;
}): Promise<{ runId: string; result: TResult; durationMs: number }> {
  const runId = crypto.randomUUID();
  const ctx: Omit<WorkflowContext<TPayload>, "payload"> = {
    runId,
    sessionId: input.sessionId,
    signal: input.signal,
    emit: input.emit ?? defaultEventSink,
  };
  return runWorkflow(input.workflow, input.payload, ctx);
}
