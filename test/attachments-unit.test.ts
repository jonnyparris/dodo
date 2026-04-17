import { describe, expect, it } from "vitest";
import {
  attachmentUrlToHttpPath,
  attachmentUrlToKey,
  attachmentUrlToSessionId,
  isAttachmentUrl,
  rewriteAttachmentsForClient,
} from "../src/attachments";

describe("attachments — URL helpers", () => {
  const valid = "dodo-attachment://sess-abc/msg-123/file-xyz.png";

  it("recognises dodo-attachment URLs", () => {
    expect(isAttachmentUrl(valid)).toBe(true);
    expect(isAttachmentUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isAttachmentUrl("https://example.com/a.png")).toBe(false);
    expect(isAttachmentUrl("")).toBe(false);
  });

  it("maps a valid URL to an R2 key", () => {
    expect(attachmentUrlToKey(valid)).toBe("attachments/sess-abc/msg-123/file-xyz.png");
  });

  it("returns null for malformed URLs", () => {
    expect(attachmentUrlToKey("dodo-attachment://")).toBeNull();
    expect(attachmentUrlToKey("dodo-attachment://only-one")).toBeNull();
    expect(attachmentUrlToKey("dodo-attachment://a/b")).toBeNull();
    expect(attachmentUrlToKey("dodo-attachment://a/b/c/d")).toBeNull();
    expect(attachmentUrlToKey("not-a-dodo-url")).toBeNull();
  });

  it("rejects path traversal attempts", () => {
    // Any segment containing `..` should be refused — the R2 key prefix is
    // controlled but we rely on the sessionId to scope access; escaping that
    // prefix would cross sessions.
    expect(attachmentUrlToKey("dodo-attachment://../etc/passwd.png")).toBeNull();
    expect(attachmentUrlToKey("dodo-attachment://sess/../msg/f.png")).toBeNull();
    expect(attachmentUrlToKey("dodo-attachment://sess/msg/../f.png")).toBeNull();
  });

  it("extracts the session id for cross-session ACL checks", () => {
    expect(attachmentUrlToSessionId(valid)).toBe("sess-abc");
    expect(attachmentUrlToSessionId("data:image/png;base64,AAA")).toBeNull();
  });

  it("builds HTTP path for client consumption", () => {
    expect(attachmentUrlToHttpPath(valid)).toBe(
      "/session/sess-abc/attachment/msg-123/file-xyz.png",
    );
  });

  it("returns null HTTP path for non-attachment URLs", () => {
    expect(attachmentUrlToHttpPath("data:image/png;base64,AAA")).toBeNull();
    expect(attachmentUrlToHttpPath("https://cdn.example/img.png")).toBeNull();
  });
});

describe("attachments — rewriteAttachmentsForClient", () => {
  it("rewrites dodo-attachment URLs to HTTP paths", () => {
    const input = [
      { mediaType: "image/png", url: "dodo-attachment://s/m/a.png" },
      { mediaType: "image/jpeg", url: "dodo-attachment://s/m/b.jpg" },
    ];
    const out = rewriteAttachmentsForClient(input);
    expect(out).toEqual([
      { mediaType: "image/png", url: "/session/s/attachment/m/a.png" },
      { mediaType: "image/jpeg", url: "/session/s/attachment/m/b.jpg" },
    ]);
  });

  it("leaves data URLs and external URLs untouched", () => {
    const input = [
      { mediaType: "image/png", url: "data:image/png;base64,AAAA" },
      { mediaType: "image/png", url: "https://cdn.example/img.png" },
    ];
    const out = rewriteAttachmentsForClient(input);
    expect(out).toEqual(input);
  });

  it("returns undefined for undefined input", () => {
    expect(rewriteAttachmentsForClient(undefined)).toBeUndefined();
  });

  it("preserves extra fields on attachment objects", () => {
    const input = [
      { mediaType: "image/png", url: "dodo-attachment://s/m/a.png", size: 1234 },
    ];
    const out = rewriteAttachmentsForClient(input);
    expect(out).toEqual([
      { mediaType: "image/png", url: "/session/s/attachment/m/a.png", size: 1234 },
    ]);
  });
});
