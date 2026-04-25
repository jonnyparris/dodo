/**
 * Attachment storage and helpers.
 *
 * Images surface in chat from three sources — user uploads, browser tool
 * screenshots, and assistant-generated images from vision/imagen models.
 * All three land here: base64 payload → R2 object → short `dodo-attachment://`
 * URL that the frontend rewrites to a session-scoped GET route.
 *
 * Why R2 (not inline in SQLite):
 *   - Screenshots are 100KB–2MB each. Keeping them in message history bloats
 *     every `/session/:id/messages` query and Think's compaction will replace
 *     them with placeholder text anyway (see enforceRowSizeLimit in Think).
 *   - R2 lifecycle rules handle cleanup — attachments auto-expire after 30
 *     days (see wrangler.jsonc `lifecycle_rules`).
 *
 * Why not a signed URL:
 *   - The worker already gates `/session/:id/*` on session permission, so
 *     a route-level check (`attachment/:key`) is the natural place to ACL.
 *   - Signed URLs would leak past the 30-day window and need key rotation.
 */

import { bytesToBase64Chunked } from "./crypto";
import type { Env } from "./types";

const ATTACHMENT_URL_SCHEME = "dodo-attachment://";
const ATTACHMENT_KEY_PREFIX = "attachments/";
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB per attachment

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/**
 * Minimal SVG sanitizer — strips script-execution vectors before an SVG is
 * persisted.
 *
 * **Where this runs today:**
 *   - `uploadAttachment()` (below) — the R2 path, used by tool-generated
 *     SVGs (browser screenshots, future tools) and any future assistant
 *     image generator that emits SVG. The R2 GET route also layers CSP.
 *   - `sanitizeUserImage()` (below) — the user-upload path in
 *     `src/coding-agent.ts`. User uploads stay inline as `data:` URLs
 *     (no R2), so the sanitizer is the *only* defence at the bytes
 *     level. Browsers still refuse to execute scripts in SVGs loaded via
 *     `<img src>`, but click-to-zoom opens the `data:` URL directly —
 *     that's the vector we care about.
 *
 * Strategy:
 *   - Drop `<script>`, `<foreignObject>`, `<iframe>`, `<object>`,
 *     `<embed>`, `<link>`, `<style>`, `<animate>` subtrees wholesale.
 *   - Drop self-closing variants of the same.
 *   - Strip any attribute whose name starts with `on` (event handlers),
 *     optionally namespaced like `xlink:onload`.
 *   - Strip `javascript:` URLs from href/xlink:href/src.
 *   - Strip external refs on `<use>` and `<image>` — SVG `<use>` can
 *     dereference an external resource and some browsers historically
 *     leaked cookies or exposed CSS to injected content. Keep same-document
 *     fragment refs (`href="#foo"`).
 *   - Loop until the input stops changing — non-greedy element replacement
 *     can leave an outer `</script>` orphaned after stripping a nested
 *     `<script><script>…</script></script>`.
 *
 * We operate on the raw text because Workers has no DOM. The regexes are
 * intentionally loose — we favour false positives (stripping something
 * harmless) over false negatives (missing an injection).
 */
const SVG_MAX_BYTES = 512 * 1024; // 512KB — generous for diagrams, tight enough to bound regex cost
const SANITIZE_MAX_PASSES = 4; // Loop bound; one extra pass after no-op is the signal to stop

// Block-level elements we remove entirely (tag + content).
const SVG_BLOCKED_ELEMENT_RE =
  /<(script|foreignObject|iframe|object|embed|link|style|animate|set)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
// Self-closing or unclosed variants of the above.
const SVG_BLOCKED_SELFCLOSING_RE =
  /<(script|foreignObject|iframe|object|embed|link|style|animate|set)\b[^>]*\/?>/gi;
