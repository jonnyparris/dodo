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
});
