/**
 * Compaction policy — pure decisions about when and where to compact
 * message history.
 *
 * These functions used to live inside CodingAgent.maybeCompactContext() and
 * CodingAgent.assembleContext(). Extracting them makes the decision logic
 * testable without spinning up a Worker + DO.
 */

export interface CompactionInputs {
  /** Total message count (including synthetic compaction summaries). */
  messageCount: number;
  /** Message count excluding synthetic compaction summaries. */
  realMessageCount: number;
  /** Estimated tokens currently in context. */
  estimatedTokens: number;
  /** Model's maximum context window (tokens). */
  modelContextWindow: number;
  /** Trigger threshold as a ratio, e.g. 0.6 for 60 %. */
  thresholdRatio: number;
  /** When true, skip the usage-threshold check (emergency compaction). */
  force?: boolean;
  /** When true, the context was truncated this turn — compaction is warranted. */
  contextWasTruncated?: boolean;
  /** Minimum messages before compaction is considered (default 6). */
  minMessages?: number;
}

/** Should the session trigger a compaction pass? */
export function shouldCompact(inputs: CompactionInputs): boolean {
  // Emergency / forced compaction bypasses BOTH the usage check and the
  // minMessages guard. Without this short-circuit, a first-turn balloon
  // (e.g. a single assistant turn with many tool calls that compound to
  // 200k+ input tokens) silently skips compaction because the persisted
  // messageCount is still 2 (user + assistant) — well below the default
  // minMessages of 6. The same applies after assembleContext() truncates
  // history; we need a way to opt back in regardless of message count.
  //
  // We still require at least 2 real messages to have something to
  // summarise — compacting 1 message is a no-op and 0 is a crash.
  if (inputs.force || inputs.contextWasTruncated) {
    return inputs.realMessageCount >= 2;
  }

  const minMessages = inputs.minMessages ?? 6;
  if (inputs.messageCount < minMessages) return false;
  if (inputs.realMessageCount < minMessages) return false;

  const tokenBudget = Math.floor(inputs.modelContextWindow * 0.8);
  if (tokenBudget <= 0) return false;

  const usageRatio = inputs.estimatedTokens / tokenBudget;
  return usageRatio >= inputs.thresholdRatio;
}

/** Single message used by {@link pickCutoff}. */
export interface CutoffMessage {
  role: string;
  /** Pre-computed token estimate for this message. */
  tokens: number;
  /** When true, the message is protected from eviction. */
  pinned?: boolean;
}

export interface CutoffInputs {
  messages: CutoffMessage[];
  /** Target token budget for the retained messages. */
  targetTokenBudget: number;
  /**
   * Provider-reported cumulative input tokens up to the last assistant
   * message. When provided, the walk anchors on that message and only
   * estimates the trailing delta.
   */
  anchorTokens?: number;
  /** Index floor — cutoff will never go below this (protects compaction summaries). */
  cutoffFloor?: number;
}

export interface CutoffResult {
  /** Index of the first message to KEEP. Messages [0, cutoffIndex) are evicted. */
  cutoffIndex: number;
  /** Estimated tokens evicted. 0 when nothing is dropped. */
  evictedTokens: number;
}

/**
 * Pick the cutoff index that keeps the most recent messages while staying
 * within the token budget.
 *
 * Implements the hybrid tracking approach from CodingAgent.assembleContext():
 * - If `anchorTokens` is provided, anchor on the last assistant message and
 *   only estimate the trailing delta.
 * - Otherwise, walk backwards from the end of the array, summing tokens until
 *   the budget is exceeded.
 *
 * Pinned messages are never evicted — if a pinned message would fall inside
 * the dropped range, the cutoff is pushed forward to keep it.
 */
export function pickCutoff(inputs: CutoffInputs): CutoffResult {
  const { messages, targetTokenBudget, anchorTokens, cutoffFloor = 0 } = inputs;

  if (messages.length === 0) {
    return { cutoffIndex: 0, evictedTokens: 0 };
  }

  let cutoffIndex = 0;
  let keptTokens = 0;

  if (anchorTokens && anchorTokens > 0) {
    // Find the last assistant message to use as anchor.
    let anchorIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        anchorIndex = i;
        break;
      }
    }

    if (anchorIndex >= 0) {
      // Sum trailing messages after the anchor.
      let trailingTokens = 0;
      for (let i = anchorIndex + 1; i < messages.length; i++) {
        trailingTokens += messages[i].tokens;
      }
      keptTokens = anchorTokens + trailingTokens;

      if (keptTokens > targetTokenBudget) {
        let budget = targetTokenBudget - trailingTokens;
        for (let i = anchorIndex; i >= 0; i--) {
          const msg = messages[i];
          if (msg.pinned) {
            // Pinned message — don't count against budget, don't evict.
            continue;
          }
          if (budget - msg.tokens < 0) {
            cutoffIndex = Math.max(i + 1, cutoffFloor);
            break;
          }
          budget -= msg.tokens;
        }
      }
    } else {
      // No assistant message yet — fall back to pure estimation.
      ({ cutoffIndex, keptTokens } = walkBackwards(messages, targetTokenBudget, cutoffFloor));
    }
  } else {
    // No anchor — pure estimation from the end.
    ({ cutoffIndex, keptTokens } = walkBackwards(messages, targetTokenBudget, cutoffFloor));
  }

  // Ensure we don't drop pinned messages.
  for (let i = 0; i < cutoffIndex; i++) {
    if (messages[i].pinned) {
      // Move cutoff forward past this pinned message.
      cutoffIndex = i + 1;
    }
  }

  const totalTokens = messages.reduce((sum, m) => sum + m.tokens, 0);
  const evictedTokens = totalTokens - keptTokens;

  return {
    cutoffIndex,
    evictedTokens: Math.max(0, evictedTokens),
  };
}

/** Walk backwards from the end of the message list, accumulating kept tokens. */
function walkBackwards(
  messages: CutoffMessage[],
  budget: number,
  floor: number,
): { cutoffIndex: number; keptTokens: number } {
  let keptTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.pinned) {
      keptTokens += msg.tokens;
      continue;
    }
    if (keptTokens + msg.tokens > budget) {
      return { cutoffIndex: Math.max(i + 1, floor), keptTokens };
    }
    keptTokens += msg.tokens;
  }
  return { cutoffIndex: 0, keptTokens };
}
