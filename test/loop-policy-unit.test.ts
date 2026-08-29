/**
 * Unit tests for the own-loop decision layer (src/loop-policy.ts).
 *
 * The behaviour grid for the pre-step gate (decideStepGate):
 *
 *  - last 5 identical tool+args calls → hard break (doom-loop)
 *  - last 3 identical tool+args calls → nudge injection
 *  - last 10 same-tool (any args) calls → hard break (doom-loop)
 *  - last 6 same-tool calls, nudge not yet fired → stop-check injection
 *  - same-tool nudge already fired → no repeat injection
 *  - cumulative input ≥ 5× budget → stop (budget-limit)
 *  - projected ≥ 95% of budget → stop (budget-limit, no notice)
 *  - projected ≥ 85% → wrap-up injection once; ≥ 70% → warn once
 *  - wrap-up takes precedence over warn
 *
 * Post-step gate (decidePostStep):
 *  - last 3 text prefixes identical → stop (text-loop)
 *  - 15 silent tool-call steps after grace → stop (no-text-loop)
 *  - grace period / provider gate / text presence reset the counter
 */

import type { ModelMessage, ToolCallPart } from "ai";
import { describe, expect, it } from "vitest";
import {
  buildPhaseDigest,
  DOOM_LOOP_HARD_BREAK_THRESHOLD,
  decidePostStep,
  decideStepGate,
  detectIdenticalToolCalls,
  LOOP_LIMITS,
  type StepGateState,
  shouldAutoContinue,
  shouldHardStopBeforeCall,
  shouldPruneResults,
  shouldTagStepLimit,
  shouldTriggerCompaction,
  TOOL_CALL_RETENTION,
  trackNoTextStep,
  trackTextIteration,
  trackToolCall,
} from "../src/loop-policy";

function gateState(overrides: Partial<StepGateState> = {}): StepGateState {
  return {
    recentToolCalls: [],
    cumulativeInputTokens: 0,
    tokenBudget: 100_000,
    projectedNextCallTokens: 10_000,
    warnInjected: false,
    wrapUpInjected: false,
    sameToolNudgeInjected: false,
    ...overrides,
  };
}

describe("detectIdenticalToolCalls", () => {
  it("returns the tool name when the last N calls are identical", () => {
    const calls = ["grep:{\"a\":1}", "grep:{\"a\":1}", "grep:{\"a\":1}"];
    expect(detectIdenticalToolCalls(calls, 3)).toBe("grep");
  });

  it("returns null when args differ", () => {
    const calls = ["grep:{\"a\":1}", "grep:{\"a\":2}", "grep:{\"a\":1}"];
    expect(detectIdenticalToolCalls(calls, 3)).toBeNull();
  });

  it("returns null below the threshold", () => {
    const calls = ["grep:{\"a\":1}", "grep:{\"a\":1}"];
    expect(detectIdenticalToolCalls(calls, 3)).toBeNull();
  });

  it("hard-break threshold is nudge threshold + 2", () => {
    expect(DOOM_LOOP_HARD_BREAK_THRESHOLD).toBe(LOOP_LIMITS.DOOM_LOOP_THRESHOLD + 2);
  });
});

describe("decideStepGate — doom loop", () => {
  it("stops at the hard-break threshold of identical calls", () => {
    const calls = Array(DOOM_LOOP_HARD_BREAK_THRESHOLD).fill("codemode:{\"x\":1}");
    const gate = decideStepGate(gateState({ recentToolCalls: calls }));
    expect(gate.action).toBe("stop");
    if (gate.action === "stop") {
      expect(gate.reason).toBe("doom-loop");
      expect(gate.notice).toContain("[Stopped: repeated codemode calls detected]");
    }
  });

  it("injects a nudge at the identical-call threshold without stopping", () => {
    const calls = Array(LOOP_LIMITS.DOOM_LOOP_THRESHOLD).fill("grep:{\"p\":\"src\"}");
    const gate = decideStepGate(gateState({ recentToolCalls: calls }));
    expect(gate.action).toBe("run");
    if (gate.action === "run") {
      expect(gate.injections).toHaveLength(1);
      expect(gate.injections[0].content).toContain("[WARNING: You have called grep");
    }
  });
});

