import { describe, expect, it } from "vitest";
import {
  decodeBase64Doc,
  isAllowedAttachmentMediaType,
  isImageMediaType,
  isPdfMediaType,
  isTextDocMediaType,
} from "../src/coding-agent";
import { uiMessageToChatRecord } from "../src/think-adapter";

const b64 = (s: string): string => btoa(unescape(encodeURIComponent(s)));

type UIMsg = Parameters<typeof uiMessageToChatRecord>[0];

describe("doc attachments — media type classification", () => {
  it("recognises image types", () => {
    for (const t of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]) {
      expect(isImageMediaType(t)).toBe(true);
    }
    expect(isImageMediaType("application/pdf")).toBe(false);
    expect(isImageMediaType("image/tiff")).toBe(false);
  });

  it("recognises PDFs", () => {
    expect(isPdfMediaType("application/pdf")).toBe(true);
    expect(isPdfMediaType("text/plain")).toBe(false);
  });

  it("recognises text doc types", () => {
    for (const t of ["text/plain", "text/markdown", "text/csv", "text/html", "application/json"]) {
      expect(isTextDocMediaType(t)).toBe(true);
    }
    expect(isTextDocMediaType("application/pdf")).toBe(false);
    expect(isTextDocMediaType("image/png")).toBe(false);
    // Guards against overly-loose matching.
    expect(isTextDocMediaType("text/x-evil")).toBe(false);
    expect(isTextDocMediaType("application/json5")).toBe(false);
  });

  it("accepts the union of image, pdf, and text types", () => {
    expect(isAllowedAttachmentMediaType("image/png")).toBe(true);
    expect(isAllowedAttachmentMediaType("application/pdf")).toBe(true);
    expect(isAllowedAttachmentMediaType("text/markdown")).toBe(true);
    expect(isAllowedAttachmentMediaType("application/octet-stream")).toBe(false);
    expect(isAllowedAttachmentMediaType("")).toBe(false);
  });
});

describe("doc attachments — decodeBase64Doc", () => {
  it("decodes base64 to UTF-8 text", () => {
    const src = "# Notes\n\nHello, world — café 日本語";
    const out = decodeBase64Doc(b64(src));
    expect(out).not.toBeNull();
    expect(out?.text).toBe(src);
    expect(out?.truncated).toBe(false);
  });

  it("returns null for malformed base64", () => {
    // Contains characters outside the base64 alphabet.
    expect(decodeBase64Doc("!!!not base64!!!")).toBeNull();
  });

  it("truncates very large docs and flags it", () => {
    const big = "a".repeat(250_000);
    const out = decodeBase64Doc(b64(big));
    expect(out).not.toBeNull();
    expect(out?.truncated).toBe(true);
    expect(out?.text.length).toBe(200_000);
  });

  it("handles empty content", () => {
    const out = decodeBase64Doc(b64(""));
    expect(out).not.toBeNull();
    expect(out?.text).toBe("");
    expect(out?.truncated).toBe(false);
  });
});

describe("doc attachments — inlined-doc text is hidden from the UI content", () => {
  const inlined = (label: string, body: string): string =>
    `--- Attached document: ${label} (application/pdf, converted to Markdown) ---\n${body}\n--- End of ${label} ---`;

  it("keeps the user's prompt text but drops the inlined doc dump", () => {
    const msg = {
      id: "m1",
      role: "user",
      parts: [
        { type: "text", text: "summarise this" },
        { type: "text", text: `\n\n${inlined("citacao.pdf", "PAGE ONE giant OCR dump")}` },
      ],
    } as UIMsg;
    const rec = uiMessageToChatRecord(msg);
    expect(rec.content).toBe("summarise this");
    expect(rec.content).not.toContain("Attached document");
    expect(rec.content).not.toContain("OCR dump");
  });

  it("drops a leading inlined doc even with no other text", () => {
    const msg = {
      id: "m2",
      role: "user",
      parts: [{ type: "text", text: inlined("notes.md", "secret body") }],
    } as UIMsg;
    const rec = uiMessageToChatRecord(msg);
    expect(rec.content).toBe("");
    expect(rec.content).not.toContain("secret body");
  });

  it("leaves ordinary assistant/user text untouched", () => {
    const msg = {
      id: "m3",
      role: "assistant",
      parts: [{ type: "text", text: "here is a normal reply about documents" }],
    } as UIMsg;
    const rec = uiMessageToChatRecord(msg);
    expect(rec.content).toBe("here is a normal reply about documents");
  });
});
