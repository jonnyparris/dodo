import { describe, expect, it, vi } from "vitest";
import { createGoalStateStore } from "../src/goal-state-store";
import { createInMemoryMetadataKv, createSessionControlPlane } from "../src/session-control-plane";
import {
  createSessionLifecycle,
  type FiberDriver,
  type FiberPromptPayload,
  type PromptRepo,
  type SessionLifecycle,
  SOURCE_POLICIES,
} from "../src/session-lifecycle";

/** In-memory FiberDriver that records spawns + lets tests trigger completion. */
function fakeFiberDriver() {
  const spawned: Array<{ method: string; payload: FiberPromptPayload; opts?: { maxRetries?: number }; fiberId: string }> = [];
  const cancelled: string[] = [];
  const promptFiber = new Map<string, string>();
  const driver: FiberDriver = {
    spawnFiber: (method, payload, opts) => {
      const fiberId = `fib-${spawned.length + 1}`;
      spawned.push({ method, payload: payload as FiberPromptPayload, opts, fiberId });
      return fiberId;
    },
    cancelFiber: (id) => {
      cancelled.push(id);
    },
    readPromptFiberId: (promptId) => promptFiber.get(promptId) ?? null,
    setPromptFiberId: (promptId, fiberId) => {
      promptFiber.set(promptId, fiberId);
    },
  };
  return { driver, spawned, cancelled, promptFiber };
}

/** In-memory PromptRepo. */
function fakePromptRepo(emit: (e: { type: string; data: unknown }) => void) {
  const rows: Array<{ promptId: string; content: string; status: string; source: string | null; error?: string; resultMessageId?: string }> = [];
  const queue: Array<{ promptId: string; content: string; authorEmail: string | null; position: number }> = [];
  let posCounter = 0;
  let uuidCounter = 0;
  const repo: PromptRepo = {
    insert: (opts) => {
      rows.push({ ...opts });
    },
    update: (promptId, patch) => {
      const row = rows.find((r) => r.promptId === promptId);
      if (row) Object.assign(row, patch);
    },
    enqueue: (content, authorEmail) => {
      const promptId = `queued-${++uuidCounter}`;
      const position = ++posCounter;
      queue.push({ promptId, content, authorEmail, position });
      return { promptId, position };
    },
    dequeue: () => {
      const next = queue.shift();
      if (!next) return null;
      return { promptId: next.promptId, content: next.content, authorEmail: next.authorEmail };
    },
    emitQueueUpdate: () => {
      emit({ type: "queue_update", data: { queue: queue.map((q) => ({ ...q })) } });
    },
  };
  return { repo, rows, queue };
}

function makeLifecycle(overrides: {
  initialKv?: Record<string, string>;
  uuidSeq?: string[];
} = {}) {
  const kv = createInMemoryMetadataKv(overrides.initialKv ?? {});
  const control = createSessionControlPlane(kv);
  const goal = createGoalStateStore(kv);
  const events: Array<{ type: string; data: unknown }> = [];
  const notifications: Array<unknown> = [];
  const syncCalls: Array<{ status: string; title?: string }> = [];
  const emit = (e: { type: string; data: unknown }) => events.push(e);

  const { driver: fibers, spawned, cancelled, promptFiber } = fakeFiberDriver();
  const { repo: prompts, rows: promptRows, queue: promptQueue } = fakePromptRepo(emit);

  let abortController: AbortController | null = null;
  const uuidSeq = overrides.uuidSeq ? [...overrides.uuidSeq] : null;

  const lifecycle: SessionLifecycle = createSessionLifecycle({
    control,
    goal,
    fibers,
    prompts,
    emit,
    notify: (n) => notifications.push(n),
    syncIndex: async (patch) => {
      syncCalls.push(patch);
    },
    getAbortController: () => abortController,
    setAbortController: (c) => {
      abortController = c;
    },
    readAppConfig: async () => undefined,
    uuid: uuidSeq
      ? () => uuidSeq.shift() ?? `uuid-fallback-${Math.random()}`
      : () => `uuid-${Math.random().toString(36).slice(2, 8)}`,
  });

  return {
    kv,
    control,
    goal,
    lifecycle,
    events,
    notifications,
    syncCalls,
    spawned,
    cancelled,
    promptFiber,
    promptRows,
    promptQueue,
    setAbortController: (c: AbortController | null) => {
      abortController = c;
    },
    getAbortController: () => abortController,
  };
}

