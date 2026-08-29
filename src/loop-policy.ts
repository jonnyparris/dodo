/**
 * Pure decision layer for Dodo's own agent loop — the "hooks pattern".
 *
 * The loop in `coding-agent.ts` applies effects (yield notices, append
 * injections, run compaction, call streamText). This file decides what
 * should happen at each checkpoint. Every function here is total: no
 * side effects, no logging, no I/O — so the boundary conditions are
 * unit-testable without booting a Worker.
 *
 * Inspired by Flue's `useAgentFinish` control seam: decide at every
 * would-stop point whether the work is actually done, and steer rather
 * than settle. Dodo keeps its own loop; only the shape of the decision
 * code is adopted.
 */

import type { ModelMessage } from "ai";
import type { OwnLoopExitReason } from "./final-summary-policy";
import { detectSameToolRepetition } from "./loop-detection";

/**
 * Single source of truth for every loop threshold. The inline copies in
 * coding-agent.ts were the root cause of the primary/continuation loop
 * divergence — the phase loop drifted (missing same-tool checks, old
 * cumulative budget gating) because the numbers lived twice.
 */
export const LOOP_LIMITS = {
  /** % of tokenBudget that triggers the "focus up" warning. */
  WARN_THRESHOLD: 0.70,
  /** % of tokenBudget that triggers the wrap-up injection. */
  WRAP_UP_THRESHOLD: 0.85,
  /** % of tokenBudget at which the loop hard-stops before the next call. */
  HARD_STOP_THRESHOLD: 0.95,
  /** % of tokenBudget that triggers compaction / tool-result pruning. */
  MID_LOOP_COMPACTION_THRESHOLD: 0.50,
  /** Identical tool+args calls in a row before a nudge is injected. */
  DOOM_LOOP_THRESHOLD: 3,
  /** Consecutive silent tool-call steps before the no-text watchdog fires. */
  NO_TEXT_LOOP_THRESHOLD: 15,
  /** Steps before the no-text watchdog starts counting (exploration grace). */
  NO_TEXT_GRACE_STEPS: 10,
  /** Same-tool (any args) calls in a row before the stop-check nudge. */
  SAME_TOOL_NUDGE_THRESHOLD: 6,
  /** Same-tool calls in a row before a hard break. */
  SAME_TOOL_HARD_BREAK_THRESHOLD: 10,
  /** Cumulative input tokens (× tokenBudget) before the runaway backstop. */
  COST_RUNAWAY_FACTOR: 5,
} as const;

/** Hard-break threshold for identical tool+args calls (nudge threshold + 2). */
export const DOOM_LOOP_HARD_BREAK_THRESHOLD = LOOP_LIMITS.DOOM_LOOP_THRESHOLD + 2;

/**
 * How many `"toolName:argsJSON"` entries to retain. Must feed both the
 * doom-loop check (last DOOM_LOOP_HARD_BREAK_THRESHOLD) and the same-tool
 * check (last SAME_TOOL_HARD_BREAK_THRESHOLD) — pick the larger so
 * neither detector starves.
 */
export const TOOL_CALL_RETENTION = Math.max(
  DOOM_LOOP_HARD_BREAK_THRESHOLD,
  LOOP_LIMITS.SAME_TOOL_HARD_BREAK_THRESHOLD,
);

const TEXT_PREFIX_RETENTION = LOOP_LIMITS.DOOM_LOOP_THRESHOLD * 2;

// ─── Tool-call buffer management ───

/** Format one tool call for the loop-detection buffer. */
export function formatToolCall(toolName: string, input: unknown): string {
  return `${toolName}:${JSON.stringify(input)}`;
}

/** Append a tool call to the buffer, capped at TOOL_CALL_RETENTION. */
export function trackToolCall(
  buffer: string[],
  toolName: string,
  input: unknown,
): void {
  buffer.push(formatToolCall(toolName, input));
  if (buffer.length > TOOL_CALL_RETENTION) {
    buffer.splice(0, buffer.length - TOOL_CALL_RETENTION);
  }
}

