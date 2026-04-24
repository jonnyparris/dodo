import { describe, expect, it } from "vitest";
import { uiMessageToChatRecord } from "../src/think-adapter";
import type { UIMessage } from "ai";

describe("uiMessageToChatRecord — multimodal", () => {
  it("extracts text content from a text-only message", () => {
    const msg: UIMessage = {
      id: "msg-1",
      role: "user",
      parts: [{ type: "text", text: "Hello world" }],
    };
    const record = uiMessageToChatRecord(msg);
    expect(record.content).toBe("Hello world");
    expect(record.attachments).toBeUndefined();
  });

  it("extracts image attachments from file parts", () => {
    const msg: UIMessage = {
      id: "msg-2",
      role: "user",
      parts: [
        { type: "text", text: "What is this?" },
        { type: "file", mediaType: "image/png", url: "data:image/png;base64,abc123" } as UIMessage["parts"][number],
      ],
    };
    const record = uiMessageToChatRecord(msg);
    expect(record.content).toBe("What is this?");
    expect(record.attachments).toHaveLength(1);
    expect(record.attachments![0]).toEqual({
      mediaType: "image/png",
      url: "data:image/png;base64,abc123",
    });
  });

  it("handles multiple images", () => {
    const msg: UIMessage = {
      id: "msg-3",
      role: "user",
      parts: [
        { type: "text", text: "Compare" },
        { type: "file", mediaType: "image/png", url: "data:image/png;base64,aaa" } as UIMessage["parts"][number],
        { type: "file", mediaType: "image/jpeg", url: "data:image/jpeg;base64,bbb" } as UIMessage["parts"][number],
      ],
    };
    const record = uiMessageToChatRecord(msg);
    expect(record.content).toBe("Compare");
    expect(record.attachments).toHaveLength(2);
    expect(record.attachments![0].mediaType).toBe("image/png");
    expect(record.attachments![1].mediaType).toBe("image/jpeg");
  });

  it("ignores non-image file parts", () => {
    const msg: UIMessage = {
      id: "msg-4",
      role: "user",
      parts: [
        { type: "text", text: "Check this" },
        { type: "file", mediaType: "application/pdf", url: "data:application/pdf;base64,xyz" } as UIMessage["parts"][number],
      ],
    };
    const record = uiMessageToChatRecord(msg);
    expect(record.content).toBe("Check this");
    expect(record.attachments).toBeUndefined();
  });

  it("preserves metadata fields", () => {
    const msg: UIMessage = {
      id: "msg-5",
      role: "user",
      parts: [
        { type: "text", text: "Hi" },
        { type: "file", mediaType: "image/webp", url: "data:image/webp;base64,def" } as UIMessage["parts"][number],
      ],
    };
    const record = uiMessageToChatRecord(msg, {
      authorEmail: "user@test.com",
      model: "gemma-4",
      tokenInput: 100,
      tokenOutput: 50,
    });
    expect(record.authorEmail).toBe("user@test.com");
    expect(record.model).toBe("gemma-4");
    expect(record.tokenInput).toBe(100);
    expect(record.tokenOutput).toBe(50);
    expect(record.attachments).toHaveLength(1);
  });

  it("normalizes raw base64 to data URL for frontend rendering", () => {
    const msg: UIMessage = {
      id: "msg-raw",
      role: "user",
      parts: [
        { type: "text", text: "Check this" },
        { type: "file", mediaType: "image/png", url: "iVBORw0KGgoAAAAN" } as UIMessage["parts"][number],
      ],
    };
    const record = uiMessageToChatRecord(msg);
    expect(record.attachments).toHaveLength(1);
    expect(record.attachments![0].url).toBe("data:image/png;base64,iVBORw0KGgoAAAAN");
  });

  it("preserves existing data URLs without double-prefixing", () => {
    const msg: UIMessage = {
      id: "msg-existing-data-url",
      role: "user",
      parts: [
        { type: "text", text: "Check" },
        { type: "file", mediaType: "image/jpeg", url: "data:image/jpeg;base64,/9j/4AAQ" } as UIMessage["parts"][number],
      ],
    };
    const record = uiMessageToChatRecord(msg);
    expect(record.attachments).toHaveLength(1);
    expect(record.attachments![0].url).toBe("data:image/jpeg;base64,/9j/4AAQ");
  });

  it("drops file parts with media types outside the allowlist", () => {
    // Defensive: even if something slips past the ingest schema (migrated data,
    // direct DB edits), uiMessageToChatRecord must not surface non-image or
    // non-allowlisted types as renderable attachments.
    const msg: UIMessage = {
      id: "msg-bad-mime",
      role: "user",
      parts: [
        { type: "text", text: "Check" },
        // application/pdf is a file but not one we'll render as an image.
        { type: "file", mediaType: "application/pdf", url: "data:application/pdf;base64,JVBERi0=" } as UIMessage["parts"][number],
        // image/bmp isn't in the allowlist either.
        { type: "file", mediaType: "image/bmp", url: "data:image/bmp;base64,Qk0=" } as UIMessage["parts"][number],
      ],
    };
    const record = uiMessageToChatRecord(msg);
    expect(record.attachments).toBeUndefined();
  });

  it("keeps file parts with image/svg+xml (now in the allowlist)", () => {
    // SVG joins png/jpeg/gif/webp in the renderable allowlist. The upload
    // path sanitizes raw SVG text; this round-trip just ensures the media
    // type isn't dropped from the chat record.
    const msg: UIMessage = {
      id: "msg-svg",
      role: "user",
      parts: [
        { type: "text", text: "Here" },
        { type: "file", mediaType: "image/svg+xml", url: "data:image/svg+xml;base64,PHN2Zy8+" } as UIMessage["parts"][number],
      ],
    };
    const record = uiMessageToChatRecord(msg);
    expect(record.attachments).toEqual([
      { mediaType: "image/svg+xml", url: "data:image/svg+xml;base64,PHN2Zy8+" },
    ]);
  });

  it("drops file parts with an empty url", () => {
    const msg: UIMessage = {
      id: "msg-no-url",
      role: "user",
      parts: [
        { type: "text", text: "Check" },
        { type: "file", mediaType: "image/png", url: "" } as UIMessage["parts"][number],
      ],
    };
    const record = uiMessageToChatRecord(msg);
    expect(record.attachments).toBeUndefined();
  });

  it("rewrites dodo-attachment URLs on file parts to session-scoped HTTP paths", () => {
    const msg: UIMessage = {
      id: "msg-r2",
      role: "assistant",
      parts: [
        { type: "text", text: "Here's the image" },
        {
          type: "file",
          mediaType: "image/png",
          url: "dodo-attachment://sess-xyz/msg-r2/pic.png",
        } as UIMessage["parts"][number],
      ],
    };
    const record = uiMessageToChatRecord(msg);
    expect(record.attachments).toHaveLength(1);
    expect(record.attachments![0].url).toBe(
      "/session/sess-xyz/attachment/msg-r2/pic.png",
    );
  });

  it("extracts images from assistant tool-result content parts", () => {
    // Simulate the canonical multipart tool-output shape from the AI SDK.
    // Tool parts on a stored UIMessage have `type: "tool-<name>"` with an
    // `output` field when `state: "output-available"`.
    const msg: UIMessage = {
      id: "msg-tool",
      role: "assistant",
      parts: [
        { type: "text", text: "Here's what the page looks like:" },
        {
          type: "tool-browser_execute",
          toolCallId: "call-1",
          toolName: "browser_execute",
          state: "output-available",
          output: {
            type: "content",
            value: [
              { type: "text", text: "Navigated to example.com" },
              { type: "image-data", data: "AAAA", mediaType: "image/png" },
            ],
          },
        } as unknown as UIMessage["parts"][number],
      ],
    };
    const record = uiMessageToChatRecord(msg);
    expect(record.attachments).toHaveLength(1);
    expect(record.attachments![0].mediaType).toBe("image/png");
    expect(record.attachments![0].url).toBe("data:image/png;base64,AAAA");
  });

  it("rewrites dodo-attachment file-url parts inside tool output", () => {
    const msg: UIMessage = {
      id: "msg-tool2",
      role: "assistant",
      parts: [
        {
          type: "tool-browser_execute",
          toolCallId: "call-2",
          toolName: "browser_execute",
          state: "output-available",
          output: {
            type: "content",
            value: [
              {
                type: "file-url",
                url: "dodo-attachment://sess-t/toolcall-call-2/a.png",
                mediaType: "image/png",
              },
            ],
          },
        } as unknown as UIMessage["parts"][number],
      ],
    };
    const record = uiMessageToChatRecord(msg);
    expect(record.attachments).toHaveLength(1);
    expect(record.attachments![0].url).toBe(
      "/session/sess-t/attachment/toolcall-call-2/a.png",
    );
  });
});