describe("SessionLifecycle.start", () => {
  it("user prompt: when idle, starts a fiber and emits state", async () => {
    const h = makeLifecycle({ uuidSeq: ["prompt-1"] });
    const r = await h.lifecycle.start({ source: "user", content: "Hello", authorEmail: "u@x" });
    expect(r).toEqual({ kind: "started", promptId: "prompt-1", fiberId: "fib-1", title: "Hello" });
    expect(h.kv.read("active_prompt_id")).toBe("prompt-1");
    expect(h.kv.read("status")).toBe("running");
    expect(h.kv.read("title")).toBe("Hello");
    expect(h.spawned[0]?.payload).toMatchObject({ promptId: "prompt-1", content: "Hello", authorEmail: "u@x", title: "Hello" });
    expect(h.spawned[0]?.opts?.maxRetries).toBe(3);
    expect(h.syncCalls).toEqual([{ status: "running", title: "Hello" }]);
    expect(h.events.filter((e) => e.type === "state")).toHaveLength(1);
  });

  it("user prompt: rejects empty content", async () => {
    const h = makeLifecycle();
    const r = await h.lifecycle.start({ source: "user", content: "   " });
    expect(r).toEqual({ kind: "rejected", reason: "empty", message: "Empty prompt content" });
    expect(h.kv.read("active_prompt_id")).toBeNull();
  });

  it("user prompt: queues when busy", async () => {
    const h = makeLifecycle({
      initialKv: { active_prompt_id: "running-1", status: "running" },
    });
    const r = await h.lifecycle.start({ source: "user", content: "second", authorEmail: "u@x" });
    expect(r.kind).toBe("queued");
    if (r.kind === "queued") {
      expect(r.position).toBe(1);
    }
    expect(h.promptQueue).toHaveLength(1);
    // No fiber spawn while busy
    expect(h.spawned).toHaveLength(0);
  });

  it("watchdog: skips silently when busy", async () => {
    const h = makeLifecycle({ initialKv: { active_prompt_id: "p1", status: "running" } });
    const r = await h.lifecycle.start({ source: "watchdog", content: "nudge" });
    expect(r).toEqual({ kind: "skipped", reason: "busy" });
    expect(h.spawned).toHaveLength(0);
  });

  it("watchdog: starts with maxRetries=1 and authorEmail='watchdog' fallback", async () => {
    const h = makeLifecycle({ uuidSeq: ["w-1"] });
    await h.lifecycle.start({ source: "watchdog", content: "nudge body" });
    expect(h.spawned[0]?.opts?.maxRetries).toBe(1);
    expect(h.spawned[0]?.payload.authorEmail).toBe("watchdog");
    // Watchdog policy: emitState=false, syncIndex=false
    expect(h.syncCalls).toHaveLength(0);
    expect(h.events.filter((e) => e.type === "state")).toHaveLength(0);
  });

  it("cron: skips silently when busy", async () => {
    const h = makeLifecycle({ initialKv: { active_prompt_id: "p1", status: "running" } });
    const r = await h.lifecycle.start({ source: "cron", content: "cron body" });
    expect(r.kind).toBe("skipped");
  });

  it("image-gen: rejects when busy", async () => {
    const h = makeLifecycle({ initialKv: { active_prompt_id: "p1", status: "running" } });
    const r = await h.lifecycle.start({ source: "image-gen", content: "a cat" });
    expect(r.kind).toBe("rejected");
    if (r.kind === "rejected") expect(r.reason).toBe("busy");
  });

  it("image-gen: starts without spawning a fiber (synchronous policy)", async () => {
    const h = makeLifecycle({ uuidSeq: ["img-1"] });
    const r = await h.lifecycle.start({ source: "image-gen", content: "a cat" });
    expect(r.kind).toBe("started");
    if (r.kind === "started") expect(r.fiberId).toBeNull();
    expect(h.spawned).toHaveLength(0);
    expect(h.kv.read("active_prompt_id")).toBe("img-1");
  });

  it("derives a long-content title truncated to 72 chars + ellipsis", async () => {
    const h = makeLifecycle();
    const longContent = "x".repeat(100);
    const r = await h.lifecycle.start({ source: "user", content: longContent });
    expect(r.kind).toBe("started");
    if (r.kind === "started") expect(r.title).toBe("x".repeat(72) + "…");
  });

  it("preserves existing title when one is already set", async () => {
    const h = makeLifecycle({ initialKv: { title: "Original title" }, uuidSeq: ["p-1"] });
    const r = await h.lifecycle.start({ source: "user", content: "new content" });
    if (r.kind === "started") expect(r.title).toBe("Original title");
    expect(h.kv.read("title")).toBe("Original title");
  });
});

