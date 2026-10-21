import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { describe, expect, it } from "vitest";
import { FALLBACK_MODELS } from "../src/model-catalog";

type PiCatalog = Record<string, { cost: { input: number; output: number }; contextWindow: number }>;

// Dodo ids are `vendor/model`; each vendor's pi-ai catalog keys by the bare id.
const CATALOG_BY_VENDOR: Record<string, PiCatalog> = {
  anthropic: ANTHROPIC_MODELS as unknown as PiCatalog,
  openai: OPENAI_MODELS as unknown as PiCatalog,
  google: GOOGLE_MODELS as unknown as PiCatalog,
  deepseek: DEEPSEEK_MODELS as unknown as PiCatalog,
};

// Ids missing from pi-ai's bundled catalog, so their prices go unchecked.
// Anything else must resolve.
const UNCHECKED = new Set<string>();

function piModel(id: string) {
  const slash = id.indexOf("/");
  return CATALOG_BY_VENDOR[id.slice(0, slash)]?.[id.slice(slash + 1)];
}

describe("FALLBACK_MODELS prices", () => {
  it.each(FALLBACK_MODELS.filter((m) => !UNCHECKED.has(m.id)).map((m) => [m.id, m] as const))(
    "%s matches pi-ai's bundled catalog (USD per 1M tokens, base tier)",
    (id, model) => {
      const pi = piModel(id);
      expect(pi, `${id} is missing from pi-ai's catalog: fix the id or add it to UNCHECKED`).toBeDefined();
      expect({ input: model.costInput, output: model.costOutput }).toEqual({ input: pi!.cost.input, output: pi!.cost.output });
    },
  );

  it("UNCHECKED and CONTEXT_WINDOW_OVERRIDES only list catalog entries", () => {
    const ids = new Set(FALLBACK_MODELS.map((m) => m.id));
    for (const id of [...UNCHECKED, ...Object.keys(CONTEXT_WINDOW_OVERRIDES)]) expect(ids.has(id), id).toBe(true);
  });
});

// Where Dodo deliberately differs from pi-ai's context window, and why.
const CONTEXT_WINDOW_OVERRIDES: Record<string, { dodo: number; pi: number }> = {
  // OpenAI's API window is 1.05M; pi-ai lists 272k, where the 2x price tier starts.
  "openai/gpt-5.4": { dodo: 1_000_000, pi: 272_000 },
};

describe("FALLBACK_MODELS context windows", () => {
  // contextWindow drives compaction and the token budget: too small compacts
  // early (Sonnet/Opus 4.6 sat at 200k after Anthropic's 1M GA), too big
  // overflows the provider.
  it.each(FALLBACK_MODELS.filter((m) => !UNCHECKED.has(m.id)).map((m) => [m.id, m] as const))(
    "%s matches pi-ai's bundled catalog",
    (id, model) => {
      const pi = piModel(id);
      expect(pi, `${id} is missing from pi-ai's catalog: fix the id or add it to UNCHECKED`).toBeDefined();
      const override = CONTEXT_WINDOW_OVERRIDES[id];
      if (override) {
        // Re-check the override when pi-ai changes its number.
        expect({ dodo: model.contextWindow, pi: pi!.contextWindow }).toEqual(override);
      } else {
        expect(model.contextWindow).toBe(pi!.contextWindow);
      }
    },
  );
});
