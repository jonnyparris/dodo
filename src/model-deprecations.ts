/**
 * Workers AI models removed on 2026-11-15 (changelog 2026-11-05, "Planned
 * model deprecations"). The models API lists `planned_deprecation_date`
 * 2026-11-20 for all 24; the changelog's 11-15 is the date to plan for.
 * After the removal a request for any of them fails.
 *
 * Saved config (`model`, `exploreModel`, `taskModel`), session model
 * overrides and per-call subagent `model` args can still hold these ids, so
 * they are remapped when read, not migrated in storage. The stored value
 * stays until something next writes that config (a user save, or a session
 * rebuilding its config from the owner's). The remap applies now, before the removal date, on purpose:
 * it moves every saved config off these models in one deploy instead of
 * failing on the day.
 *
 * Replacements follow the changelog's recommendations: frontier and
 * reasoning models go to DeepSeek V4.1 Flash 1017 (fastest and cheapest on
 * Dodo's 2026-10-21 bench); small models go to Gemma 4 26B. The non-chat
 * models (TTS, image, speech, vision, embeddings) can't work as a chat model,
 * so a config that names one gets the default chat replacement too.
 */

export const DEFAULT_WORKERS_AI_MODEL = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
export const SMALL_WORKERS_AI_MODEL = "@cf/google/gemma-4-26b-a4b-it";

const FRONTIER = DEFAULT_WORKERS_AI_MODEL;
const SMALL = SMALL_WORKERS_AI_MODEL;

export const DEPRECATED_WORKERS_AI_MODELS: Readonly<Record<string, string>> = Object.freeze({
  // Text generation (16)
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b": FRONTIER,
  "@cf/nvidia/nemotron-3-120b-a12b": FRONTIER,
  "@cf/deepseek-ai/deepseek-v4-pro-0813": FRONTIER,
  "@cf/deepseek-ai/deepseek-v4-flash-0731": FRONTIER,
  "@cf/qwen/qwq-32b": FRONTIER,
  "@cf/qwen/qwen3-30b-a3b-fp8": SMALL,
  "@cf/moonshotai/kimi-k2.6": FRONTIER,
  "@cf/moonshotai/kimi-k2.7-code": FRONTIER,
  "@cf/zai-org/glm-5.2": FRONTIER,
  "@cf/zai-org/glm-5.3-flash": FRONTIER,
  "@cf/meta-llama/llama-2-7b-chat-hf-lora": SMALL,
  "@cf/google/gemma-2b-it-lora": SMALL,
  "@cf/google/gemma-7b-it-lora": SMALL,
  "@cf/meta/llama-3.1-8b-instruct-fp8": SMALL,
  "@cf/meta/llama-3.2-1b-instruct": SMALL,
  "@cf/meta/llama-3.2-3b-instruct": SMALL,
  // Not chat models (8): only reachable here through a bad config value.
  "@cf/myshell-ai/melotts": FRONTIER,
  "@cf/stabilityai/stable-diffusion-xl-base-1.0": FRONTIER,
  "@cf/runwayml/stable-diffusion-v1-5-inpainting": FRONTIER,
  "@cf/bytedance/stable-diffusion-xl-lightning": FRONTIER,
  "@cf/lykon/dreamshaper-8-lcm": FRONTIER,
  "@cf/openai/whisper-tiny-en": FRONTIER,
  "@cf/llava-hf/llava-1.5-7b-hf": FRONTIER,
  "@cf/google/embeddinggemma-300m": FRONTIER,
});

/** Strip an optional `workers-ai/` wire prefix so both spellings match. */
function bareId(id: string): string {
  return id.startsWith("workers-ai/") ? id.slice("workers-ai/".length) : id;
}

export function isDeprecatedWorkersAiModel(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(DEPRECATED_WORKERS_AI_MODELS, bareId(id.trim()));
}

/**
 * The id to use in place of `id`: its replacement when `id` is a removed
 * Workers AI model, otherwise `id` unchanged. Keeps a `workers-ai/` prefix
 * if the input had one. undefined in, undefined out.
 */
export function remapDeprecatedModel<T extends string | undefined>(id: T): T {
  if (typeof id !== "string") return id;
  const trimmed = id.trim();
  const bare = bareId(trimmed);
  if (!Object.prototype.hasOwnProperty.call(DEPRECATED_WORKERS_AI_MODELS, bare)) return id;
  const replacement = DEPRECATED_WORKERS_AI_MODELS[bare];
  return (trimmed === bare ? replacement : `workers-ai/${replacement}`) as T;
}

/**
 * Copy of `config` with `model` / `exploreModel` / `taskModel` remapped.
 * For session configs persisted before the removal (CodingAgent's
 * `_think_config` row), which cron, goal and watchdog turns read without
 * going back to the owner's config. Returns `config` itself when nothing
 * changes.
 */
export function remapConfigModels<T>(config: T): T {
  if (!config || typeof config !== "object") return config;
  const c = config as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = { ...c };
  for (const field of ["model", "exploreModel", "taskModel"]) {
    const value = c[field];
    if (typeof value !== "string") continue;
    const next = remapDeprecatedModel(value);
    if (next !== value) {
      out[field] = next;
      changed = true;
    }
  }
  return changed ? (out as T) : config;
}
