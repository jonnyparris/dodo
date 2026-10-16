// Feasibility spike: pi-durable Harness running inside workerd on a Durable
import type { Env } from "../src/types";
// Object's SQLite storage. Proves storage, generation, tool tasks, and
// resume-after-close (the eviction case) work before Dodo builds on it.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { describe, expect, it } from "vitest";

const ctx = BACKGROUND_CONTEXT;
const model = { provider: "faux", modelId: "faux-1" };

function textOf(message: unknown): string {
  const m = message as { content: Array<{ type: string; text?: string }> };
  return m.content.filter((c) => c.type === "text").map((c) => c.text).join("");
}

describe("pi-durable in workerd", () => {
  it("runs a tool turn on DO SQLite storage", async () => {
    const stub = (env as unknown as Env).CODING_AGENT.get((env as unknown as Env).CODING_AGENT.idFromName("pi-spike-1"));
    await runInDurableObject(stub, async (_instance, state) => {
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("echo", { text: "hi" }, { id: "c1" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("done: hi")]),
      ]);
      let calls = 0;
      const registry = createRegistry();
      registry.install(defineExtension({
        name: "spike",
        tools: [defineTool({
          name: "echo",
          description: "echo",
          parameters: Type.Object({ text: Type.String() }),
          execute: async (args) => { calls++; return { output: [{ type: "text", text: args.text }] }; },
        })],
      }));
      const storage = await openDurableObjectSqliteStorage(state.storage, { prefix: "pi_" });
      const harness = await Harness.open(storage, { models, registry }, ctx);
      const root = await harness.root(ctx, { agent: { model } });
      const settled = await (await root.submit({ type: "input", content: "say hi" }, ctx)).wait(ctx);
      expect(settled.status).toBe("done");
      if (settled.status !== "done" || settled.type !== "input") throw new Error("not done");
      const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
      expect(textOf(answer?.model?.[0])).toBe("done: hi");
      expect(calls).toBe(1);
      await harness.close(ctx);
    });
  });

  it("resumes a run interrupted mid-tool after close + reopen (eviction)", async () => {
    const stub = (env as unknown as Env).CODING_AGENT.get((env as unknown as Env).CODING_AGENT.idFromName("pi-spike-2"));
    await runInDurableObject(stub, async (_instance, state) => {
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("slow", {}, { id: "c1" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("recovered")]),
      ]);
      let runs = 0;
      let entered: () => void = () => {};
      const enteredP = new Promise<void>((r) => { entered = r; });
      const slow = defineTool({
        name: "slow",
        description: "slow, replay-safe",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async (_a, _api, c) => {
          runs++;
          if (runs === 1) {
            entered();
            // Block until the harness closes (simulated eviction).
            await new Promise<void>((resolve) => c.abortSignal?.addEventListener("abort", () => resolve()));
            throw new Error("evicted");
          }
          return { output: [{ type: "text", text: "ok" }] };
        },
      });
      const registry = createRegistry();
      registry.install(defineExtension({ name: "spike", tools: [slow] }));
      const open = async () =>
        Harness.open(await openDurableObjectSqliteStorage(state.storage, { prefix: "pi_" }), { models, registry }, ctx);

      const first = await open();
      const root = await first.root(ctx, { agent: { model } });
      const sub = await root.submit({ type: "input", content: "go", requestId: "r1" }, ctx);
      await enteredP;
      await first.close(ctx);

      const second = await open();
      second.resume();
      const again = await (await second.root(ctx)).submit({ type: "input", content: "go", requestId: "r1" }, ctx);
      expect(again.id).toBe(sub.id);
      const settled = await again.wait(ctx);
      expect(settled.status).toBe("done");
      expect(runs).toBe(2);
      await second.close(ctx);
    });
  });
});
