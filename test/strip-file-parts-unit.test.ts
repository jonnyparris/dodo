import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { stripUnsupportedFileParts } from "../src/coding-agent";

// Regression guard for the "wedged session" bug: a PDF persisted as a `file`
// part in Think's message store gets replayed every turn and rejected by the
// OpenAI-compat gateways (HTTP 501 / 400 "Bad Request"), permanently bricking
// the session. stripUnsupportedFileParts drops non-image file parts from
// history so the poisoned message can't fail the request.

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
});
