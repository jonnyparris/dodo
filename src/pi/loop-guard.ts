// Doom-loop guard for pi sessions: the same checks the Think own-loop ran
// between steps (loop-policy.ts), as pi-durable hooks.
//
// State is derived from the request itself: the tool calls and text the
// model produced since the last real user message. Nothing to persist, and
// it survives eviction for free.
//
//   - beforeRequest: append a one-request-only nudge when the model repeats
//     itself, or a stop notice at the hard bar.
//   - beforeTool: at the hard bar, refuse further calls of the repeated
//     tool, so the model has to answer from what it has.

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook, ToolTask } from "@earendil-works/pi-durable";
import { detectSameToolRepetition } from "../loop-detection";

export const LOOP_GUARD = {
  /** Identical tool+args in a row before a nudge. */
  IDENTICAL_NUDGE: 3,
  /** Identical tool+args in a row before the tool is refused. */
  IDENTICAL_STOP: 5,
  /** Same tool (any args) in a row before the stop-check nudge. */
  SAME_TOOL_NUDGE: 6,
  /** Same tool in a row, no narration, before the tool is refused. */
  SAME_TOOL_STOP: 10,
  /** Same tool in a row while the model narrates between calls (wizard flows). */
  SAME_TOOL_STOP_NARRATED: 20,
} as const;

export interface LoopVerdict {
  /** Text appended as a user message to this request only. */
  nudge?: string;
  /** Tool to refuse from now on in this run. */
  stopTool?: string;
}

interface RunView {
  calls: string[];
  narrating: boolean;
}

/** Tool calls (`name:argsJSON`) and narration since the last user message. */
export function currentRun(messages: readonly Message[]): RunView {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      start = i + 1;
      break;
    }
  }
  const calls: string[] = [];
  const texts: string[] = [];
  for (const m of messages.slice(start)) {
    if (m.role !== "assistant") continue;
    for (const block of (m as AssistantMessage).content) {
      if (block.type === "toolCall") calls.push(`${block.name}:${JSON.stringify(block.arguments ?? {})}`);
      else if (block.type === "text" && block.text.trim().length > 10) texts.push(block.text);
    }
  }
  // Narration = real text in the recent stretch, as the Think loop tracked it.
  return { calls, narrating: texts.length > 0 && calls.length > 0 };
}

function identicalTail(calls: readonly string[], n: number): string | null {
  if (calls.length < n) return null;
  const tail = calls.slice(-n);
  return tail.every((c) => c === tail[0]) ? tail[0]!.split(":")[0]! : null;
}

export function judgeLoop(messages: readonly Message[]): LoopVerdict {
  const { calls, narrating } = currentRun(messages);
  const identicalStop = identicalTail(calls, LOOP_GUARD.IDENTICAL_STOP);
  if (identicalStop) {
    return {
      stopTool: identicalStop,
      nudge: `[Stopped: ${identicalStop} was called with the same arguments ${LOOP_GUARD.IDENTICAL_STOP} times in a row. It will be refused from now on. Write your answer from what you have, or explain what's blocking you.]`,
    };
  }
  const sameStop = detectSameToolRepetition(calls, narrating ? LOOP_GUARD.SAME_TOOL_STOP_NARRATED : LOOP_GUARD.SAME_TOOL_STOP);
  if (sameStop) {
    const n = narrating ? LOOP_GUARD.SAME_TOOL_STOP_NARRATED : LOOP_GUARD.SAME_TOOL_STOP;
    return {
      stopTool: sameStop,
      nudge: `[Stopped: ${sameStop} was called ${n} times in a row. It will be refused from now on. Write your conclusion from what you have so far.]`,
    };
  }
  const identical = identicalTail(calls, LOOP_GUARD.IDENTICAL_NUDGE);
  if (identical) {
    return {
      nudge: `[WARNING: You have called ${identical} with the same arguments ${LOOP_GUARD.IDENTICAL_NUDGE} times in a row. This is a loop. Try a different approach: a different tool, different arguments, or explain what's blocking you.]`,
    };
  }
  const same = detectSameToolRepetition(calls, LOOP_GUARD.SAME_TOOL_NUDGE);
  if (same) {
    return {
      nudge: `[STOP-CHECK] You've called \`${same}\` ${LOOP_GUARD.SAME_TOOL_NUDGE} times in a row. If you have enough to answer, write your conclusion as plain text and call no more tools. If not, switch tools or say what's missing.`,
    };
  }
  return {};
}

/**
 * The guard as a pi extension. `stopped` maps conversation → tools refused in
 * the current run; it is rebuilt from the transcript on every request, so an
 * evicted isolate that loses it re-derives it before the next tool call.
 */
export function buildLoopGuardExtension(onVerdict?: (verdict: LoopVerdict) => void) {
  const stopped = new Map<string, Set<string>>();
  return defineExtension({
    name: "dodo-loop-guard",
    hooks: [
      hook(GenerationTask, {
        beforeRequest(request, api) {
          const verdict = judgeLoop(request.messages);
          const key = String(api.conversationId);
          const refused = new Set(stopped.get(key) ?? []);
          // A fresh run (no calls since the user spoke) starts with nothing refused.
          if (currentRun(request.messages).calls.length === 0) refused.clear();
          if (verdict.stopTool) refused.add(verdict.stopTool);
          stopped.set(key, refused);
          if (!verdict.nudge) return undefined;
          onVerdict?.(verdict);
          const nudge: Message = { role: "user", content: verdict.nudge, timestamp: Date.now() };
          return { messages: [...request.messages, nudge] };
        },
      }),
      hook(ToolTask, {
        beforeTool(call, api) {
          if (call.parent) return undefined;
          if (!stopped.get(String(api.conversationId))?.has(call.name)) return undefined;
          return { block: `Refused: ${call.name} is in a loop. Answer from what you have.` };
        },
      }),
    ],
  });
}
