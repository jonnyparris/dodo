/**
 * Named registry of result schemas a tool / subagent can demand.
 *
 * Why a registry rather than letting callers (the LLM in particular)
 * pass an inline schema:
 *
 * - LLMs cannot reliably emit a valid Zod / Standard Schema literal.
 *   Letting the model choose a schema means accepting that it will
 *   occasionally pass garbage, then having to validate the *schema*
 *   before validating the *output*. Two layers of validation, two
 *   classes of failure mode.
 * - The registry doubles as documentation: every schema lives in one
 *   file with a docstring explaining what shape the caller will get
 *   back. Tool descriptions can reference the name and the orchestrator
 *   model can pick from a closed list.
 * - Adding a new schema is a one-line edit. Removing or renaming one
 *   is a typed change — every consumer's TypeScript breaks.
 *
 * Profiles declare a `defaultResultSchemaName` here, and the `task`
 * tool exposes a `resultSchemaName` arg that the orchestrator can set
 * to any registered name.
 */
import { z } from "zod";

/**
 * Verify-run summary — produced by the verify-run workflow's final
 * pass and (once Steal #2 lands) returned as the workflow's typed
 * result. Today the autopilot worker reads it as a tool call result.
 *
 * Fields:
 * - `passed`   — whether the verify run met its bar. The caller
 *                gates merges / status updates on this single bit.
 * - `failures` — short bullet list of what failed. Empty when `passed`.
 * - `notes`    — free-form narrative, max ~500 chars. Stays optional
 *                so tools that produce a clean pass don't have to
 *                fabricate one.
 */
export const VerifyRunSummary = z.object({
  passed: z.boolean().describe("True when every check in the verify run met its bar."),
  failures: z.array(z.string()).describe(
    "One-line bullet per failure. Empty array when passed=true.",
  ),
  notes: z.string().max(500).optional().describe(
    "Optional narrative, max 500 chars.",
  ),
});
export type VerifyRunSummary = z.infer<typeof VerifyRunSummary>;

/**
 * Worker-dispatch decision — what the autopilot supervisor asks for
 * when picking which targets to fan out to in a given run. Returned
 * as a list rather than a single target because one supervisor run
 * routinely dispatches multiple workers.
 *
 * Fields:
 * - `targets`  — zero-to-three target descriptors. Cap matches the
 *                supervisor's existing "max 3 worker dispatches per
 *                supervisor run" hard rule, so the schema enforces
 *                the rule directly instead of relying on the prompt.
 */
export const DispatchDecision = z.object({
  targets: z
    .array(
      z.object({
        area: z.string().min(1).describe(
          "Concrete fixable area — match buildDiagnoseGoal's targetArea.",
        ),
        contextNotes: z.string().describe(
          "Log evidence + supervisor-side reasoning, max ~1KB.",
        ),
      }),
    )
    .max(3)
    .describe("Worker dispatch targets, ordered by priority."),
});
export type DispatchDecision = z.infer<typeof DispatchDecision>;

/**
 * Generic terminal summary — the shape returned by a task subagent
 * when the caller wants a short, structured wrap-up rather than free
 * text. Useful when chaining a task's output into another tool call
 * (no markdown to strip, no prose to parse).
 */
export const TaskSummary = z.object({
  done: z.boolean().describe(
    "True when the task completed everything asked. False when partial.",
  ),
  paths: z.array(z.string()).describe(
    "File paths the task read or changed (relative to repo root).",
  ),
  summary: z.string().min(1).max(2000).describe(
    "Plain-English summary of what the task did, max 2KB.",
  ),
});
export type TaskSummary = z.infer<typeof TaskSummary>;

/**
 * Registry record. The schemas live as Zod objects but the registry
 * exposes them as `z.ZodTypeAny` so callers can store them in a
 * single map without losing type-safety at the consumer site (each
 * consumer narrows via the explicit `<TaskSummary>`-style type
 * parameter when calling `generateStructured`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const RESULT_SCHEMA_REGISTRY: Record<string, z.ZodType<any>> = {
  "verify-run-summary": VerifyRunSummary,
  "dispatch-decision": DispatchDecision,
  "task-summary": TaskSummary,
};

/**
 * Look up a registered schema by name. Throws on unknown names so a
 * typo in a profile or tool arg is loud, not silently ignored.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lookupResultSchema(name: string): z.ZodType<any> {
  const schema = RESULT_SCHEMA_REGISTRY[name];
  if (!schema) {
    const known = Object.keys(RESULT_SCHEMA_REGISTRY).join(", ");
    throw new Error(
      `Unknown result schema "${name}". Registered schemas: ${known}.`,
    );
  }
  return schema;
}

/** Stable enumeration of registered schema names — for input-schema enums. */
export function listResultSchemaNames(): readonly string[] {
  return Object.keys(RESULT_SCHEMA_REGISTRY);
}