export interface TrackedText {
  /** First ~80 chars of the iteration's text, trimmed. */
  prefix: string;
  /** Whether the prefix was long enough to count as real text. */
  tracked: boolean;
}

/**
 * Track this iteration's text for repetition detection. Only prefixes
 * longer than 10 chars enter the buffer — shorter output counts as
 * "no text" for the no-text watchdog.
 */
export function trackTextIteration(
  buffer: string[],
  iterationText: string,
): TrackedText {
  const prefix = iterationText.trim().slice(0, 80);
  if (prefix.length > 10) {
    buffer.push(prefix);
    if (buffer.length > TEXT_PREFIX_RETENTION) {
      buffer.splice(0, buffer.length - TEXT_PREFIX_RETENTION);
    }
    return { prefix, tracked: true };
  }
  return { prefix, tracked: false };
}

/**
 * Update the consecutive-silent-steps counter. Increments when the model
 * made tool calls without real text (and the provider gate is open —
 * OpenAI/Google/DeepSeek work silently by design; only Anthropic silence
 * means stuck), resets otherwise.
 */
export function trackNoTextStep(
  previous: number,
  enabled: boolean,
  tracked: boolean,
  madeToolCalls: boolean,
): number {
  if (enabled && !tracked && madeToolCalls) return previous + 1;
  return 0;
}

// ─── Pre-step gate ───

export interface StepGateState {
  /** `"toolName:argsJSON"` entries, oldest first. */
  recentToolCalls: readonly string[];
  cumulativeInputTokens: number;
  tokenBudget: number;
  /** Estimated size of the messages array about to be sent. */
  projectedNextCallTokens: number;
  warnInjected: boolean;
  wrapUpInjected: boolean;
  sameToolNudgeInjected: boolean;
}

export type StepGate =
  | {
      action: "run";
      injections: ModelMessage[];
      /** Once-only injection flags the caller must persist on its state. */
      warnFired?: boolean;
      wrapUpFired?: boolean;
      sameToolNudgeFired?: boolean;
    }
  | {
      action: "stop";
      reason: OwnLoopExitReason;
      /** User-visible notice to yield before stopping, if any. */
      notice?: string;
    };

/**
 * Identical tool+args hard break: the last N calls were byte-identical.
 * Returns the repeated tool name, or null.
 */
export function detectIdenticalToolCalls(
  recentToolCalls: ReadonlyArray<string>,
  threshold: number,
): string | null {
  if (recentToolCalls.length < threshold) return null;
  const lastN = recentToolCalls.slice(-threshold);
  if (!lastN.every((c) => c === lastN[0])) return null;
  return lastN[0].split(":")[0];
}

/**
 * Decide everything that happens between "previous step finished" and
 * "call streamText again": doom-loop nudges and hard breaks, same-tool
 * repetition, the cost runaway backstop, and the projected-context
 * budget tiers. In priority order, a stop wins over an injection; the
 * caller must discard injections when the action is "stop".
 */