describe("decideStepGate — same-tool repetition", () => {
  const varied = (tool: string, n: number): string[] =>
    Array.from({ length: n }, (_, i) => `${tool}:{"i":${i}}`);

  it("hard-breaks at 10 same-tool calls even with different args", () => {
    const gate = decideStepGate(gateState({ recentToolCalls: varied("codemode", 10) }));
    expect(gate.action).toBe("stop");
    if (gate.action === "stop") {
      expect(gate.reason).toBe("doom-loop");
      expect(gate.notice).toContain("codemode called 10 times");
    }
  });

  it("nudges once at 6 same-tool calls", () => {
    const gate = decideStepGate(gateState({ recentToolCalls: varied("explore", 6) }));
    expect(gate.action).toBe("run");
    if (gate.action === "run") {
      expect(gate.injections.some((m) => m.content.toString().includes("[STOP-CHECK]"))).toBe(true);
      expect(gate.sameToolNudgeFired).toBe(true);
    }
  });

  it("does not re-nudge after the nudge already fired", () => {
    const gate = decideStepGate(
      gateState({ recentToolCalls: varied("explore", 6), sameToolNudgeInjected: true }),
    );
    expect(gate.action).toBe("run");
    if (gate.action === "run") {
      expect(gate.injections.filter((m) => m.content.toString().includes("[STOP-CHECK]"))).toHaveLength(0);
      expect(gate.sameToolNudgeFired).toBeUndefined();
    }
  });
});

describe("decideStepGate — budget tiers", () => {
  it("hard-stops at 95% projected usage with no notice", () => {
    const gate = decideStepGate(
      gateState({ projectedNextCallTokens: 95_000, tokenBudget: 100_000 }),
    );
    expect(gate.action).toBe("stop");
    if (gate.action === "stop") {
      expect(gate.reason).toBe("budget-limit");
      expect(gate.notice).toBeUndefined();
    }
  });

  it("injects wrap-up once at 85%, then warn on later steps", () => {
    const state = gateState({ projectedNextCallTokens: 86_000, tokenBudget: 100_000 });
    const first = decideStepGate(state);
    expect(first.action).toBe("run");
    if (first.action === "run") {
      expect(first.injections[0].content).toContain("[CONTEXT BUDGET NEARLY EXHAUSTED]");
      expect(first.wrapUpFired).toBe(true);
    }
    // Next step, still past the wrap-up threshold: wrap-up doesn't repeat,
    // but warn still gets its one shot (original else-if semantics).
    const second = decideStepGate({ ...state, wrapUpInjected: true });
    expect(second.action).toBe("run");
    if (second.action === "run") {
      expect(second.injections[0].content).toContain("[CONTEXT BUDGET WARNING]");
      expect(second.warnFired).toBe(true);
    }
  });

  it("injects warn at 70% only when wrap-up has not fired", () => {
    const state = gateState({ projectedNextCallTokens: 72_000, tokenBudget: 100_000 });
    const first = decideStepGate(state);
    expect(first.action).toBe("run");
    if (first.action === "run") {
      expect(first.injections[0].content).toContain("[CONTEXT BUDGET WARNING]");
      expect(first.warnFired).toBe(true);
    }
  });

  it("stops on the cost runaway backstop", () => {
    const gate = decideStepGate(
      gateState({ cumulativeInputTokens: 5 * 100_000, tokenBudget: 100_000 }),
    );
    expect(gate.action).toBe("stop");
    if (gate.action === "stop") {
      expect(gate.reason).toBe("budget-limit");
      expect(gate.notice).toContain("cumulative input tokens exceeded");
    }
  });
});

describe("buffer tracking", () => {
  it("caps the tool-call buffer at the retention limit", () => {
    const buffer: string[] = [];
    for (let i = 0; i < 25; i++) trackToolCall(buffer, "grep", { i });
    expect(buffer).toHaveLength(TOOL_CALL_RETENTION);
  });

  it("only tracks text prefixes longer than 10 chars", () => {
    const buffer: string[] = [];
    expect(trackTextIteration(buffer, "short").tracked).toBe(false);
    expect(buffer).toHaveLength(0);
    expect(trackTextIteration(buffer, "this is a long enough prefix").tracked).toBe(true);
    expect(buffer).toHaveLength(1);
  });

  it("increments the silent counter only for untracked tool-call steps", () => {
    expect(trackNoTextStep(0, true, false, true)).toBe(1);
    expect(trackNoTextStep(3, true, true, true)).toBe(0);
    expect(trackNoTextStep(3, true, false, false)).toBe(0);
    // Provider gate: OpenAI-style silent tools never count.
    expect(trackNoTextStep(3, false, false, true)).toBe(0);
  });
});

describe("decidePostStep", () => {
  it("stops on three identical text prefixes", () => {
    const buffer = ["Analyzing the source", "Analyzing the source", "Analyzing the source"];
    const post = decidePostStep({
      recentTextPrefixes: buffer,
      consecutiveNoTextSteps: 0,
      noTextDetectionEnabled: true,
      step: 5,
      madeToolCalls: true,
    });
    expect(post.action).toBe("stop");
    if (post.action === "stop") expect(post.reason).toBe("text-loop");
  });

  it("fires the no-text watchdog only after grace", () => {
    const base = {
      recentTextPrefixes: [],
      noTextDetectionEnabled: true,
      madeToolCalls: true,
    };
    const early = decidePostStep({ ...base, consecutiveNoTextSteps: LOOP_LIMITS.NO_TEXT_LOOP_THRESHOLD, step: 5 });
    expect(early.action).toBe("continue");
    const late = decidePostStep({ ...base, consecutiveNoTextSteps: LOOP_LIMITS.NO_TEXT_LOOP_THRESHOLD, step: 14 });
    expect(late.action).toBe("stop");
    if (late.action === "stop") {
      expect(late.reason).toBe("no-text-loop");
      expect(late.notice).toContain("[Loop detected");
    }
  });
});

