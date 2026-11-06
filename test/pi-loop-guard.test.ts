import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { tool, zodSchema } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PiEngine } from "../src/pi/engine";
import { currentRun, judgeLoop, LOOP_GUARD, type LoopVerdict } from "../src/pi/loop-guard";
import { buildToolsExtension } from "../src/pi/tools";
import type { Env } from "../src/types";

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
const call = (name: string, args: Record<string, unknown>, text = ""): Message =>
  ({
    role: "assistant",
    content: [...(text ? [{ type: "text", text }] : []), { type: "toolCall", id: `c${Math.random()}`, name, arguments: args }],
    api: "faux",
    provider: "faux",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 0,
  }) as Message;
const repeat = (n: number, f: (i: number) => Message) => Array.from({ length: n }, (_, i) => f(i));

describe("judgeLoop", () => {
  it("only counts the run since the last user message", () => {
    const msgs = [user("a"), ...repeat(4, () => call("read", { p: 1 })), user("b"), call("read", { p: 1 })];
    expect(currentRun(msgs).calls).toHaveLength(1);
    expect(judgeLoop(msgs)).toEqual({});
  });

  it("nudges at 3 identical calls and refuses at 5", () => {
    const nudge = judgeLoop([user("go"), ...repeat(LOOP_GUARD.IDENTICAL_NUDGE, () => call("grep", { q: "x" }))]);
    expect(nudge.nudge).toContain("same arguments 3 times");
    expect(nudge.stopTool).toBeUndefined();
    const stop = judgeLoop([user("go"), ...repeat(LOOP_GUARD.IDENTICAL_STOP, () => call("grep", { q: "x" }))]);
    expect(stop.stopTool).toBe("grep");
  });

  it("same tool with different args: stop-check at 6, refused at 10 when silent", () => {
    expect(judgeLoop([user("go"), ...repeat(6, (i) => call("codemode", { i }))]).nudge).toContain("STOP-CHECK");
    expect(judgeLoop([user("go"), ...repeat(10, (i) => call("codemode", { i }))]).stopTool).toBe("codemode");
  });

  it("narrated streaks (wizard flows) get the higher bar", () => {
    const narrated = (n: number) => [user("book it"), ...repeat(n, (i) => call("browser", { step: i }, `Step ${i}: clicking the next button now`))];
    expect(judgeLoop(narrated(10)).stopTool).toBeUndefined();
    expect(judgeLoop(narrated(20)).stopTool).toBe("browser");
  });
});

describe("loop guard inside a pi run", () => {
  it("refuses the looping tool and lets the model answer", async () => {
    const e = env as unknown as Env;
    const stub = e.CODING_AGENT.get(e.CODING_AGENT.idFromName("pi-loop-guard-1"));
    await runInDurableObject(stub, async (_i, state) => {
      const faux = fauxProvider();
      let ran = 0;
      // The model calls the same tool with the same args until a call is refused, then answers.
      const respond = (context: { messages: readonly Message[] }) => {
        const refused = context.messages.some((m) => m.role === "toolResult" && JSON.stringify(m).includes("Refused"));
        if (refused) return fauxAssistantMessage([fauxText("Answer from what I have.")]);
        faux.appendResponses([respond]);
        return fauxAssistantMessage([fauxToolCall("status", { dir: "/" })], { stopReason: "toolUse" });
      };
      faux.setResponses([respond]);
      const verdicts: LoopVerdict[] = [];
      const models = createModels();
      models.setProvider(faux.provider);
      const engine = new PiEngine({
        storage: state.storage,
        models: () => models,
        modelRef: () => ({ provider: "faux", modelId: "faux-1" }),
        systemPrompt: () => "You are Dodo.",
        emit: () => {},
        onLoopVerdict: (v) => verdicts.push(v),
        log: () => {},
      });
      const tools = {
        status: tool({
          description: "status",
          inputSchema: zodSchema(z.object({ dir: z.string() })),
          execute: async () => {
            ran++;
            return { ok: true };
          },
        }),
      };
      const result = await engine.run({
        promptId: "loop-1",
        prepare: async () => ({ content: "check", entry: { messageId: "u1", text: "check", authorEmail: null, createdAt: 1 } }),
        tools: await buildToolsExtension(tools),
      });
      expect(result.status).toBe("done");
      expect(result.text).toBe("Answer from what I have.");
      // Ran until the hard bar, then refused instead of executed.
      expect(ran).toBe(LOOP_GUARD.IDENTICAL_STOP);
      expect(verdicts.some((v) => v.nudge?.includes("WARNING"))).toBe(true);
      expect(verdicts.some((v) => v.stopTool === "status")).toBe(true);
      await engine.close();
    });
  });
});
