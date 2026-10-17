import { describe, expect, it } from "vitest";
import { modelSupportsVision } from "../src/model-catalog";

describe("modelSupportsVision", () => {
  // Non-vision models route image + text to Replicate editing, so a missing
  // flag turns "what is in this picture?" into an image edit.
  it.each([
    "@cf/zai-org/glm-5.3-flash", // the default Workers AI model
    "@cf/moonshotai/kimi-k2.6",
    "@cf/google/gemma-4-26b-a4b-it",
    "@cf/meta/llama-4-scout-17b-16e-instruct",
    "anthropic/claude-sonnet-4-6",
  ])("%s takes images", (id) => expect(modelSupportsVision(id)).toBe(true));

  it.each(["@cf/qwen/qwen2.5-coder-32b-instruct", "@cf/zai-org/glm-5.3", "deepseek/deepseek-chat"])("%s does not", (id) =>
    expect(modelSupportsVision(id)).toBe(false),
  );
});
