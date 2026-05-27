import { describe, expect, it } from "vitest";
import { createGoalStateStore } from "../src/goal-state-store";
import { createInMemoryMetadataKv } from "../src/session-control-plane";

describe("GoalStateStore", () => {
  it("read() returns 'none' defaults when nothing is set", () => {
    const store = createGoalStateStore(createInMemoryMetadataKv());
    const state = store.read();
    expect(state.status).toBe("none");
    expect(state.text).toBeNull();
    expect(state.turnsUsed).toBe(0);
    expect(state.maxTurns).toBe(50);
  });

  it("set() persists text, resets turn counter, clears summary", () => {
    const kv = createInMemoryMetadataKv({ goal_summary: "stale" });
    const store = createGoalStateStore(kv);
    const state = store.set({ text: "Ship the refactor", maxTurns: 20 });
    expect(state.text).toBe("Ship the refactor");
    expect(state.status).toBe("active");
    expect(state.turnsUsed).toBe(0);
    expect(state.maxTurns).toBe(20);
    expect(state.summary).toBeNull();
  });

  it("set() caps maxTurns at HARD_GOAL_MAX_TURNS (200) and floors at 1", () => {
    const store = createGoalStateStore(createInMemoryMetadataKv());
    expect(store.set({ text: "x", maxTurns: 99999 }).maxTurns).toBe(200);
    expect(store.set({ text: "x", maxTurns: 0 }).maxTurns).toBe(1);
    expect(store.set({ text: "x", maxTurns: -5 }).maxTurns).toBe(1);
  });

  it("set() records the optional role; omitting it clears any prior role", () => {
    const kv = createInMemoryMetadataKv({ goal_role: "stale-role" });
    const store = createGoalStateStore(kv);
    store.set({ text: "x" });
    expect(kv.read("goal_role")).toBeNull();
    store.set({ text: "y", role: "autopilot" });
    expect(kv.read("goal_role")).toBe("autopilot");
  });

  it("updateStatus() flips status and persists optional summary", () => {
    const store = createGoalStateStore(createInMemoryMetadataKv());
    store.set({ text: "x" });
    const after = store.updateStatus("done", "All clear");
    expect(after.status).toBe("done");
    expect(after.summary).toBe("All clear");
  });

  it("incrementTurns() increments and flips status to 'exhausted' on budget", () => {
    const store = createGoalStateStore(createInMemoryMetadataKv());
    store.set({ text: "x", maxTurns: 3 });
    expect(store.incrementTurns().turnsUsed).toBe(1);
    expect(store.incrementTurns().turnsUsed).toBe(2);
    const final = store.incrementTurns();
    expect(final.turnsUsed).toBe(3);
    expect(final.status).toBe("exhausted");
  });

  it("incrementTurns() does NOT clobber an already-terminal status when budget not yet hit", () => {
    const store = createGoalStateStore(createInMemoryMetadataKv());
    store.set({ text: "x", maxTurns: 10 });
    store.updateStatus("done", "early exit");
    // Incrementing afterwards bumps the counter but leaves status alone
    // because we haven't reached maxTurns yet.
    const after = store.incrementTurns();
    expect(after.turnsUsed).toBe(1);
    expect(after.status).toBe("done");
  });

  it("clear() removes all goal_* keys", () => {
    const kv = createInMemoryMetadataKv();
    const store = createGoalStateStore(kv);
    store.set({ text: "x", role: "autopilot" });
    store.clear();
    expect(kv.read("goal_text")).toBeNull();
    expect(kv.read("goal_status")).toBeNull();
    expect(kv.read("goal_role")).toBeNull();
    expect(store.read().status).toBe("none");
  });
});
