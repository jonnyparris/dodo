/**
 * WatchdogState — typed store of watchdog-related fields.
 *
 * Today this is a passthrough over the `metadata` k/v table on the
 * CodingAgent DO. It groups the 6 `watchdog_*` keys into one typed
 * surface so callers stop reaching in by string key:
 *
 *   watchdog_config                       (JSON)
 *   watchdog_schedule_id                  (string)
 *   watchdog_last_checked_at              (epoch seconds)
 *   watchdog_last_fired_at                (epoch seconds)
 *   watchdog_last_fired_for_prompt_id     (string)
 *   watchdog_fire_count                   (integer)
 *
 * The pure decision lives in `./watchdog` (`decideWatchdog`); the policy
 * adapter lives in `./watchdog-policy` (`evaluateSession`). This module
 * owns *storage* only.
 */

import type { MetadataKv } from "./session-control-plane";
import type { WatchdogConfig } from "./watchdog";

export interface WatchdogSnapshot {
  armed: boolean;
  config: WatchdogConfig | null;
  scheduleId: string | null;
  lastCheckedAt: string | null;
  lastFiredAt: string | null;
  lastFiredForPromptId: string | null;
  fireCount: number;
}

export interface WatchdogState {
  read(): WatchdogSnapshot;
  readConfig(): WatchdogConfig | null;
  readScheduleId(): string | null;
  readLastFiredForPromptId(): string | null;

  install(config: WatchdogConfig, scheduleId: string): void;
  uninstall(): void;

  recordChecked(nowEpoch: number): void;
  recordFired(promptId: string, nowEpoch: number): void;
}

export function createWatchdogState(kv: MetadataKv): WatchdogState {
  function readConfig(): WatchdogConfig | null {
    const raw = kv.read("watchdog_config");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as WatchdogConfig;
    } catch {
      return null;
    }
  }

  return {
    read() {
      const config = readConfig();
      const scheduleId = kv.read("watchdog_schedule_id");
      return {
        armed: !!config && !!scheduleId,
        config,
        scheduleId,
        lastCheckedAt: kv.read("watchdog_last_checked_at"),
        lastFiredAt: kv.read("watchdog_last_fired_at"),
        lastFiredForPromptId: kv.read("watchdog_last_fired_for_prompt_id"),
        fireCount: Number(kv.read("watchdog_fire_count") ?? "0"),
      };
    },

    readConfig,
    readScheduleId: () => kv.read("watchdog_schedule_id"),
    readLastFiredForPromptId: () => kv.read("watchdog_last_fired_for_prompt_id") || null,

    install(config, scheduleId) {
      kv.write("watchdog_config", JSON.stringify(config));
      kv.write("watchdog_schedule_id", scheduleId);
      // Reset fire counters when (re)installing — a new config is a new
      // contract; stale `lastFiredForPromptId` shouldn't block it.
      kv.write("watchdog_last_fired_for_prompt_id", "");
      kv.write("watchdog_fire_count", "0");
    },

    uninstall() {
      // Preserve the "empty-string-as-cleared" convention the existing
      // handler uses — see coding-agent.ts:4008-4009. Some downstream
      // code reads `metadata.watchdog_config` as a presence check.
      kv.write("watchdog_config", "");
      kv.write("watchdog_schedule_id", "");
    },

    recordChecked(nowEpoch) {
      kv.write("watchdog_last_checked_at", String(nowEpoch));
    },

    recordFired(promptId, nowEpoch) {
      kv.write("watchdog_last_fired_at", String(nowEpoch));
      kv.write("watchdog_last_fired_for_prompt_id", promptId);
      const current = Number(kv.read("watchdog_fire_count") ?? "0");
      kv.write("watchdog_fire_count", String(current + 1));
    },
  };
}
