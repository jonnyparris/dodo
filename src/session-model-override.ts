/**
 * Per-session model override.
 *
 * By default every prompt runs on the owner's saved config: the routes send
 * `x-dodo-model` from UserControl on each prompt, and subagents read
 * `exploreModel` / `taskModel` from the same config when they start. An
 * override pins one session to other models without touching that global
 * config, so two sessions can run side by side on different models
 * (bench/model-ab.ts).
 *
 * Set via `model` / `exploreModel` / `taskModel` on POST /session/:id/prompt
 * (and MCP `send_prompt`). A value is kept for later prompts in the session.
 * An empty string removes it. Stored as plain `metadata` rows.
 */

import { z } from "zod";
import type { MetadataKv } from "./session-control-plane";

export const MODEL_OVERRIDE_FIELDS = ["model", "exploreModel", "taskModel"] as const;
export type ModelOverrideField = (typeof MODEL_OVERRIDE_FIELDS)[number];
export type SessionModelOverride = Partial<Record<ModelOverrideField, string>>;

const KEYS: Record<ModelOverrideField, string> = {
  model: "session_model_override",
  exploreModel: "session_explore_model_override",
  taskModel: "session_task_model_override",
};

/**
 * Model id as it appears in config (`@cf/vendor/model`, `anthropic/claude-…`).
 * Empty string = clear. No whitespace or control characters, because the value
 * ends up in headers and gateway URLs.
 */
export const modelOverrideValueSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9@._:/+-]*$/, "Invalid model id");

export interface ModelOverrideStore {
  read(): SessionModelOverride;
  /** Apply a patch: a non-empty value sets the field, "" clears it, undefined leaves it alone. */
  apply(patch: SessionModelOverride): void;
}

export function createModelOverrideStore(kv: MetadataKv): ModelOverrideStore {
  return {
    read() {
      const out: SessionModelOverride = {};
      for (const field of MODEL_OVERRIDE_FIELDS) {
        const value = kv.read(KEYS[field]);
        if (value) out[field] = value;
      }
      return out;
    },
    apply(patch) {
      for (const field of MODEL_OVERRIDE_FIELDS) {
        const value = patch[field];
        if (value === undefined) continue;
        const trimmed = value.trim();
        if (trimmed) kv.write(KEYS[field], trimmed);
        else kv.delete(KEYS[field]);
      }
    },
  };
}

/** Pick the override fields out of a parsed prompt body. */
export function modelOverridePatch(input: Partial<Record<ModelOverrideField, string | undefined>>): SessionModelOverride {
  const patch: SessionModelOverride = {};
  for (const field of MODEL_OVERRIDE_FIELDS) {
    if (input[field] !== undefined) patch[field] = input[field];
  }
  return patch;
}

/**
 * Overlay the override on a config: override fields win, everything else is
 * left as it was. Used for the session config and for the config handed to
 * explore/task facets.
 */
export function withModelOverride<T extends { model: string; exploreModel?: string; taskModel?: string }>(
  config: T,
  override: SessionModelOverride,
): T {
  return {
    ...config,
    ...(override.model ? { model: override.model } : {}),
    ...(override.exploreModel ? { exploreModel: override.exploreModel } : {}),
    ...(override.taskModel ? { taskModel: override.taskModel } : {}),
  };
}
