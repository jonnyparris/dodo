/**
 * Unit tests for mapWorkersAiCatalogModel — the mapper that turns a Cloudflare
 * AI models search API entry into Dodo's model-picker shape. The live catalogue
 * feeds the model dropdown's Workers AI autocomplete (src/shared-index.ts).
 */
import { describe, expect, it } from "vitest";
import { mapWorkersAiCatalogModel } from "../src/shared-index";

describe("mapWorkersAiCatalogModel", () => {
  it("maps a full entry with price array and context window", () => {
    const out = mapWorkersAiCatalogModel({
      name: "@cf/openai/gpt-oss-120b",
      properties: [
        { property_id: "context_window", value: "128000" },
        {
          property_id: "price",
          value: [
            { unit: "per M input tokens", price: 0.35, currency: "USD" },
            { unit: "per M output tokens", price: 0.75, currency: "USD" },
          ],
        },
        { property_id: "function_calling", value: "true" },
      ],
    });
    expect(out).toEqual({
      id: "@cf/openai/gpt-oss-120b",
      name: "openai/gpt-oss-120b (Workers AI)",
      costInput: 0.35,
      costOutput: 0.75,
      contextWindow: 128000,
    });
  });

  it("returns nulls for cost/context when properties are absent", () => {
    const out = mapWorkersAiCatalogModel({ name: "@cf/meta/llama-3.1-8b-instruct", properties: [] });
    expect(out).toEqual({
      id: "@cf/meta/llama-3.1-8b-instruct",
      name: "meta/llama-3.1-8b-instruct (Workers AI)",
      costInput: null,
      costOutput: null,
      contextWindow: null,
    });
  });

  it("drops LoRA adapter entries (not usable as standalone chat models)", () => {
    expect(
      mapWorkersAiCatalogModel({
        name: "@cf/google/gemma-2b-it-lora",
        properties: [{ property_id: "lora", value: "true" }],
      }),
    ).toBeNull();
    // boolean true form too
    expect(
      mapWorkersAiCatalogModel({
        name: "@cf/some/thing-lora",
        properties: [{ property_id: "lora", value: true }],
      }),
    ).toBeNull();
  });

  it("rejects entries whose name is not a @cf/ id", () => {
    expect(mapWorkersAiCatalogModel({ name: "openai/gpt-4.1" })).toBeNull();
    expect(mapWorkersAiCatalogModel({ name: "" })).toBeNull();
    expect(mapWorkersAiCatalogModel({})).toBeNull();
  });

  it("handles numeric context_window and string price values", () => {
    const out = mapWorkersAiCatalogModel({
      name: "@cf/x/y",
      properties: [
        { property_id: "context_window", value: 32768 },
        {
          property_id: "price",
          value: [
            { unit: "per M input tokens", price: "1.5" },
            { unit: "per M output tokens", price: "3" },
          ],
        },
      ],
    });
    expect(out?.contextWindow).toBe(32768);
    expect(out?.costInput).toBe(1.5);
    expect(out?.costOutput).toBe(3);
  });

  it("tolerates a malformed price value without throwing", () => {
    const out = mapWorkersAiCatalogModel({
      name: "@cf/x/z",
      properties: [{ property_id: "price", value: "not-an-array" }],
    });
    expect(out?.costInput).toBeNull();
    expect(out?.costOutput).toBeNull();
  });
});