export function decideStepGate(state: StepGateState): StepGate {
  // ─── Doom loop (identical tool+args) ───
  // Hard break first: at ≥5 identical calls we stop regardless of the
  // nudge state, mirroring the nested check the inline version did.
  const hardDoomTool = detectIdenticalToolCalls(
    state.recentToolCalls,
    DOOM_LOOP_HARD_BREAK_THRESHOLD,
  );
  if (hardDoomTool) {
    return {
      action: "stop",
      reason: "doom-loop",
      notice: `\n\n[Stopped: repeated ${hardDoomTool} calls detected]\n\n`,
    };
  }

  // ─── Same-tool repetition hard break (looser detector) ───
  const hardTool = detectSameToolRepetition(
    state.recentToolCalls,
    LOOP_LIMITS.SAME_TOOL_HARD_BREAK_THRESHOLD,
  );
  if (hardTool) {
    return {
      action: "stop",
      reason: "doom-loop",
      notice: `\n\n[Stopped: ${hardTool} called ${LOOP_LIMITS.SAME_TOOL_HARD_BREAK_THRESHOLD} times in a row without producing a text answer — write your conclusion from what you have so far.]\n\n`,
    };
  }

  // ─── Cost runaway backstop ───
  // Per-call context pressure is the primary stop signal; this caps
  // absolute cumulative input so a non-doom progress-less grind can't
  // burn unbounded tokens.
  if (state.cumulativeInputTokens >= state.tokenBudget * LOOP_LIMITS.COST_RUNAWAY_FACTOR) {
    return {
      action: "stop",
      reason: "budget-limit",
      notice: `\n\n[Stopped: cumulative input tokens exceeded ${LOOP_LIMITS.COST_RUNAWAY_FACTOR}× the context budget — likely loop]\n\n`,
    };
  }

  // ─── Projected context hard stop ───
  const budgetUsage = state.projectedNextCallTokens / state.tokenBudget;
  if (budgetUsage >= LOOP_LIMITS.HARD_STOP_THRESHOLD) {
    return { action: "stop", reason: "budget-limit" };
  }

  // ─── Injections (doom nudge, same-tool stop-check, budget tiers) ───
  const injections: ModelMessage[] = [];

  const doomTool = detectIdenticalToolCalls(
    state.recentToolCalls,
    LOOP_LIMITS.DOOM_LOOP_THRESHOLD,
  );
  if (doomTool) {
    injections.push({
      role: "system",
      content: `[WARNING: You have called ${doomTool} with the same arguments ${LOOP_LIMITS.DOOM_LOOP_THRESHOLD} times in a row. This is a loop. Try a different approach — use a different tool, different arguments, or explain what's blocking you.]`,
    });
  }

  const nudgeTool = detectSameToolRepetition(
    state.recentToolCalls,
    LOOP_LIMITS.SAME_TOOL_NUDGE_THRESHOLD,
  );
  let sameToolNudgeFired: boolean | undefined;
  if (nudgeTool && !state.sameToolNudgeInjected) {
    injections.push({
      role: "system",
      content: `[STOP-CHECK] You've called \`${nudgeTool}\` ${LOOP_LIMITS.SAME_TOOL_NUDGE_THRESHOLD} times in a row. Do you have enough information to answer the user? If yes: write your conclusion as plain text and do NOT call any more tools. If no: switch to a different tool or explain what's missing. Do not call \`${nudgeTool}\` again unless you have a concrete new question that requires it.`,
    });
    sameToolNudgeFired = true;
  }

  if (budgetUsage >= LOOP_LIMITS.WRAP_UP_THRESHOLD && !state.wrapUpInjected) {
    injections.push({
      role: "system",
      content: "[CONTEXT BUDGET NEARLY EXHAUSTED] Summarize what you've done and what remains, then stop. Do not read new files or start new tasks. Complete your current thought and wrap up.",
    });
    return { action: "run", injections, wrapUpFired: true };
  }
  // Warn still gets its one shot on later steps past the wrap-up
  // threshold — mirrors the original if/else-if injection ladder.
  if (budgetUsage >= LOOP_LIMITS.WARN_THRESHOLD && !state.warnInjected) {
    injections.push({
      role: "system",
      content: "[CONTEXT BUDGET WARNING] You are using most of your context budget. Focus on completing the current task. Avoid reading new files unless essential. Prefer targeted edits over full file reads.",
    });
    return { action: "run", injections, warnFired: true };
  }

  return { action: "run", injections, sameToolNudgeFired };
}

// ─── Mid-loop compaction / prune triggers ───

/** Should Think-level compaction fire this step? One-shot per turn. */
export function shouldTriggerCompaction(
  projectedTokens: number,
  tokenBudget: number,
  compactionTriggered: boolean,
): boolean {
  return (
    projectedTokens / tokenBudget >= LOOP_LIMITS.MID_LOOP_COMPACTION_THRESHOLD &&
    !compactionTriggered
  );
}

