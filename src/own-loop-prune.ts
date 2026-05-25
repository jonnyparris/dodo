/**
 * In-place pruning of the own-loop's in-memory `messages` array.
 *
 * **Why this exists.**
 * The autocompaction safety nets in `coding-agent.ts` operate on Think's
 * *persisted* session history. Think persists the assistant message only
 * *after* `streamText()` completes — so during a long-running first user
 * turn, `sessions.getHistory()` returns just `[user]`. There is nothing
 * for the compaction summariser to summarise.
 *
 * Meanwhile, the own-loop accumulates tool-result messages in its closure
 * variable `messages` across iterations. Weak orchestrators (Gemma 4 26B,
 * Kimi K2.6) routinely make many tool calls in a single turn whose results
 * compound the local array to 200k+ tokens. The pre-step budget check then
 * kicks the model into wrap-up before any safety net engages.
 *
 * This module is the safety net for that case: a pure, no-LLM, no-storage
 * function that walks the in-memory messages and shortens the biggest
 * tool-result payloads until the projected budget is back under threshold.
 * No state, no async, no surprises.
 *
 * **Design.**
 * - Replace large tool-result `value`s with a short placeholder. Keep the
 *   `tool-result` envelope (toolCallId, toolName) intact so the model's
 *   tool-call/result pairing isn't broken — that would confuse the AI SDK
 *   and the model itself.
 * - Prune oldest first. The freshest tool result is the one the model is
 *   about to react to; preserving it preserves the chain of thought.
 * - Preserve the user message and the most recent N tool results
 *   regardless of size — they're load-bearing.
 * - Operate on the array directly (mutate) so callers don't have to
 *   re-assign references.
 */

import type { ModelMessage } from "ai";

/** Identifying shape of an AI SDK tool-result part. */
interface ToolResultPart {
  type: "tool-result";
  toolName?: string;
  toolCallId?: string;
  output?: { type?: string; value?: unknown };
}

export interface PruneOptions {
  /** Token budget to stay under. */
  targetTokens: number;
  /**
   * Estimator used to compute current token count. Injected so the caller
   * uses the same estimator as the budget check that triggered the prune.
   */
  estimate: (messages: ModelMessage[]) => number;
  /**
   * How many of the most recent tool messages to leave alone, regardless
   * of size. The freshest tool result is what the model is reacting to —
   * pruning it would erase the reason it's about to make its next move.
   * Defaults to 2.
   */
  preserveRecentToolMessages?: number;
  /**
   * Lower bound on per-tool-result payload size that's eligible for
   * pruning. Tiny results (a few hundred bytes) don't move the needle
   * and pruning them just adds noise. Defaults to 2000 chars.
   */
  minPrunablePayloadChars?: number;
}

export interface PruneResult {
  /** Whether any messages were modified. */
  pruned: boolean;
  /** Tokens estimated before pruning. */
  tokensBefore: number;
  /** Tokens estimated after pruning. */
  tokensAfter: number;
  /** Number of tool-result parts that were shortened. */
  partsPruned: number;
  /** Total bytes removed across all shortened parts. */
  bytesRemoved: number;
}

/**
 * Walk `messages` in place and shorten the largest tool-result payloads
 * until the projected token count drops below `targetTokens`. Returns a
 * summary of what changed; the caller is expected to log it.
 *
 * The function is deterministic given the same input.
 */
export function pruneOversizedToolResults(
  messages: ModelMessage[],
  opts: PruneOptions,
): PruneResult {
  const preserveRecent = opts.preserveRecentToolMessages ?? 2;
  const minPrunable = opts.minPrunablePayloadChars ?? 2_000;
  const tokensBefore = opts.estimate(messages);

  if (tokensBefore <= opts.targetTokens) {
    return {
      pruned: false,
      tokensBefore,
      tokensAfter: tokensBefore,
      partsPruned: 0,
      bytesRemoved: 0,
    };
  }

  // Index every prunable tool-result part with its serialized size and
  // its source message index. We'll process oldest-first, skipping the
  // most recent `preserveRecent` tool messages entirely.
  const toolMessageIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") toolMessageIndices.push(i);
  }
  // When there are fewer (or equal) tool messages than the preserve
  // window, every tool message is protected — cutoffIndex stays at 0 so
  // the eligibility loop finds no candidates. Otherwise the cutoff is
  // the index of the *first* preserved tool message; anything strictly
  // before it is eligible for pruning.
  const cutoffIndex = toolMessageIndices.length > preserveRecent
    ? toolMessageIndices[toolMessageIndices.length - preserveRecent]
    : 0;

  type Candidate = {
    msgIdx: number;
    partIdx: number;
    sizeChars: number;
    toolName: string;
  };
  const candidates: Candidate[] = [];

  for (let i = 0; i < messages.length; i++) {
    if (i >= cutoffIndex) break;
    const msg = messages[i];
    if (msg.role !== "tool") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (let p = 0; p < content.length; p++) {
      const part = content[p] as unknown as ToolResultPart;
      if (part?.type !== "tool-result") continue;
      const value = part.output?.value;
      if (value === undefined) continue;
      const serialized = typeof value === "string" ? value : JSON.stringify(value);
      if (serialized.length < minPrunable) continue;
      candidates.push({
        msgIdx: i,
        partIdx: p,
        sizeChars: serialized.length,
        toolName: part.toolName ?? "unknown",
      });
    }
  }

  // Oldest-largest first: oldest messages are dropped before recent ones,
  // and within the same age the biggest payload wins.
  candidates.sort((a, b) => {
    if (a.msgIdx !== b.msgIdx) return a.msgIdx - b.msgIdx;
    return b.sizeChars - a.sizeChars;
  });

  let partsPruned = 0;
  let bytesRemoved = 0;

  for (const cand of candidates) {
    if (opts.estimate(messages) <= opts.targetTokens) break;

    const msg = messages[cand.msgIdx];
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    const part = msg.content[cand.partIdx] as unknown as ToolResultPart;
    if (part?.type !== "tool-result") continue;

    const placeholder =
      `[Tool result from \`${cand.toolName}\` (${cand.sizeChars} chars) pruned by the harness ` +
      `to stay under the context budget. Re-run the tool if you still need this data.]`;

    // Mutate in place. Preserve the envelope (toolCallId, toolName) so the
    // assistant's prior tool-call still resolves; only the payload changes.
    part.output = {
      type: "text",
      value: placeholder,
    };

    partsPruned += 1;
    bytesRemoved += cand.sizeChars - placeholder.length;
  }

  const tokensAfter = opts.estimate(messages);
  return {
    pruned: partsPruned > 0,
    tokensBefore,
    tokensAfter,
    partsPruned,
    bytesRemoved,
  };
}