// Orphaned closing tags left after the non-greedy element replace eats the
// inner pair of a nested `<script><script>…</script></script>`.
const SVG_BLOCKED_ORPHAN_CLOSE_RE =
  /<\/(script|foreignObject|iframe|object|embed|link|style|animate|set)\s*>/gi;
// Event handlers (onload, onclick, onerror, …). Allow the attribute name to
// be prefixed with a namespace like `xlink:`. The leading character class
// is `[\s/]` so we also catch self-closing-style boundaries like
// `<use/onload=…>` that some parsers tolerate. (audit finding M14)
const SVG_EVENT_ATTR_RE = /[\s/](?:[a-z]+:)?on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
// javascript: URLs on href/xlink:href/src.
const SVG_JS_URL_RE =
  /\s(?:xlink:)?(?:href|src)\s*=\s*(?:"(\s*javascript:[^"]*)"|'(\s*javascript:[^']*)'|(\s*javascript:[^\s>]+))/gi;
// External href on `<use>` / `<image>` — allow same-document fragment refs
// (`href="#foo"`) but strip any absolute or protocol-relative URL.
const SVG_USE_EXTERNAL_RE =
  /<(use|image)\b([^>]*?)\s(xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

export function isSvgMediaType(mediaType: string): boolean {
  return mediaType === "image/svg+xml";
}

/**
 * Sanitize an SVG document. Returns the cleaned SVG string, or null if the
 * input cannot be sanitized safely (too large, or no `<svg>` root element).
 */
export function sanitizeSvg(svg: string): string | null {
  if (typeof svg !== "string") return null;
  if (svg.length === 0 || svg.length > SVG_MAX_BYTES) return null;
  // Require an <svg> root somewhere — rejects arbitrary HTML masquerading
  // as SVG. Case-insensitive because the parser is.
  if (!/<svg[\s>]/i.test(svg)) return null;

  let cleaned = svg;
  let prev = "";
  for (let i = 0; i < SANITIZE_MAX_PASSES && cleaned !== prev; i++) {
    prev = cleaned;
    cleaned = cleaned.replace(SVG_BLOCKED_ELEMENT_RE, "");
    cleaned = cleaned.replace(SVG_BLOCKED_SELFCLOSING_RE, "");
    cleaned = cleaned.replace(SVG_BLOCKED_ORPHAN_CLOSE_RE, "");
    cleaned = cleaned.replace(SVG_EVENT_ATTR_RE, "");
    cleaned = cleaned.replace(SVG_JS_URL_RE, "");
    // External <use>/<image> href: keep fragment-only refs, strip everything else.
    cleaned = cleaned.replace(SVG_USE_EXTERNAL_RE, (match, tag, pre, _xl, dq, sq, nq) => {
      const value = dq ?? sq ?? nq ?? "";
      if (value.startsWith("#")) return match; // fragment ref, keep
      return `<${tag}${pre}`; // drop the href attribute entirely
    });
  }

  // Final belt-and-braces: after SVG_USE_EXTERNAL_RE removal, re-run the
  // javascript:-URL pass in case the removed attribute revealed another.
  // One more pass is cheap (the loop above already converged).
  cleaned = cleaned.replace(SVG_JS_URL_RE, "");

  return cleaned;
}

/**
 * Sanitize a user-uploaded image if it's an SVG. Accepts base64 data and
 * returns base64 out. For non-SVG MIME types, the input is returned
 * unchanged (other formats are binary and can't host scripts in a way
 * that `<img>` will execute). Returns null if an SVG fails sanitization
 * (malformed, oversized, or not a valid SVG document).
 *
 * This wrapper exists so the user-upload path in coding-agent.ts can run
 * the sanitizer without having to know about base64 framing or the
 * sanitize-vs-pass-through decision.
 */
export function sanitizeUserImage(
  base64Data: string,
  mediaType: string,
): string | null {
  if (!isSvgMediaType(mediaType)) return base64Data;
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(base64Data);
  } catch {
    return null;
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) return null;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const cleaned = sanitizeSvg(text);
  if (cleaned === null) return null;
  // Re-encode the cleaned SVG to base64. Chunked encoder is safe at any
  // size — SVG_MAX_BYTES is 512 KB which the spread form would tolerate
  // but the explicit chunked path keeps the codebase consistent.
  // (audit finding H9)
  return bytesToBase64Chunked(new TextEncoder().encode(cleaned));
}

