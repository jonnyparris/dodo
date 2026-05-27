import { describe, expect, it } from "vitest";
import { createInMemoryMetadataKv } from "../src/session-control-plane";
import type { WatchdogConfig } from "../src/watchdog";
import { createWatchdogState } from "../src/watchdog-state";

const CONFIG: WatchdogConfig = {
  stallSeconds: 600,
  action: "notify",
  checkCron: "*/5 * * * *",
};

describe("WatchdogState", () => {
  it("read() returns disarmed defaults when nothing is set", () => {
    const ws = createWatchdogState(createInMemoryMetadataKv());
    const snap = ws.read();
    expect(snap.armed).toBe(false);
    expect(snap.config).toBeNull();
    expect(snap.scheduleId).toBeNull();
    expect(snap.fireCount).toBe(0);
  });

  it("install() persists config + scheduleId and resets fire counters", () => {
    const kv = createInMemoryMetadataKv({
      watchdog_last_fired_for_prompt_id: "stale-prompt",
      watchdog_fire_count: "5",
    });
    const ws = createWatchdogState(kv);
    ws.install(CONFIG, "sched-1");
    expect(kv.read("watchdog_schedule_id")).toBe("sched-1");
    expect(JSON.parse(kv.read("watchdog_config") ?? "{}")).toEqual(CONFIG);
    expect(kv.read("watchdog_last_fired_for_prompt_id")).toBe("");
    expect(kv.read("watchdog_fire_count")).toBe("0");
  });

  it("read() reports armed when config+scheduleId are present", () => {
    const ws = createWatchdogState(createInMemoryMetadataKv());
    ws.install(CONFIG, "sched-2");
    const snap = ws.read();
    expect(snap.armed).toBe(true);
    expect(snap.config).toEqual(CONFIG);
    expect(snap.scheduleId).toBe("sched-2");
  });

  it("uninstall() clears config and scheduleId (preserves empty-string convention)", () => {
    const kv = createInMemoryMetadataKv();
    const ws = createWatchdogState(kv);
    ws.install(CONFIG, "sched-3");
    ws.uninstall();
    expect(kv.read("watchdog_config")).toBe("");
    expect(kv.read("watchdog_schedule_id")).toBe("");
    expect(ws.read().armed).toBe(false);
  });

  it("recordFired increments count and records prompt id", () => {
    const kv = createInMemoryMetadataKv();
    const ws = createWatchdogState(kv);
    ws.install(CONFIG, "sched-4");
    ws.recordFired("prompt-x", 1_700_000_000);
    ws.recordFired("prompt-y", 1_700_000_500);
    expect(kv.read("watchdog_fire_count")).toBe("2");
    expect(kv.read("watchdog_last_fired_for_prompt_id")).toBe("prompt-y");
    expect(kv.read("watchdog_last_fired_at")).toBe("1700000500");
  });

  it("recordChecked stamps last_checked_at without touching fire counters", () => {
    const kv = createInMemoryMetadataKv();
    const ws = createWatchdogState(kv);
    ws.install(CONFIG, "sched-5");
    ws.recordFired("p1", 1000);
    ws.recordChecked(2000);
    expect(kv.read("watchdog_last_checked_at")).toBe("2000");
    expect(kv.read("watchdog_fire_count")).toBe("1");
  });

  it("gracefully tolerates malformed watchdog_config JSON", () => {
    const kv = createInMemoryMetadataKv({
      watchdog_config: "{not json",
      watchdog_schedule_id: "sched",
    });
    const ws = createWatchdogState(kv);
    expect(ws.readConfig()).toBeNull();
    expect(ws.read().armed).toBe(false);
  });
});
