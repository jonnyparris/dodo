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
  sanitizeUserImage,
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

  it("leaves legitimate hrefs on <a> intact", () => {
    // <a href> is a link, not a resource reference — keep absolute URLs so
    // users can embed diagrams that link out.
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.com"><circle r="4"/></a></svg>`;
    const clean = sanitizeSvg(dirty)!;
    expect(clean).toContain('href="https://example.com"');
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

  it("strips <animate> and <set> elements (SMIL injection vectors)", () => {
    // <animate attributeName="href" to="javascript:…"> is a classic bypass
    // for href-targeting sanitizers — the attribute starts benign and
    // becomes dangerous mid-animation.
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><a href="#safe"><animate attributeName="href" to="javascript:alert(1)"/><circle r="4"/></a><set attributeName="onload" to="alert(2)"/></svg>`;
    const clean = sanitizeSvg(dirty)!;
    expect(clean).not.toContain("animate");
    expect(clean).not.toContain("<set");
    expect(clean).not.toContain("javascript:");
    expect(clean).not.toContain("alert");
  });

  it("handles nested same-tag scripts without leaving orphan close tags", () => {
    // Non-greedy replace would otherwise leave `</script>` orphaned.
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><script><script>alert(1)</script></script><circle r="4"/></svg>`;
    const clean = sanitizeSvg(dirty)!;
    expect(clean).not.toContain("<script");
    expect(clean).not.toContain("</script");
    expect(clean).not.toContain("alert");
    expect(clean).toContain("<circle");
  });

  it("strips external href on <use> (SSRF / data exfil vector)", () => {
    // External <use> can fetch cross-origin SVG fragments. Browsers block
    // most misuse, but the fetch itself reveals session activity to the
    // target host.
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/x.svg#a"/><use xlink:href="//evil.example/y.svg#b"/><circle r="4"/></svg>`;
    const clean = sanitizeSvg(dirty)!;
    expect(clean).not.toContain("evil.example");
    expect(clean).toContain("<circle");
  });

  it("preserves same-document fragment refs on <use>", () => {
    // Fragment refs (`#foo`) resolve inside the SVG itself — always safe.
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><defs><g id="icon"><circle r="4"/></g></defs><use href="#icon"/></svg>`;
    const clean = sanitizeSvg(dirty)!;
    expect(clean).toContain('href="#icon"');
  });

  it("strips external href on <image> but keeps inline drawing", () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><image xlink:href="https://cdn.example/pic.png"/><circle r="4"/></svg>`;
    const clean = sanitizeSvg(dirty)!;
    expect(clean).not.toContain("cdn.example");
    expect(clean).toContain("<circle");
  });

  it("converges on pathological nested patterns within the pass bound", () => {
    // Four levels of nesting — the loop should resolve this without a
    // stack explosion or orphan tags.
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><script><script><script><script>a</script></script></script></script><circle r="4"/></svg>`;
    const clean = sanitizeSvg(dirty)!;
    expect(clean).not.toContain("script");
    expect(clean).toContain("<circle");
  });
});

describe("attachments — sanitizeUserImage", () => {
  const toB64 = (s: string): string => {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  };
  const fromB64 = (b: string): string => {
    const bin = atob(b);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  };

  it("passes non-SVG images through unchanged", () => {
    // A tiny valid PNG (1x1 transparent). Binary-to-binary — the function
    // should not inspect the bytes.
    const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    expect(sanitizeUserImage(pngB64, "image/png")).toBe(pngB64);
    expect(sanitizeUserImage(pngB64, "image/jpeg")).toBe(pngB64);
    expect(sanitizeUserImage(pngB64, "image/webp")).toBe(pngB64);
  });

  it("sanitizes an SVG and returns valid base64 out", () => {
    const raw = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="4"/></svg>`;
    const result = sanitizeUserImage(toB64(raw), "image/svg+xml");
    expect(result).not.toBeNull();
    const decoded = fromB64(result!);
    expect(decoded).not.toContain("script");
    expect(decoded).toContain("<circle");
  });

  it("returns null for malformed SVG", () => {
    expect(sanitizeUserImage(toB64("<html>not svg</html>"), "image/svg+xml")).toBeNull();
  });

  it("returns null for invalid base64", () => {
    expect(sanitizeUserImage("not$valid$base64", "image/svg+xml")).toBeNull();
  });

  it("round-trips unicode content correctly", () => {
    const raw = `<svg xmlns="http://www.w3.org/2000/svg"><text>café 日本語</text></svg>`;
    const result = sanitizeUserImage(toB64(raw), "image/svg+xml");
    expect(result).not.toBeNull();
    expect(fromB64(result!)).toContain("café 日本語");
  });
});