export interface AttachmentRef {
  mediaType: string;
  /** dodo-attachment://{sessionId}/{messageId}/{attachmentId}.{ext} */
  url: string;
  /** Byte size after base64 decode. */
  size: number;
}

export function isAttachmentUrl(url: string): boolean {
  return url.startsWith(ATTACHMENT_URL_SCHEME);
}

/**
 * Build the R2 key for a `dodo-attachment://` URL. Returns null if the URL
 * is not a dodo-attachment URL or is malformed.
 */
export function attachmentUrlToKey(url: string): string | null {
  if (!isAttachmentUrl(url)) return null;
  const path = url.slice(ATTACHMENT_URL_SCHEME.length);
  // Expect sessionId/messageId/attachmentId.ext
  const segments = path.split("/");
  if (segments.length !== 3) return null;
  const [sessionId, messageId, filename] = segments;
  // Basic slug check — no traversal, no empty segments.
  if (!sessionId || !messageId || !filename) return null;
  if (sessionId.includes("..") || messageId.includes("..") || filename.includes("..")) return null;
  return `${ATTACHMENT_KEY_PREFIX}${sessionId}/${messageId}/${filename}`;
}

/**
 * Extract the session ID from a dodo-attachment URL. Used by the serving
 * route to cross-check that the requester's session permission actually
 * covers the session the attachment belongs to.
 */
export function attachmentUrlToSessionId(url: string): string | null {
  if (!isAttachmentUrl(url)) return null;
  const path = url.slice(ATTACHMENT_URL_SCHEME.length);
  const segments = path.split("/");
  if (segments.length !== 3) return null;
  return segments[0] || null;
}

/** Build a public-facing HTTP path for a dodo-attachment URL. */
export function attachmentUrlToHttpPath(url: string): string | null {
  const sessionId = attachmentUrlToSessionId(url);
  const key = attachmentUrlToKey(url);
  if (!sessionId || !key) return null;
  // /session/:id/attachment/{messageId}/{filename}
  const stripped = key.slice(`${ATTACHMENT_KEY_PREFIX}${sessionId}/`.length);
  return `/session/${sessionId}/attachment/${stripped}`;
}

/**
 * Decode base64 to a Uint8Array. Throws if the input isn't valid base64.
 * Keeps the hot path small — no chunking since we cap at MAX_ATTACHMENT_BYTES.
 */
function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface UploadAttachmentInput {
  sessionId: string;
  messageId: string;
  mediaType: string;
  /** Either raw base64 or a data URL — we'll strip the prefix if present. */
  data: string;
  /** Optional: email of the user whose session this is, for audit. */
  ownerEmail?: string;
  /** Optional: what produced this attachment (user/tool/assistant). */
  source?: "user" | "tool" | "assistant";
  /** Optional: tool name if source is "tool". */
  toolName?: string;
}

/**
 * Upload an image attachment to R2 and return a dodo-attachment:// URL.
 *
 * If R2 is unavailable (local dev without the binding), returns null and
 * the caller should fall back to inlining the data URL. This keeps the
 * feature working in environments without R2 without crashing.
 */