describe("SessionLifecycle.finish", () => {
  it("completed: clears active_prompt_id, sets status=idle, updates prompt row", async () => {
    const h = makeLifecycle({ uuidSeq: ["p-1"] });
    await h.lifecycle.start({ source: "user", content: "hi" });
    await h.lifecycle.finish("p-1", { kind: "completed", text: "ok" });
    expect(h.kv.read("active_prompt_id")).toBeNull();
    expect(h.kv.read("status")).toBe("idle");
    const row = h.promptRows.find((r) => r.promptId === "p-1");
    expect(row?.status).toBe("completed");
  });

  it("stale finish (different active prompt) is ignored", async () => {
    const h = makeLifecycle({ uuidSeq: ["p-current"] });
    await h.lifecycle.start({ source: "user", content: "active" });
    await h.lifecycle.finish("p-stale", { kind: "completed" });
    expect(h.kv.read("active_prompt_id")).toBe("p-current");
    expect(h.kv.read("status")).toBe("running");
  });

  it("queued user prompt wins over goal-autocontinue", async () => {
    const h = makeLifecycle({ uuidSeq: ["p-1", "p-2", "p-3"] });
    h.goal.set({ text: "ship it", maxTurns: 10 });
    // Start initial user prompt
    await h.lifecycle.start({ source: "user", content: "first" });
    // Queue another user prompt while p-1 is running
    await h.lifecycle.start({ source: "user", content: "second" });
    expect(h.promptQueue).toHaveLength(1);
    // Finish p-1 completed: should dequeue p-2 (NOT auto-continue)
    await h.lifecycle.finish("p-1", { kind: "completed" });
    // After dequeue, the queued prompt got a new id from uuidSeq
    expect(h.kv.read("active_prompt_id")).toBe("p-2");
    expect(h.kv.read("status")).toBe("running");
    expect(h.promptQueue).toHaveLength(0);
    // Goal turns NOT incremented because auto-continue did not fire
    expect(h.goal.read().turnsUsed).toBe(0);
  });

  it("goal-autocontinue fires when no queued prompt and goal is active", async () => {
    const h = makeLifecycle({ uuidSeq: ["p-1", "p-2"] });
    h.goal.set({ text: "ship it", maxTurns: 10 });
    await h.lifecycle.start({ source: "user", content: "begin" });
    await h.lifecycle.finish("p-1", { kind: "completed" });
    // Auto-continue should have started a new prompt
    expect(h.kv.read("active_prompt_id")).toBe("p-2");
    expect(h.goal.read().turnsUsed).toBe(1);
    // And the new prompt's source-derived author is "goal-autocontinue"
    expect(h.spawned[1]?.payload.authorEmail).toBe("goal-autocontinue");
  });

  it("auto-continue at budget edge flips status=exhausted and notifies", async () => {
    const h = makeLifecycle({ uuidSeq: ["p-1"] });
    h.goal.set({ text: "ship it", maxTurns: 1 });
    await h.lifecycle.start({ source: "user", content: "begin" });
    await h.lifecycle.finish("p-1", { kind: "completed" });
    // Goal exhausted; no second prompt spawned
    expect(h.goal.read().status).toBe("exhausted");
    expect(h.spawned).toHaveLength(1);
    // Two notifications: (1) prompt-complete from finish; (2) goal-exhausted
    // from auto-continue at budget edge.
    expect(h.notifications).toHaveLength(2);
    expect((h.notifications[0] as { kind: string }).kind).toBe("prompt-complete");
    expect((h.notifications[1] as { kind: string }).kind).toBe("prompt-error");
  });

  it("aborted finish does NOT trigger dequeue or auto-continue", async () => {
    const h = makeLifecycle({ uuidSeq: ["p-1"] });
    h.goal.set({ text: "ship it", maxTurns: 10 });
    await h.lifecycle.start({ source: "user", content: "begin" });
    // Also enqueue another to prove dequeue is skipped
    await h.lifecycle.start({ source: "user", content: "queued" });
    await h.lifecycle.finish("p-1", { kind: "aborted" });
    expect(h.kv.read("active_prompt_id")).toBeNull();
    expect(h.kv.read("status")).toBe("idle");
    expect(h.promptQueue).toHaveLength(1); // queued prompt still there
    expect(h.goal.read().turnsUsed).toBe(0); // no auto-continue
  });

  it("failed finish marks the prompt failed and does NOT auto-continue", async () => {
    const h = makeLifecycle({ uuidSeq: ["p-1"] });
    h.goal.set({ text: "x", maxTurns: 10 });
    await h.lifecycle.start({ source: "user", content: "go" });
    await h.lifecycle.finish("p-1", { kind: "failed", error: "boom" });
    const row = h.promptRows.find((r) => r.promptId === "p-1");
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("boom");
    expect(h.goal.read().turnsUsed).toBe(0);
  });
});

