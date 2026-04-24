import { describe, expect, it } from "vitest";
import {
  _internals,
  attachmentUrlToHttpPath,
  attachmentUrlToKey,
  attachmentUrlToSessionId,
  isAttachmentUrl,
  isSvgMediaType,
  rewriteAttachmentsForClient,
  sanitizeSvg,
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

describe("attachments — SVG media type", () => {
  it("identifies image/svg+xml", () => {
    expect(isSvgMediaType("image/svg+xml")).toBe(true);
    expect(isSvgMediaType("image/png")).toBe(false);
    expect(isSvgMediaType("image/svg")).toBe(false); // precise — the IANA type is svg+xml
    expect(isSvgMediaType("")).toBe(false);
  });

  it("maps .svg to image/svg+xml and back", () => {
    expect(_internals.MIME_TO_EXT["image/svg+xml"]).toBe("svg");
    expect(_internals.EXT_TO_MIME.svg).toBe("image/svg+xml");
  });
});

describe("attachments — sanitizeSvg", () => {
  const minimal = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red"/></svg>';

  it("passes a minimal SVG through unchanged", () => {
    expect(sanitizeSvg(minimal)).toBe(minimal);
  });

  it("rejects input that isn't a valid SVG document", () => {
    expect(sanitizeSvg("")).toBeNull();
    expect(sanitizeSvg("<html><body>hi</body></html>")).toBeNull();
    expect(sanitizeSvg("<div><svg-like>not real</svg-like></div>")).toBeNull();
    // @ts-expect-error — we deliberately pass non-strings to harden the API
    expect(sanitizeSvg(null)).toBeNull();
  });

  it("rejects oversized payloads", () => {
    const tooBig = "<svg>" + "a".repeat(_internals.SVG_MAX_BYTES) + "</svg>";
    expect(sanitizeSvg(tooBig)).toBeNull();
  });

  it("strips <script> elements and their contents", () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="4"/></svg>`;
    const clean = sanitizeSvg(dirty)!;
    expect(clean).not.toContain("script");
    expect(clean).not.toContain("alert");
    expect(clean).toContain("<circle");
  });

  it("strips <foreignObject> subtrees (HTML injection vector)", () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></body></foreignObject></svg>`;
    const clean = sanitizeSvg(dirty)!;
    expect(clean).not.toContain("foreignObject");
    expect(clean).not.toContain("script");
  });

  it("strips inline event handler attributes", () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><circle r="4" onclick="alert(2)"/></svg>`;
    const clean = sanitizeSvg(dirty)!;
    expect(clean).not.toContain("onload");
    expect(clean).not.toContain("onclick");
    expect(clean).not.toContain("alert");
    expect(clean).toContain("<circle");
  });

  it("strips namespaced event handlers (xlink:onload)", () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg" xlink:onload="alert(1)"><circle r="4"/></svg>`;
    const clean = sanitizeSvg(dirty)!;
    expect(clean).not.toContain("onload");
    expect(clean).not.toContain("alert");
  });

  it("strips javascript: URLs from href/xlink:href/src", () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><circle r="4"/></a><image xlink:href="javascript:alert(2)"/></svg>`;
    const clean = sanitizeSvg(dirty)!;
    expect(clean).not.toContain("javascript:");
    expect(clean).not.toContain("alert");
  });

  it("leaves legitimate hrefs intact", () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.com"><circle r="4"/></a><image xlink:href="https://cdn.example/img.png"/></svg>`;
    const clean = sanitizeSvg(dirty)!;
    expect(clean).toContain('href="https://example.com"');
    expect(clean).toContain('xlink:href="https://cdn.example/img.png"');
  });

  it("handles self-closing <script /> variants", () => {
    // Some authoring tools emit self-closing script tags; browsers re-open
    // them when parsing, so they're still an injection vector.
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><script src="https://evil.example/x.js" /><circle r="4"/></svg>`;
    const clean = sanitizeSvg(dirty)!;
    expect(clean).not.toContain("script");
    expect(clean).not.toContain("evil.example");
  });

  it("is case-insensitive for tag and attribute matching", () => {
    const dirty = `<SVG xmlns="http://www.w3.org/2000/svg" OnLoad="alert(1)"><SCRIPT>alert(2)</SCRIPT><circle r="4"/></SVG>`;
    const clean = sanitizeSvg(dirty)!;
    expect(clean).not.toMatch(/on[a-z]+\s*=/i);
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toContain("alert");
  });
});