describe("compaction / prune triggers", () => {
  it("compacts once above 50% and never twice", () => {
    expect(shouldTriggerCompaction(51_000, 100_000, false)).toBe(true);
    expect(shouldTriggerCompaction(51_000, 100_000, true)).toBe(false);
    expect(shouldTriggerCompaction(49_000, 100_000, false)).toBe(false);
  });

  it("prunes on projected OR cumulative pressure", () => {
    expect(shouldPruneResults(51_000, 10_000, 100_000)).toBe(true);
    expect(shouldPruneResults(10_000, 51_000, 100_000)).toBe(true);
    expect(shouldPruneResults(10_000, 10_000, 100_000)).toBe(false);
  });

  it("hard-stops above 95% after prune", () => {
    expect(shouldHardStopBeforeCall(96_000, 100_000)).toBe(true);
    expect(shouldHardStopBeforeCall(90_000, 100_000)).toBe(false);
  });
});

describe("phase transitions", () => {
  it("auto-continues only on resource-limit exits", () => {
    expect(shouldAutoContinue("step-limit")).toBe(true);
    expect(shouldAutoContinue("budget-limit")).toBe(true);
    expect(shouldAutoContinue("doom-loop")).toBe(false);
    expect(shouldAutoContinue("no-text-loop")).toBe(false);
    expect(shouldAutoContinue("text-loop")).toBe(false);
    expect(shouldAutoContinue("natural")).toBe(false);
    expect(shouldAutoContinue("abort")).toBe(false);
  });

  it("tags a while-condition fall-through as step-limit", () => {
    expect(shouldTagStepLimit(50, 50, "natural")).toBe(true);
    expect(shouldTagStepLimit(49, 50, "natural")).toBe(false);
    expect(shouldTagStepLimit(50, 50, "doom-loop")).toBe(false);
  });
});

describe("buildPhaseDigest", () => {
  const userPrompt: ModelMessage = { role: "user", content: "Please refactor the widget module." };
  const toolCallPart = (name: string, input: Record<string, unknown>): ToolCallPart => ({
    type: "tool-call",
    toolCallId: `call_${name}`,
    toolName: name,
    input,
  });

  function history(n: number): ModelMessage[] {
    const msgs: ModelMessage[] = [userPrompt];
    for (let i = 0; i < n; i++) {
      msgs.push({
        role: "assistant",
        content: [
          toolCallPart("read_file", { path: `/src/file${i}.ts`, content: "x".repeat(200) }),
          { type: "text", text: `Found interesting thing ${i} that should be preserved in the digest.` },
        ],
      });
    }
    return msgs;  }

  it("returns null when history fits without truncation", () => {
    expect(buildPhaseDigest(history(5), 12, "digest")).toBeNull();
  });

  it("truncates and preserves a goal digest, tool history, files, and findings", () => {
    const result = buildPhaseDigest(history(30), 12, "Refactor the widget module");
    expect(result).not.toBeNull();
    if (!result) return;
    // [digest firstMsg, summary injection, ...12 recent]
    expect(result.messages).toHaveLength(14);
    const first = result.messages[0];
    expect(first.role).toBe("system");
    expect(first.content).toContain("[Original task]");
    expect(first.content).toContain("Refactor the widget module");
    const summary = result.messages[1];
    expect(summary.content).toContain("Previous context truncated");
    expect(summary.content).toContain("read_file");
    expect(result.droppedCount).toBe(18);
    expect(result.discoveredFiles.length).toBe(18);
    expect(result.findingsLength).toBeGreaterThan(0);
  });

  it("strips long string fields from the tool-call digest", () => {
    const msgs: ModelMessage[] = [
      userPrompt,
      ...Array.from({ length: 20 }, (_, i): ModelMessage => ({
        role: "assistant",
        content: [toolCallPart("write_file", { path: `/f${i}.ts`, content: "y".repeat(500) })],
      })),
    ];
    const result = buildPhaseDigest(msgs, 12, "task");
    expect(result).not.toBeNull();
    if (!result) return;
    const summary = result.messages[1];
    expect(summary.content).toContain("<500-char content>");
    expect(summary.content).not.toContain("yyyyy");
  });
});