describe("SessionLifecycle.abortActive", () => {
  it("no-op when nothing is active", async () => {
    const h = makeLifecycle();
    const r = await h.lifecycle.abortActive();
    expect(r).toEqual({ kind: "noop" });
  });

  it("cancels the AbortController, the fiber, and marks the prompt aborted", async () => {
    const h = makeLifecycle({ uuidSeq: ["p-1"] });
    await h.lifecycle.start({ source: "user", content: "running" });
    const controller = new AbortController();
    const abortSpy = vi.spyOn(controller, "abort");
    h.setAbortController(controller);

    const r = await h.lifecycle.abortActive();
    expect(r).toEqual({ kind: "aborted", promptId: "p-1" });
    expect(abortSpy).toHaveBeenCalled();
    expect(h.cancelled).toEqual(["fib-1"]);
    expect(h.kv.read("active_prompt_id")).toBeNull();
    expect(h.kv.read("status")).toBe("idle");
    const row = h.promptRows.find((r) => r.promptId === "p-1");
    expect(row?.status).toBe("aborted");
    expect(h.getAbortController()).toBeNull();
  });
});

describe("SOURCE_POLICIES (invariants)", () => {
  it("every PromptSource has a policy entry", () => {
    const sources: Array<string> = ["user", "watchdog", "cron", "queue", "goal-autocontinue", "image-gen"];
    for (const s of sources) {
      expect(SOURCE_POLICIES[s as keyof typeof SOURCE_POLICIES]).toBeDefined();
    }
  });

  it("image-gen is the only synchronous source", () => {
    for (const [source, policy] of Object.entries(SOURCE_POLICIES)) {
      if (source === "image-gen") expect(policy.synchronous).toBe(true);
      else expect(policy.synchronous).toBeFalsy();
    }
  });

  it("user is the only source that queues on busy", () => {
    for (const [source, policy] of Object.entries(SOURCE_POLICIES)) {
      if (source === "user") expect(policy.onBusy).toBe("queue");
      else if (source === "image-gen") expect(policy.onBusy).toBe("reject");
      else expect(policy.onBusy).toBe("skip");
    }
  });
});
