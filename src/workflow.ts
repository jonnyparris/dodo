/**
 * Workflow contract — Steal #2 from the flue-inspired-steals plan
 * (memory/workload/plans/2026-05-27-dodo-flue-inspired-steals.md).
 *
 * A workflow is a finite, typed function that runs on top of a session
 * and returns a validated result. It owns its own lifecycle: state
 * machine, terminal states, result schema. The underlying CodingAgent
 * session is the *runtime substrate* (workspace, model, transcript);
 * the workflow is the *contract* on top of it.
 *
 * Why this is not a session subclass: a session is an addressable,
 * multi-turn, persistent thing — the user chats with it, pauses it,
 * resumes it. A workflow is a one-shot call. Wedging the two into one
 * abstraction (the band-aid `worker_runs` table) led to: status enums
 * leaking into routes, autopilot carrying lifecycle state in three
 * places, and the Cap'n Web RPC layer unable to expose a clean
 * "what's running right now?" shape.
 *
 * This module defines the bare contract. The three repo workflows
 * (`repo-prompt`, `repo-edits`, `verify-run`) live in `workflows/`
 * and consume this. Route handlers in `mcp.ts` become thin wrappers
 * around `runWorkflow(workflow, payload, ctx)`.
 */
import { z } from "zod";

/**
 * Per-workflow event surfaced on the session timeline. Routed through
 * the existing `/session/:id/events` SSE stream so the UI can show
 * workflow progress as a distinct timeline category, not as chat
 * messages.
 *
 * The shape is deliberately small — workflows that need rich event
 * payloads should emit `step` events with a structured `data` blob
 * rather than inventing new event types.
 */
export type WorkflowEvent =
  | { kind: "run_start"; runId: string; workflow: string; at: string }
  | { kind: "step"; runId: string; workflow: string; at: string; name: string; data?: Record<string, unknown> }
  | { kind: "run_end"; runId: string; workflow: string; at: string; ok: boolean; error?: string };

/**
 * Context the workflow runner hands to a workflow's `run()` body.
 *
 * The session handle is intentionally narrow — it exposes the bits
 * every workflow needs (workspace ops, model invocation, MCP fetch
 * helpers) without leaking the whole CodingAgent surface. Workflows
 * that need more should add the new RPC to the parent and surface it
 * through `SessionHandle`, not reach into the DO directly.
 */
export interface WorkflowContext<TPayload> {
  /** Stable id of this workflow run. Distinct from sessionId. */
  readonly runId: string;
  /** The validated payload. */
  readonly payload: TPayload;
  /** Session this workflow is running against. */
  readonly sessionId: string;
  /** Abort signal — wins over any internal timeouts. */
  readonly signal?: AbortSignal;
  /**
   * Emit a workflow lifecycle event. The runner forwards this to the
   * session's event stream; workflows themselves never need to know
   * who consumes the event.
   */
  emit(event: WorkflowEvent): void;
}

/**
 * A workflow contract. Implementations live in `src/workflows/`.
 *
 * `payloadSchema` and `resultSchema` are mandatory — the whole point
 * of the abstraction is to make the contract explicit. Untyped
 * workflows defeat the purpose.
 */
export interface Workflow<TPayload, TResult> {
  /** Stable name. Surfaces in events, run records, MCP tool descriptions. */
  readonly name: string;
  /** Human-readable description for tool catalogs. */
  readonly description: string;
  /** Validates the payload before `run` is called. */
  readonly payloadSchema: z.ZodType<TPayload>;
  /** Validates the result before it's persisted on the run record. */
  readonly resultSchema: z.ZodType<TResult>;
  /** The actual work. Receives a typed payload, returns a typed result. */
  run(ctx: WorkflowContext<TPayload>): Promise<TResult>;
}

/**
 * Run a workflow against a payload and context. Validates the payload,
 * invokes the workflow body, validates the result, and emits the
 * required lifecycle events. Returns the validated result alongside
 * the run id so the caller can persist both.
 *
 * Why this isn't a class method: the workflow IS the implementation,
 * the runner is just glue. Keeping the runner as a plain function
 * means callers can wrap it without subclassing.
 */
export async function runWorkflow<TPayload, TResult>(
  workflow: Workflow<TPayload, TResult>,
  payload: unknown,
  ctx: Omit<WorkflowContext<TPayload>, "payload">,
): Promise<{ runId: string; result: TResult; durationMs: number }> {
  const startedAt = Date.now();
  // Payload validation lives at the runner boundary, not inside each
  // workflow body. Bad payloads fail loud before any side effects.
  const validatedPayload = workflow.payloadSchema.parse(payload);

  ctx.emit({
    kind: "run_start",
    runId: ctx.runId,
    workflow: workflow.name,
    at: new Date(startedAt).toISOString(),
  });

  try {
    const result = await workflow.run({
      ...ctx,
      payload: validatedPayload,
    });
    // Result validation guards against a workflow body that drifts
    // away from its declared schema. We treat that as a bug in the
    // workflow, not a runtime case the caller has to handle — the
    // ZodError surfaces as a normal failure.
    const validatedResult = workflow.resultSchema.parse(result);
    ctx.emit({
      kind: "run_end",
      runId: ctx.runId,
      workflow: workflow.name,
      at: new Date().toISOString(),
      ok: true,
    });
    return {
      runId: ctx.runId,
      result: validatedResult,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.emit({
      kind: "run_end",
      runId: ctx.runId,
      workflow: workflow.name,
      at: new Date().toISOString(),
      ok: false,
      error: message,
    });
    throw error;
  }
}
