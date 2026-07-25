import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { stripUnsupportedFileParts } from "../src/coding-agent";

// Regression guard for the "wedged session" bug: a PDF persisted as a `file`
// part in Think's message store gets replayed every turn and rejected by the
// OpenAI-compat gateways (HTTP 501 / 400 "Bad Request"), permanently bricking
// the session. stripUnsupportedFileParts drops non-image file parts from
// history so the poisoned message can't fail the request.
//
// When a modelId is passed and the model doesn't support vision, image file
// parts are also stripped — the model would otherwise receive image data it
// can't process.

const pdfPart = {
  type: "file" as const,
  mediaType: "application/pdf",
  data: "JVBERi0xLjQK",
  filename: "citacao.pdf",
};
const imagePart = {
  type: "file" as const,
  mediaType: "image/png",
  data: "iVBORw0KGgo=",
};
const textPart = { type: "text" as const, text: "explain this" };

describe("stripUnsupportedFileParts", () => {
  it("strips a PDF file part but keeps surrounding text", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [textPart, pdfPart] },
    ];
    const { messages: out, stripped } = stripUnsupportedFileParts(messages);
    expect(stripped).toBe(1);
    expect(Array.isArray(out[0].content)).toBe(true);
    const parts = out[0].content as Array<{ type: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("text");
  });

  it("preserves image file parts for vision models", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [textPart, imagePart] },
    ];
    const { messages: out, stripped } = stripUnsupportedFileParts(messages);
    expect(stripped).toBe(0);
    expect((out[0].content as unknown[]).length).toBe(2);
  });

  it("preserves image file parts when modelId is a vision model", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [textPart, imagePart] },
    ];
    const { messages: out, stripped } = stripUnsupportedFileParts(messages, "anthropic/claude-sonnet-4");
    expect(stripped).toBe(0);
    expect((out[0].content as unknown[]).length).toBe(2);
  });

  it("strips image file parts when modelId is a non-vision model", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [textPart, imagePart] },
    ];
    const { messages: out, stripped } = stripUnsupportedFileParts(messages, "@cf/zai-org/glm-5.2");
    expect(stripped).toBe(1);
    const parts = out[0].content as Array<{ type: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("text");
  });

  it("strips image file parts for deepseek models", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [textPart, imagePart] },
    ];
    const { stripped } = stripUnsupportedFileParts(messages, "deepseek/deepseek-chat");
    expect(stripped).toBe(1);
  });

  it("preserves image file parts for llama-4 models", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [textPart, imagePart] },
    ];
    const { stripped } = stripUnsupportedFileParts(messages, "@cf/meta/llama-4-scout-17b-16e-instruct");
    expect(stripped).toBe(0);
  });

  it("strips both image and PDF parts for non-vision models", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [textPart, imagePart, pdfPart] },
    ];
    const { stripped } = stripUnsupportedFileParts(messages, "@cf/qwen/qwen2.5-coder-32b-instruct");
    expect(stripped).toBe(2);
  });

  it("inserts a placeholder when every part was a stripped file part", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [pdfPart] },
    ];
    const { messages: out, stripped } = stripUnsupportedFileParts(messages);
    expect(stripped).toBe(1);
    const parts = out[0].content as Array<{ type: string; text?: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("text");
    expect(parts[0].text).toContain("removed from context");
  });

  it("inserts a placeholder when image-only message is stripped for non-vision model", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [imagePart] },
    ];
    const { messages: out, stripped } = stripUnsupportedFileParts(messages, "@cf/zai-org/glm-5.2");
    expect(stripped).toBe(1);
    const parts = out[0].content as Array<{ type: string; text?: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("text");
    expect(parts[0].text).toContain("removed from context");
  });

  it("recognises the legacy `mimeType` field as well as `mediaType`", () => {
    // Deliberately malformed: older persisted messages used `mimeType` instead
    // of the current `mediaType`. Cast past the strict FilePart type to model
    // that legacy shape.
    const legacy = { type: "file", mimeType: "application/pdf", data: "JVBERi0xLjQK" };
    const messages: ModelMessage[] = [
      { role: "user", content: [textPart, legacy] } as unknown as ModelMessage,
    ];
    const { stripped } = stripUnsupportedFileParts(messages);
    expect(stripped).toBe(1);
  });

  it("leaves string-content messages untouched", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hello" },
    ];
    const { messages: out, stripped } = stripUnsupportedFileParts(messages);
    expect(stripped).toBe(0);
    expect(out).toEqual(messages);
  });

  it("returns messages unchanged when there are no file parts", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [textPart] },
    ];
    const { messages: out, stripped } = stripUnsupportedFileParts(messages);
    expect(stripped).toBe(0);
    expect(out[0]).toBe(messages[0]); // same reference — no needless copy
  });

  it("strips across multiple messages and counts them all", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [textPart, pdfPart] },
      { role: "assistant", content: "ok" },
      { role: "user", content: [pdfPart, imagePart] },
    ];
    const { stripped } = stripUnsupportedFileParts(messages);
    expect(stripped).toBe(2);
  });

  it("strips images across multiple messages for non-vision model", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [textPart, imagePart] },
      { role: "assistant", content: "ok" },
      { role: "user", content: [imagePart] },
    ];
    const { stripped } = stripUnsupportedFileParts(messages, "@cf/zai-org/glm-5.2");
    expect(stripped).toBe(2);
  });
});
