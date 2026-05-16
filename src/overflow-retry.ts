/**
 * Overflow / context-too-large retry policy.
 *
 * This module documents the retry decision tree for model-call failures
 * caused by context-window exhaustion. The current policy is intentionally
 * simple: a single emergency compaction attempt on overflow, then abort.
 * There is no exponential backoff because the recovery action is compaction
 * (reducing input size) rather than waiting and retrying the same payload.
 *
 * Extracted from CodingAgent.onChatMessage() so the policy can be unit-tested
 * without booting a full Worker.
 */

export type RetryDecision =
  | { kind: "abort"; reason: string }
  | { kind: "retry"; nextDelayMs: number; nextAttempt: number }
  | { kind: "retry-with-truncation"; tokensToTrim: number; nextAttempt: number };

export interface RetryInputs {
  /** How many recovery attempts have already been made for this prompt. */
  previousAttempts: number;
  /** Maximum recovery attempts allowed (default 1). */
  maxAttempts?: number;
  /** The error that caused the model call to fail. */
  error: {
    code?: string;
    status?: number;
    message: string;
  };
  /**
   * Estimated tokens to trim on a truncation retry.
   * Default is 25 % of the context window as a rough heuristic.
   */
  tokensToTrim?: number;
}

/**
 * Decide what to do after a model call fails.
 *
 * Current policy:
 * 1. If the error looks like a context-overflow and we haven't exhausted
 *    recovery attempts → retry-with-truncation (emergency compaction).
 * 2. Otherwise → abort with the error message as reason.
 *
 * There is no "retry with delay" branch because compaction removes the
 * oversized content rather than resending it.
 */
export function nextRetry(inputs: RetryInputs): RetryDecision {
  const maxAttempts = inputs.maxAttempts ?? 1;
  const tokensToTrim = inputs.tokensToTrim ?? 0;

  const isOverflow = isContextOverflowError(inputs.error.message);

  if (isOverflow && inputs.previousAttempts < maxAttempts) {
    return {
      kind: "retry-with-truncation",
      tokensToTrim,
      nextAttempt: inputs.previousAttempts + 1,
    };
  }

  return {
    kind: "abort",
    reason: isOverflow
      ? `Context overflow recovery exhausted after ${inputs.previousAttempts} attempt(s).`
      : inputs.error.message,
  };
}

/** Heuristic detection of context-window / token-limit errors. */
function isContextOverflowError(message: string): boolean {
  return (
    /context.*(length|limit|overflow|window|too long|exceed)/i.test(message) ||
    /max.*token/i.test(message) ||
    /request too large/i.test(message)
  );
}
