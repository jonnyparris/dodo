import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { describe, expect, it } from "vitest";
import { FALLBACK_MODELS } from "../src/model-catalog";

type PiCatalog = Record<string, { cost: { input: number; output: number } }>;

// Dodo ids are `vendor/model`; each vendor's pi-ai catalog keys by the bare id.
const CATALOG_BY_VENDOR: Record<string, PiCatalog> = {
  anthropic: ANTHROPIC_MODELS as unknown as PiCatalog,
  openai: OPENAI_MODELS as unknown as PiCatalog,
  google: GOOGLE_MODELS as unknown as PiCatalog,
};

// Not in pi-ai's bundled catalog (it lists deepseek-flash / deepseek-v4-pro),
// so these prices are unchecked. Anything else must resolve.
const UNCHECKED = new Set(["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"]);

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

  it("UNCHECKED only lists catalog entries", () => {
    const ids = new Set(FALLBACK_MODELS.map((m) => m.id));
    for (const id of UNCHECKED) expect(ids.has(id), id).toBe(true);
  });
});