/**
 * Should the no-LLM tool-result prune fire? Two independent signals:
 * the outgoing payload is large, OR the cumulative spend is large even
 * though each step looks small (the classic silent-grind failure).
 */
export function shouldPruneResults(
  projectedTokens: number,
  cumulativeTokens: number,
  tokenBudget: number,
): boolean {
  const threshold = LOOP_LIMITS.MID_LOOP_COMPACTION_THRESHOLD;
  return (
    projectedTokens / tokenBudget >= threshold ||
    cumulativeTokens / tokenBudget >= threshold
  );
}

/** Hard stop after compaction + prune failed to get us under budget. */
export function shouldHardStopBeforeCall(
  projectedTokens: number,
  tokenBudget: number,
): boolean {
  return projectedTokens / tokenBudget >= LOOP_LIMITS.HARD_STOP_THRESHOLD;
}

// ─── Post-step gate ───

export interface PostStepState {
  /** Text-prefix buffer after this iteration's push. */
  recentTextPrefixes: readonly string[];
  /** Silent-step counter after this iteration's update. */
  consecutiveNoTextSteps: number;
  noTextDetectionEnabled: boolean;
  step: number;
  madeToolCalls: boolean;
}

export type PostStepDecision =
  | { action: "continue" }
  | { action: "stop"; reason: "text-loop" | "no-text-loop"; notice?: string };

/**
 * Decide whether the just-finished step revealed a stuck pattern:
 * near-identical text repeated across iterations (arg-evading loop),
 * or long stretches of silent tool-calling (Anthropic only).
 */
export function decidePostStep(state: PostStepState): PostStepDecision {
  const n = LOOP_LIMITS.DOOM_LOOP_THRESHOLD;
  if (state.recentTextPrefixes.length >= n) {
    const lastN = state.recentTextPrefixes.slice(-n);
    if (lastN.every((t) => t === lastN[0])) {
      return { action: "stop", reason: "text-loop" };
    }
  }

  if (
    state.noTextDetectionEnabled &&
    state.madeToolCalls &&
    state.consecutiveNoTextSteps >= LOOP_LIMITS.NO_TEXT_LOOP_THRESHOLD &&
    state.step >= LOOP_LIMITS.NO_TEXT_GRACE_STEPS
  ) {
    return {
      action: "stop",
      reason: "no-text-loop",
      notice: "\n\n[Loop detected — summarizing progress so far]\n\n",
    };
  }

  return { action: "continue" };
}

// ─── Phase transitions (the would-stop seam) ───

/** Should a resource-limit exit roll into another continuation phase? */
export function shouldAutoContinue(exitReason: OwnLoopExitReason): boolean {
  return exitReason === "step-limit" || exitReason === "budget-limit";
}

/** Tag a while-condition fall-through as a step-limit exit. */
export function shouldTagStepLimit(
  step: number,
  maxSteps: number,
  exitReason: OwnLoopExitReason,
): boolean {
  return step >= maxSteps && exitReason === "natural";
}

// ─── Phase digest ───

export interface PhaseDigest {
  /** Rebuilt messages: [firstMsg, summaryInjection, ...recent]. */
  messages: ModelMessage[];
  droppedCount: number;
  droppedToolNames: string[];
  droppedToolCalls: number;
  discoveredFiles: string[];
  findingsLength: number;
  toolCallDigestLength: number;
}

const MAX_TOOL_CALL_ENTRY_CHARS = 160;
const MAX_TOOL_CALL_DIGEST_CHARS = 2_000;

/**
 * Rebuild context for a continuation phase: keep the last `keepRecent`
 * messages, replace the (potentially huge) original prompt with a short
 * digest, and summarise everything dropped — tool names, discovered
 * file paths, a capped per-call history, and the model's own findings —
 * so the next phase continues instead of re-exploring.
 *
 * Returns null when the history is short enough that no truncation is
 * needed; the caller keeps `messages` as-is.
 */
