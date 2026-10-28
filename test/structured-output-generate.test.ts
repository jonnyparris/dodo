/**
 * generateStructured runs on `generateText({ output: Output.object })`
 * (AI SDK 7 deprecates `generateObject`). These tests pin the contract
 * callers rely on: JSON response format with the schema, the typed
 * result, the one-shot self-correcting retry, raw text on failure, and
 * token accounting across failed attempts.
 */
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { generateStructured } from "../src/structured-output";

const reply = (text: string, input = 10, output = 5) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  },
  warnings: [],
});

const schema = z.object({ answer: z.string() });

describe("generateStructured", () => {
  it("asks for JSON with the schema and returns the typed object", async () => {
    const model = new MockLanguageModelV4({ doGenerate: reply('{"answer":"42"}') });
    const out = await generateStructured({ modelId: "openai/gpt-5.4", model, schema, prompt: "q", system: "s" });
    expect(out).toEqual({ ok: true, data: { answer: "42" }, mode: "native", attempts: 1, tokenInput: 10, tokenOutput: 5 });
    expect(model.doGenerateCalls).toHaveLength(1);
    const call = model.doGenerateCalls[0];
    expect(call.responseFormat).toMatchObject({ type: "json", schema: { type: "object", properties: { answer: { type: "string" } } } });
    expect(call.tools).toBeUndefined();
    expect(call.prompt[0]).toEqual({ role: "system", content: "s" });
  });

  it("retries once with the validation error and counts both attempts' tokens", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [reply('{"answer":1}', 7, 3), reply('{"answer":"ok"}', 11, 4)] });
    const out = await generateStructured({ modelId: "@cf/zai-org/glm-4.7-flash", model, schema, prompt: "q" });
    expect(out).toEqual({ ok: true, data: { answer: "ok" }, mode: "tool", attempts: 2, tokenInput: 18, tokenOutput: 7 });
    const retryPrompt = JSON.stringify(model.doGenerateCalls[1].prompt);
    expect(retryPrompt).toContain("Previous attempt failed to produce a valid response");
    expect(retryPrompt).toContain("did not match schema");
  });

  it("returns the model's raw text when every attempt fails", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [reply("not json", 2, 1), reply("still not json", 2, 1)] });
    const out = await generateStructured({ modelId: "openai/gpt-5.4", model, schema, prompt: "q" });
    expect(out).toMatchObject({ ok: false, rawText: "still not json", attempts: 2, tokenInput: 4, tokenOutput: 2 });
    expect(out.ok === false && out.lastError).toContain("could not parse");
  });

  it("fails cleanly when the model returns no text", async () => {
    const empty = { ...reply(""), content: [], finishReason: { unified: "length" as const, raw: "length" } };
    const model = new MockLanguageModelV4({ doGenerate: empty });
    const out = await generateStructured({ modelId: "openai/gpt-5.4", model, schema, prompt: "q", maxRetries: 0 });
    expect(out).toMatchObject({ ok: false, attempts: 1, rawText: "" });
  });
});
