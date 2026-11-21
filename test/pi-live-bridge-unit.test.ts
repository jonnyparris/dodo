import type { ConversationView, EntryRecord, LiveState } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { LiveBridge, type PiTurnProgress } from "../src/pi/live-bridge";

const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

function user(id: number, text: string): EntryRecord {
  return { id, conversationId: 1, kind: "dodo.user", model: [{ role: "user", content: text, timestamp: 0 }] } as unknown as EntryRecord;
}
function answer(id: number, text: string, calls: Array<{ id: string; name: string; args?: unknown }> = [], stopReason = calls.length ? "toolUse" : "stop"): EntryRecord {
  const content = [
    ...(text ? [{ type: "text", text }] : []),
    ...calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args ?? {} })),
  ];
  return { id, conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", content, usage: usage(10, 2), stopReason, timestamp: 0 }] } as unknown as EntryRecord;
}
function result(id: number, callId: string, name: string, output: string): EntryRecord {
  return { id, conversationId: 1, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text: output }], isError: false, timestamp: 0 }] } as unknown as EntryRecord;
}
function view(entries: EntryRecord[], live: LiveState = {}, before?: number): ConversationView {
  return { conversation: {} as never, entries, ...(before !== undefined ? { before: before as never } : {}), docs: { "pi.live": live as never } };
}
const streaming = (taskId: number, attempt: number, text: string): LiveState =>
  ({ run: { taskId, inputs: [], turns: 0 }, generation: { attempt, message: { role: "assistant", content: [{ type: "text", text }] } } }) as unknown as LiveState;

function setup(store: EntryRecord[] = []) {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const progress: PiTurnProgress[] = [];
  const loads: Array<[number, number | undefined]> = [];
  const bridge = new LiveBridge({
    emit: (e) => events.push(e as never),
    log: (_level, message) => logs.push(message),
    onProgress: (p) => progress.push(p),
    loadEntries: async (min, max) => {
      loads.push([min, max]);
      return store.filter((e) => Number(e.id) >= min && (max === undefined || Number(e.id) <= max));
    },
  });
  const flat = () =>
    events.map((e) =>
      e.type === "text_delta" ? `text:${e.data.delta}` : e.type === "tool_call" ? `call:${e.data.toolCallId}:${JSON.stringify(e.data.input)}` : `result:${e.data.toolCallId}:${e.data.output}`,
    );
  return { bridge, events, progress, loads, flat, logs };
}

