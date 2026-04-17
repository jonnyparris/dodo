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

import type { Env } from "./types";

const ATTACHMENT_URL_SCHEME = "dodo-attachment://";
const ATTACHMENT_KEY_PREFIX = "attachments/";
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB per attachment

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

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

  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? mediaType,
      "cache-control": "private, max-age=3600",
      etag: obj.httpEtag,
    },
  });
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
};
