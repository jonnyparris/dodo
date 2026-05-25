/**
 * Pure decision logic for the own-loop's "final-summary turn" feature.
 *
 * After the own-loop exits, the harness sometimes wants to run one more
 * no-tools turn to elicit a real conclusion from the model — but only
 * when:
 *   - the loop exited because the model was stuck (not because it
 *     finished naturally, hit a cost backstop, or the user aborted),
 *   - AND the model didn't already write a substantive text answer.
 *
 * Extracted from `coding-agent.ts:onChatMessage()` so the boundary
 * conditions are testable without booting a Worker.
 */

export type OwnLoopExitReason =
  | "natural"
  | "step-limit"
  | "budget-limit"
  | "doom-loop"
  | "no-text-loop"
  | "text-loop"
  | "abort";

/** Exit reasons that mean "the model got stuck — try one more nudge". */
export const STUCK_EXIT_REASONS: ReadonlySet<OwnLoopExitReason> = new Set([
  "doom-loop",
  "no-text-loop",
  "text-loop",
]);

/**
 * Strip the harness's own bracketed notices ("[Stopped: ...]",
 * "[Compacting context ...]", "[Loop detected ...]") from a string.
 * Used when judging whether the model itself produced a real text
 * answer — without this scrub, a 50-char stop notice would count as
 * "model wrote text" and we'd skip the final-summary turn.
 */
export function stripHarnessNotices(text: string): string {
  return text
    .replace(/\[Stopped:[^\]]*\]/g, "")
    .replace(/\[Compacting context[^\]]*\]/g, "")
    .replace(/\[Loop detected[^\]]*\]/g, "")
    .trim();
}

export interface FinalSummaryDecisionInputs {
  /** How the own-loop exited. */
  exitReason: OwnLoopExitReason;
  /** Whether the outer abort signal was tripped. */
  signalAborted: boolean;
  /** All assistant text emitted across the turn so far. */
  turnText: string;
  /**
   * If the model already wrote at least this many chars of
   * non-harness-notice text, the summary turn is skipped. Defaults
   * to 200.
   */
  minExistingTextChars?: number;
}

/** Should the own-loop run a no-tools final-summary turn? */
export function shouldRunFinalSummary(
  inputs: FinalSummaryDecisionInputs,
): boolean {
  if (inputs.signalAborted) return false;
  if (!STUCK_EXIT_REASONS.has(inputs.exitReason)) return false;
  const min = inputs.minExistingTextChars ?? 200;
  const stripped = stripHarnessNotices(inputs.turnText);
  return stripped.length < min;
}