describe("LiveBridge", () => {
  it("renders one folded view (answer, tool result, next answer) in transcript order", async () => {
    const { bridge, flat } = setup();
    bridge.attach(view([user(1, "old"), answer(2, "old answer"), user(3, "status?")]));
    await bridge.apply(view([user(3, "status?"), answer(4, "Checking. ", [{ id: "c1", name: "git_status", args: { dir: "/repo" } }]), result(5, "c1", "git_status", '{"clean":true}'), answer(6, "Clean tree.")]));
    await bridge.finish();
    expect(flat()).toEqual(["text:Checking. ", 'call:c1:{"dir":"/repo"}', 'result:c1:{"clean":true}', "text:Clean tree."]);
    expect(bridge.totals.steps).toBe(2);
    expect(bridge.totals.input).toBe(20);
    expect(bridge.totals.toolCalls).toEqual(["git_status"]);
  });

  it("streams partials as suffixes and doesn't repeat them with the final entry", async () => {
    const { bridge, flat } = setup();
    bridge.attach(view([user(1, "hi")]));
    await bridge.apply(view([user(1, "hi")], streaming(7, 1, "Hel")));
    await bridge.apply(view([user(1, "hi")], streaming(7, 1, "Hello wor")));
    await bridge.apply(view([user(1, "hi"), answer(2, "Hello world")]));
    // A stale partial of the finished attempt must not stream again.
    await bridge.apply(view([user(1, "hi"), answer(2, "Hello world")], streaming(7, 1, "Hello world")));
    expect(flat()).toEqual(["text:Hel", "text:lo wor", "text:ld"]);
  });

  it("does not re-emit the baseline (earlier steps of a recovered turn, the partial so far)", async () => {
    const { bridge, flat } = setup();
    bridge.attach(view([user(1, "go"), answer(2, "step one")], streaming(9, 1, "step tw")));
    await bridge.apply(view([user(1, "go"), answer(2, "step one"), answer(3, "step two")]));
    expect(flat()).toEqual(["text:o"]);
    expect(bridge.totals.steps).toBe(1);
  });

  it("gives a recovered turn's running call its tool_call before the result", async () => {
    const { bridge, flat } = setup();
    bridge.attach(view([user(1, "go"), answer(2, "", [{ id: "c1", name: "hang" }])]));
    await bridge.apply(view([user(1, "go"), answer(2, "", [{ id: "c1", name: "hang" }]), result(3, "c1", "hang", "interrupted"), answer(4, "done")]));
    expect(flat()).toEqual(["call:c1:{}", "result:c1:interrupted", "text:done"]);
  });

  it("closes a call whose result never came (faulted tool) when the next answer arrives, and at finish", async () => {
    const { bridge, flat } = setup();
    bridge.attach(view([user(1, "go")]));
    await bridge.apply(view([user(1, "go"), answer(2, "", [{ id: "c1", name: "a" }])]));
    await bridge.apply(view([user(1, "go"), answer(2, "", [{ id: "c1", name: "a" }]), answer(3, "", [{ id: "c2", name: "b" }])]));
    await bridge.finish();
    expect(flat()).toEqual(["call:c1:{}", "result:c1:", "call:c2:{}", "result:c2:"]);
  });

  it("reads entries the window dropped (before > last seen) before the window's own", async () => {
    // 60 new entries in one fold; the window kept the newest 50.
    const store: EntryRecord[] = [user(1, "go")];
    for (let i = 0; i < 30; i++) {
      store.push(answer(2 + i * 2, "", [{ id: `c${i}`, name: "t" }]));
      store.push(result(3 + i * 2, `c${i}`, "t", `r${i}`));
    }
    store.push(answer(62, "end"));
    const { bridge, flat, loads } = setup(store);
    bridge.attach(view([user(1, "go")]));
    const windowed = store.slice(-50);
    await bridge.apply(view(windowed, {}, Number(store[store.length - 51]!.id)));
    await bridge.finish();
    expect(loads[0]).toEqual([2, 12]);
    const out = flat();
    expect(out.filter((e) => e.startsWith("call:"))).toHaveLength(30);
    expect(out.filter((e) => e.startsWith("result:"))).toHaveLength(30);
    expect(new Set(out).size).toBe(out.length);
    expect(out.at(-1)).toBe("text:end");
    expect(bridge.totals.steps).toBe(31);
  });

  it("finish() catches up on entries no delivered view showed (listener lagged behind the settle)", async () => {
    const store = [user(1, "go"), answer(2, "Checking. ", [{ id: "c1", name: "t" }]), result(3, "c1", "t", "ok"), answer(4, "Done.")];
    const { bridge, flat, loads } = setup(store);
    bridge.attach(view([user(1, "go")]));
    await bridge.apply(view(store.slice(0, 2)));
    // The settle won; the watch stopped before delivering the rest.
    await bridge.finish();
    expect(loads).toEqual([[3, undefined]]);
    expect(flat()).toEqual(["text:Checking. ", "call:c1:{}", "result:c1:ok", "text:Done."]);
    expect(bridge.totals.steps).toBe(2);
  });

  it("reports open tool calls (pending ones too) and compactions to the stall guard", async () => {
    const { bridge, progress } = setup();
    bridge.attach(view([]));
    await bridge.apply(
      view([], { run: { taskId: 1, inputs: [], turns: 1 }, tools: [{ callId: "c1", name: "ci", status: "pending" }, { callId: "c0", name: "read", status: "done" }] } as unknown as LiveState),
    );
    await bridge.apply(view([], { compactions: [{ taskId: 5, trigger: "threshold", blocking: true, attempt: 1 }] } as unknown as LiveState));
    expect(progress.at(-2)).toEqual({ label: "tool:ci", openTools: [{ callId: "c1", name: "ci" }], compacting: false });
    expect(progress.at(-1)).toEqual({ label: "compaction", openTools: [], compacting: true });
  });

  it("streams a new attempt (provider retry) from its start; the failed partial stays", async () => {
    const { bridge, flat } = setup();
    bridge.attach(view([user(1, "hi")]));
    await bridge.apply(view([user(1, "hi")], streaming(7, 1, "Hel")));
    await bridge.apply(view([user(1, "hi"), answer(2, "", [], "error")]));
    await bridge.apply(view([user(1, "hi"), answer(2, "", [], "error")], streaming(7, 2, "Hello")));
    await bridge.apply(view([user(1, "hi"), answer(2, "", [], "error"), answer(3, "Hello")]));
    expect(flat()).toEqual(["text:Hel", "text:Hello"]);
  });

  it("streams a context-overflow retry that reuses the failed answer's task and attempt", async () => {
    const { bridge, flat } = setup();
    bridge.attach(view([user(1, "hi")]));
    await bridge.apply(view([user(1, "hi")], streaming(7, 1, "Too")));
    await bridge.apply(view([user(1, "hi"), answer(2, "Too", [], "error")]));
    await bridge.apply(view([user(1, "hi"), answer(2, "Too", [], "error")], streaming(7, 1, "Short")));
    expect(flat()).toEqual(["text:Too", "text:Short"]);
  });

  // The live state pi commits with the failed entry (it replaces or deletes
  // `generation` in that commit, generation.js): a retry for `error`, the
  // run's failure for `aborted`. The bridge relies on no stale partial being left.
  const failedLive: Record<string, LiveState> = {
    error: { run: { taskId: 7, inputs: [], turns: 0 }, generation: { attempt: 1, retry: { at: 5, error: "x" } } } as unknown as LiveState,
    aborted: { runFailure: { taskId: 7, inputs: [], reason: "aborted" } } as unknown as LiveState,
  };
  for (const stopReason of ["aborted", "error"]) {
    it(`skips an ${stopReason} answer's text and tool calls, but counts the step`, async () => {
      const { bridge, flat } = setup();
      bridge.attach(view([user(1, "go")]));
      await bridge.apply(view([user(1, "go"), answer(2, "half", [{ id: "c1", name: "t" }], stopReason)], failedLive[stopReason]));
      await bridge.finish();
      expect(flat()).toEqual([]);
      expect(bridge.totals.steps).toBe(1);
      expect(bridge.totals.input).toBe(10);
      expect(bridge.totals.toolCalls).toEqual([]);
    });
  }

  it("keeps a recovered round's arguments when its answer is in the first view (23 results)", async () => {
    const calls = Array.from({ length: 24 }, (_, i) => ({ id: `c${i}`, name: "grep", args: { q: `q${i}` } }));
    const first = [answer(10, "", calls), ...calls.slice(0, 23).map((c, i) => result(11 + i, c.id, "grep", "ok"))];
    const { bridge, events } = setup();
    bridge.attach(view(first));
    await bridge.apply(view([...first, result(34, "c23", "grep", "last")]));
    expect(events.map((e) => [e.type, e.data.input])).toEqual([["tool_call", { q: "q23" }], ["tool_result", undefined]]);
  });

  it("emits a result whose tool-calling answer it never saw (recovered round older than the window)", async () => {
    const { bridge, flat } = setup();
    bridge.attach(view([result(40, "c9", "grep", "a"), result(41, "c10", "grep", "b")], {}, 39));
    await bridge.apply(view([result(40, "c9", "grep", "a"), result(41, "c10", "grep", "b"), result(42, "c11", "read", "c")], {}, 39));
    expect(flat()).toEqual(["call:c11:{}", "result:c11:c"]);
  });

  it("logs each retry, compaction and run failure once", async () => {
    const { bridge, logs } = setup();
    bridge.attach(view([]));
    const retry = { run: { taskId: 1, inputs: [], turns: 0 }, generation: { attempt: 2, retry: { at: 100, error: "429" } } } as unknown as LiveState;
    await bridge.apply(view([], retry));
    await bridge.apply(view([], retry));
    const compacting = { compactions: [{ taskId: 5, trigger: "threshold", blocking: true, attempt: 1 }] } as unknown as LiveState;
    await bridge.apply(view([], compacting));
    await bridge.apply(view([], compacting));
    const failed = { compactionFailure: { taskId: 5, trigger: "threshold", error: "boom" }, runFailure: { taskId: 1, inputs: [], reason: "model_error", detail: "x" } } as unknown as LiveState;
    await bridge.apply(view([], failed));
    await bridge.apply(view([], failed));
    expect(logs).toEqual(["pi: provider retry", "pi: compaction start", "pi: compaction end", "pi: compaction failed", "pi: run ended without an answer"]);
  });

  it("never rejects when the host throws", async () => {
    const bridge = new LiveBridge({
      emit: () => {
        throw new Error("stream closed");
      },
      log: () => {},
      loadEntries: async () => [],
    });
    bridge.attach(view([]));
    await expect(bridge.apply(view([answer(1, "x")]))).resolves.toBeUndefined();
    await expect(bridge.finish()).resolves.toBeUndefined();
  });
});
