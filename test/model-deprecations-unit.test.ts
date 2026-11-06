/**
 * Workers AI models removed on 2026-11-15: the remap table and helpers.
 */
import { describe, expect, it } from "vitest";
import { FALLBACK_MODELS, WORKERS_AI_MODELS } from "../src/model-catalog";
import { pickerModels } from "../src/shared-index";
import {
  DEFAULT_WORKERS_AI_MODEL,
  DEPRECATED_WORKERS_AI_MODELS,
  isDeprecatedWorkersAiModel,
  remapConfigModels,
  remapDeprecatedModel,
  SMALL_WORKERS_AI_MODEL,
} from "../src/model-deprecations";

describe("model deprecations", () => {
  it("lists the 24 models from the 2026-11-05 changelog, each mapped to a live model", () => {
    const ids = Object.keys(DEPRECATED_WORKERS_AI_MODELS);
    expect(ids).toHaveLength(24);
    for (const id of ids) expect(id.startsWith("@cf/")).toBe(true);
    for (const replacement of Object.values(DEPRECATED_WORKERS_AI_MODELS)) {
      expect([DEFAULT_WORKERS_AI_MODEL, SMALL_WORKERS_AI_MODEL]).toContain(replacement);
      expect(isDeprecatedWorkersAiModel(replacement)).toBe(false);
    }
  });

  it("remaps removed ids and leaves everything else alone", () => {
    expect(remapDeprecatedModel("@cf/zai-org/glm-5.3-flash")).toBe(DEFAULT_WORKERS_AI_MODEL);
    expect(remapDeprecatedModel("@cf/moonshotai/kimi-k2.6")).toBe(DEFAULT_WORKERS_AI_MODEL);
    expect(remapDeprecatedModel("@cf/deepseek-ai/deepseek-v4-flash-0731")).toBe(DEFAULT_WORKERS_AI_MODEL);
    expect(remapDeprecatedModel("@cf/meta/llama-3.2-1b-instruct")).toBe(SMALL_WORKERS_AI_MODEL);
    expect(remapDeprecatedModel(" @cf/zai-org/glm-5.2 ")).toBe(DEFAULT_WORKERS_AI_MODEL);
    expect(remapDeprecatedModel("workers-ai/@cf/moonshotai/kimi-k2.7-code")).toBe(`workers-ai/${DEFAULT_WORKERS_AI_MODEL}`);
    for (const id of ["@cf/zai-org/glm-5.3", "@cf/google/gemma-4-26b-a4b-it", "anthropic/claude-sonnet-4-6", "claude-test", ""]) {
      expect(remapDeprecatedModel(id)).toBe(id);
    }
    expect(remapDeprecatedModel(undefined)).toBeUndefined();
  });

  it("the picker's hardcoded lists offer no removed model", () => {
    for (const m of [...FALLBACK_MODELS, ...WORKERS_AI_MODELS]) {
      expect(isDeprecatedWorkersAiModel(m.id)).toBe(false);
    }
    expect(WORKERS_AI_MODELS[0].id).toBe(DEFAULT_WORKERS_AI_MODEL);
    expect(WORKERS_AI_MODELS.map((m) => m.id)).toContain(SMALL_WORKERS_AI_MODEL);
  });

  it("remapConfigModels rewrites only the model fields, and returns the same object when nothing changes", () => {
    const stored = { sessionId: "s", model: "@cf/zai-org/glm-5.3-flash", exploreModel: "@cf/meta/llama-3.2-3b-instruct", taskModel: "anthropic/claude-haiku-4-5" };
    expect(remapConfigModels(stored)).toEqual({ ...stored, model: DEFAULT_WORKERS_AI_MODEL, exploreModel: SMALL_WORKERS_AI_MODEL });
    expect(stored.model).toBe("@cf/zai-org/glm-5.3-flash");
    const live = { model: DEFAULT_WORKERS_AI_MODEL, exploreModel: undefined };
    expect(remapConfigModels(live)).toBe(live);
    expect(remapConfigModels(null)).toBeNull();
  });

  it("pickerModels drops removed models from the base list and the Workers AI list, and dedupes", () => {
    const m = (id: string) => ({ id });
    const out = pickerModels(
      [m("anthropic/claude-sonnet-4-6"), m("@cf/zai-org/glm-5.3-flash")],
      [m("@cf/moonshotai/kimi-k2.6"), m(DEFAULT_WORKERS_AI_MODEL), m("anthropic/claude-sonnet-4-6"), m(DEFAULT_WORKERS_AI_MODEL), m("workers-ai/@cf/zai-org/glm-5.2")],
    );
    expect(out.map((x) => x.id)).toEqual(["anthropic/claude-sonnet-4-6", DEFAULT_WORKERS_AI_MODEL]);
  });
});
