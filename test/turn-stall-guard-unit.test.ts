/**
 * The turn stall guard fails a turn that stops making progress anywhere,
 * including before the first model request (10-21: f25c9901 hung 30 min
 * with no AI Gateway traffic; the hang point was never found).
 */
import { describe, expect, it } from "vitest";
import {
  createTurnStallGuard,
  DEFAULT_TURN_STALL_IDLE_MS,
  DEFAULT_TURN_STALL_LONG_MS,
  TurnStallError,
  type TurnStallGuard,
  turnStallLimitsFromEnv,
} from "../src/turn-stall-guard";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = <T>() => new Promise<T>(() => {});
/** Race a step that never settles; return the stall it fails with. */
const stallOf = (guard: TurnStallGuard): Promise<TurnStallError> =>
  guard.run(never<never>()).catch((e: unknown) => e as TurnStallError);

describe("turn stall guard", () => {
  it("fails a step that never settles and names it", async () => {
    let stalled: TurnStallError | null = null;
    const guard = createTurnStallGuard({ limits: { idleMs: 60, longMs: 500 }, onStall: (e) => (stalled = e) });
    guard.touch("connect_mcp");
    const err = await stallOf(guard);
    expect(err).toBeInstanceOf(TurnStallError);
    expect(err.info.phase).toBe("connect_mcp");
    expect(err.message).toContain("last step: connect_mcp");
    expect(stalled).toBe(err);
    expect(guard.fired).toBe(err);
  });

  it("keeps a turn alive while progress keeps coming, past the limit in total", async () => {
    const guard = createTurnStallGuard({ limits: { idleMs: 80, longMs: 500 } });
    const work = (async () => {
      for (let i = 0; i < 8; i++) {
        await sleep(25);
        guard.event({ type: "message_update" });
      }
      return "done";
    })();
    expect(await guard.run(work)).toBe("done");
    expect(guard.fired).toBeNull();
    guard.stop();
  });

  it("gives an open tool call the long limit, then the idle limit again after it ends", async () => {
    const guard = createTurnStallGuard({ limits: { idleMs: 50, longMs: 400 } });
    guard.event({ type: "tool_execution_start", toolCallId: "c1", toolName: "ci_run" });
    await sleep(150); // past idle, inside long
    expect(guard.fired).toBeNull();
    guard.event({ type: "tool_execution_end", toolCallId: "c1", toolName: "ci_run" });
    const err = await stallOf(guard);
    expect(err).toBeInstanceOf(TurnStallError);
    expect(err.info.limitMs).toBe(50);
    expect(err.info.openTools).toEqual([]);
  });

  it("fails a tool call that runs past the long limit and names the tool", async () => {
    const guard = createTurnStallGuard({ limits: { idleMs: 30, longMs: 120 } });
    guard.event({ type: "tool_execution_start", toolCallId: "c1", toolName: "mcp__x__slow" });
    const started = Date.now();
    const err = await stallOf(guard);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(err.info.openTools).toEqual(["mcp__x__slow"]);
    expect(err.message).toContain("waiting on tool mcp__x__slow");
  });

  it("does nothing once stopped, and nothing when turned off", async () => {
    let fired = 0;
    const stopped = createTurnStallGuard({ limits: { idleMs: 30, longMs: 30 }, onStall: () => fired++ });
    stopped.stop();
    const off = createTurnStallGuard({ limits: { idleMs: 0, longMs: 0 }, onStall: () => fired++ });
    await sleep(80);
    expect(fired).toBe(0);
    expect(await off.run(Promise.resolve(1))).toBe(1);
  });

  it("calls onProgress on every touch and event", () => {
    let n = 0;
    const guard = createTurnStallGuard({ limits: { idleMs: 1000, longMs: 1000 }, onProgress: () => n++ });
    guard.touch("a");
    guard.event({ type: "message_start" });
    guard.stop();
    expect(n).toBe(2);
  });

  it("reads limits from env: defaults, overrides, 0 = off, long never below idle", () => {
    expect(turnStallLimitsFromEnv({})).toEqual({ idleMs: DEFAULT_TURN_STALL_IDLE_MS, longMs: DEFAULT_TURN_STALL_LONG_MS });
    expect(turnStallLimitsFromEnv({ TURN_STALL_SECONDS: "600", TURN_STALL_TOOL_SECONDS: "1200" })).toEqual({ idleMs: 600_000, longMs: 1_200_000 });
    expect(turnStallLimitsFromEnv({ TURN_STALL_SECONDS: "0" })).toEqual({ idleMs: 0, longMs: 0 });
    expect(turnStallLimitsFromEnv({ TURN_STALL_SECONDS: "3600" })).toEqual({ idleMs: 3_600_000, longMs: 3_600_000 });
    expect(turnStallLimitsFromEnv({ TURN_STALL_SECONDS: "abc" }).idleMs).toBe(DEFAULT_TURN_STALL_IDLE_MS);
  });
});