export async function uploadAttachment(
  env: Env,
  input: UploadAttachmentInput,
): Promise<AttachmentRef | null> {
  if (!env.WORKSPACE_BUCKET) return null;
  const ext = MIME_TO_EXT[input.mediaType];
  if (!ext) return null; // Unsupported media type — refuse rather than store garbage

  // Strip data URL prefix if present
  const base64 = input.data.startsWith("data:")
    ? input.data.slice(input.data.indexOf(",") + 1)
    : input.data;

  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(base64);
  } catch {
    return null;
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) return null;

  // SVG needs in-band sanitization before storage. Refuse the upload if the
  // payload isn't a valid SVG — avoids R2 accumulating things the browser
  // will never render.
  if (isSvgMediaType(input.mediaType)) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const cleaned = sanitizeSvg(text);
    if (cleaned === null) return null;
    bytes = new TextEncoder().encode(cleaned);
  }

  const attachmentId = crypto.randomUUID();
  const filename = `${attachmentId}.${ext}`;
  const key = `${ATTACHMENT_KEY_PREFIX}${input.sessionId}/${input.messageId}/${filename}`;

  await env.WORKSPACE_BUCKET.put(key, bytes, {
    httpMetadata: { contentType: input.mediaType },
    customMetadata: {
      sessionId: input.sessionId,
      messageId: input.messageId,
      mediaType: input.mediaType,
      source: input.source ?? "unknown",
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.ownerEmail ? { ownerEmail: input.ownerEmail } : {}),
    },
  });

  return {
    mediaType: input.mediaType,
    url: `${ATTACHMENT_URL_SCHEME}${input.sessionId}/${input.messageId}/${filename}`,
    size: bytes.length,
  };
}

/**
 * Fetch an attachment from R2 by its HTTP path segment
 * ({messageId}/{filename}). Returns null if not found or media type mismatches.
 */
export async function fetchAttachment(
  env: Env,
  sessionId: string,
  messageAndFile: string,
): Promise<Response | null> {
  if (!env.WORKSPACE_BUCKET) return null;
  // Defensive: block traversal
  if (messageAndFile.includes("..") || messageAndFile.startsWith("/")) return null;
  const segments = messageAndFile.split("/");
  if (segments.length !== 2) return null;
  const [messageId, filename] = segments;
  if (!messageId || !filename) return null;

  // Only serve known extensions
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const mediaType = EXT_TO_MIME[ext];
  if (!mediaType) return null;

  const key = `${ATTACHMENT_KEY_PREFIX}${sessionId}/${messageId}/${filename}`;
  const obj = await env.WORKSPACE_BUCKET.get(key);
  if (!obj) return null;

  const headers: Record<string, string> = {
    "content-type": obj.httpMetadata?.contentType ?? mediaType,
    "cache-control": "private, max-age=3600",
    etag: obj.httpEtag,
    // Force the browser to treat the response as its declared MIME type.
    // Prevents content-sniffing an SVG as HTML when opened directly.
    "x-content-type-options": "nosniff",
  };
  if (isSvgMediaType(mediaType)) {
    // Defence in depth: even if an SVG slipped past the sanitizer, the CSP
    // stops inline scripts, external refs, and plugin/iframe embeds when
    // the file is opened directly in a tab via `window.open`. `<img>`-loaded
    // SVGs already can't execute scripts, so this hardens the worst case.
    headers["content-security-policy"] =
      "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  }
  return new Response(obj.body, { headers });
}

/**
 * Rewrite `dodo-attachment://` URLs in a list of attachments to the
 * public `/session/:id/attachment/...` HTTP path so the frontend can load
 * them directly. Non-attachment URLs (e.g. inline data URLs, external URLs)
 * pass through unchanged.
 */
export function rewriteAttachmentsForClient<T extends { url: string }>(
  attachments: T[] | undefined,
): T[] | undefined {
  if (!attachments) return attachments;
  return attachments.map((a) => {
    const httpPath = attachmentUrlToHttpPath(a.url);
    if (!httpPath) return a;
    return { ...a, url: httpPath };
  });
}

/** Exposed for tests. */
export const _internals = {
  ATTACHMENT_URL_SCHEME,
  ATTACHMENT_KEY_PREFIX,
  MAX_ATTACHMENT_BYTES,
  MIME_TO_EXT,
  EXT_TO_MIME,
  SVG_MAX_BYTES,
};