export function buildPhaseDigest(
  messages: readonly ModelMessage[],
  keepRecent: number,
  originalPromptDigest: string,
): PhaseDigest | null {
  if (messages.length <= keepRecent + 2) return null;

  const firstMsg: ModelMessage = originalPromptDigest
    ? { role: "system", content: `[Original task]\n${originalPromptDigest}` }
    : messages[0];
  const recentMsgs = messages.slice(-keepRecent);
  const droppedMsgs = messages.slice(1, -keepRecent);

  const droppedToolNames = new Set<string>();
  const discoveredFiles = new Set<string>();
  const assistantTexts: string[] = [];
  const toolCallDigest: string[] = [];

  for (const msg of droppedMsgs) {
    if (typeof msg.content === "object" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && typeof part === "object" && "type" in part) {
          if (part.type === "tool-call" && "toolName" in part) {
            const toolName = String(part.toolName);
            droppedToolNames.add(toolName);
            if ("input" in part && part.input && typeof part.input === "object") {
              const input = part.input as Record<string, unknown>;
              if (typeof input.path === "string" && input.path.length > 1) {
                discoveredFiles.add(input.path);
              }
              // Strip long string fields (content / code / old_string /
              // new_string) before serializing so a single write doesn't
              // eat the whole digest budget.
              const sanitized: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(input)) {
                if (typeof v === "string" && v.length > 80) {
                  sanitized[k] = `<${v.length}-char ${k}>`;
                } else {
                  sanitized[k] = v;
                }
              }
              let entry = `${toolName}(${JSON.stringify(sanitized)})`;
              if (entry.length > MAX_TOOL_CALL_ENTRY_CHARS) {
                entry = entry.slice(0, MAX_TOOL_CALL_ENTRY_CHARS - 3) + "...";
              }
              toolCallDigest.push(entry);
            } else {
              toolCallDigest.push(`${toolName}()`);
            }
          }
          if (part.type === "text" && "text" in part && typeof part.text === "string") {
            const text = part.text.trim();
            if (text.length > 20) assistantTexts.push(text);
          }
        }
      }
    }
  }

  // Tail-trim the digest so the most recent calls survive — older calls
  // are less relevant, the model has likely acted on them.
  let toolCallList = toolCallDigest.join("\n");
  if (toolCallList.length > MAX_TOOL_CALL_DIGEST_CHARS) {
    let bytes = 0;
    const kept: string[] = [];
    for (let i = toolCallDigest.length - 1; i >= 0; i--) {
      const entry = toolCallDigest[i];
      if (bytes + entry.length + 1 > MAX_TOOL_CALL_DIGEST_CHARS) break;
      kept.unshift(entry);
      bytes += entry.length + 1;
    }
    toolCallList = `[...older tool calls elided...]\n${kept.join("\n")}`;
  }

  const toolsSummary = [...droppedToolNames].join(", ") || "none";
  const filesList = discoveredFiles.size > 0
    ? "\n\nFiles discovered in previous phases:\n" + [...discoveredFiles].join("\n")
    : "";
  const callsList = toolCallList.length > 0
    ? "\n\nTool calls already made in previous phases (DO NOT repeat these):\n" + toolCallList
    : "";
  const findingsDigest = assistantTexts.length > 0
    ? "\n\nKey findings from previous phases:\n" + assistantTexts.join("\n").slice(-1500)
    : "";

  const summaryInjection: ModelMessage = {
    role: "system",
    content: `[Previous context truncated — ${droppedMsgs.length} messages dropped. Tools used: ${toolsSummary}. The task is not yet complete. Do NOT re-explore files you already found and do NOT repeat tool calls already made — use the file paths, tool-call history, and findings below to continue making edits.${callsList}${filesList}${findingsDigest}]`,
  };

  return {
    messages: [firstMsg, summaryInjection, ...recentMsgs],
    droppedCount: droppedMsgs.length,
    droppedToolNames: [...droppedToolNames],
    droppedToolCalls: toolCallDigest.length,
    discoveredFiles: [...discoveredFiles],
    findingsLength: findingsDigest.length,
    toolCallDigestLength: toolCallList.length,
  };
}
