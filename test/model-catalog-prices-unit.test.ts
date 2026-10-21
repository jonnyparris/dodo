import { describe, expect, it } from "vitest";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway.models";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { FALLBACK_MODELS } from "../src/model-catalog";

type PiCost = { input: number; output: number };
type PiCatalog = Record<string, { cost: PiCost }>;

// Dodo ids are `vendor/model`. The AI Gateway catalog keys Anthropic models
// by the bare id and OpenAI models by the prefixed id; Google and DeepSeek
// come from their own provider catalogs.
function piCost(id: string): PiCost | undefined {
  const bare = id.slice(id.indexOf("/") + 1);
  const catalogs: PiCatalog[] = [CLOUDFLARE_AI_GATEWAY_MODELS, GOOGLE_MODELS, DEEPSEEK_MODELS] as unknown as PiCatalog[];
  for (const catalog of catalogs) {
    const model = catalog[id] ?? catalog[bare];
    if (model) return model.cost;
  }
  return undefined;
}

describe("FALLBACK_MODELS prices", () => {
  it.each(FALLBACK_MODELS.filter((m) => piCost(m.id)).map((m) => [m.id, m] as const))(
    "%s matches pi-ai's bundled catalog",
    (_id, model) => {
      const cost = piCost(model.id)!;
      expect({ input: model.costInput, output: model.costOutput }).toEqual({ input: cost.input, output: cost.output });
    },
  );

  it("checks the Anthropic models (the ones that drifted)", () => {
    for (const id of ["anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-6", "anthropic/claude-sonnet-4-6"]) {
      expect(piCost(id), id).toBeDefined();
    }
  });
});
