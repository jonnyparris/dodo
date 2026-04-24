/**
 * Think adapter — all @cloudflare/think imports route through this file.
 *
 * Provides types, re-exports, and adapters to isolate Think coupling
 * from the rest of the Dodo codebase.
 */

// ─── Re-exports from @cloudflare/think ───

export { Think } from "@cloudflare/think";
export type {
  ChatMessageOptions,
  FiberCompleteContext,
  FiberRecoveryContext,
  StreamCallback,
  StreamableResult,
} from "@cloudflare/think";

export { createWorkspaceTools } from "@cloudflare/think/tools/workspace";
export { createExecuteTool } from "@cloudflare/think/tools/execute";
export { truncateToolOutput } from "@cloudflare/think/session";

// ─── Re-exports from AI SDK (used alongside Think) ───

export type { UIMessage } from "ai";

// ─── Dodo-specific Think types ───

/** Per-session config stored via Think.configure() / Think.getConfig(). */
export interface DodoConfig {
  sessionId: string;
  ownerEmail: string;
  createdAt: string;
  browserEnabled: boolean;
  activeGateway: "opencode" | "ai-gateway";
  gitAuthorEmail: string;
  gitAuthorName: string;
  model: string;
  opencodeBaseURL: string;
  aiGatewayBaseURL: string;
  /**
   * Optional user-editable preamble prepended to the system prompt for
   * every session. Use for personal rules (writing style, tone, coding
   * conventions) or team conventions. Capped at 4 KB by the config
   * endpoint. Empty/undefined = no prefix.
   */
  systemPromptPrefix?: string;
  /** Default model for the `explore` subagent. See AppConfig for details. */
  exploreModel?: string;
  /** Default model for the `task` subagent. See AppConfig for details. */
  taskModel?: string;
  /** Explore-subagent dispatch mode (inprocess | facet). See AppConfig. */
  exploreMode?: "inprocess" | "facet";
  /** Task-subagent dispatch mode (inprocess | facet). See AppConfig. */
  taskMode?: "inprocess" | "facet";
}

/** Sidecar metadata for each Think message — Dodo-specific fields. */
export interface MessageMetadata {
  messageId: string;
  authorEmail: string | null;
  model: string | null;
  provider: string | null;
  tokenInput: number;
  tokenOutput: number;
  createdAt: number;
}

/**
 * Snapshot v2 format. Files + UIMessages with sidecar metadata.
 * V1 snapshots have no `version` field and use flat ChatMessageRecord[].
 */
export interface SnapshotV2 {
  version: 2;
  title: string | null;
  files: Array<{ path: string; content: string }>;
  messages: Array<{
    uiMessage: UIMessage;
    metadata: {
      authorEmail?: string | null;
      model?: string | null;
      provider?: string | null;
      tokenInput?: number;
      tokenOutput?: number;
    };
  }>;
}

// ─── Adapter functions ───

import type { UIMessage } from "ai";
import { attachmentUrlToHttpPath, isAttachmentUrl } from "./attachments";
import type { ChatMessageRecord } from "./types";

/**
 * Convert a flat ChatMessageRecord (Dodo v1 format) to a UIMessage.
 * Used for migration and v1 snapshot import.
 */
export function chatRecordToUIMessage(record: ChatMessageRecord): UIMessage {
  return {
    id: record.id,
    role: record.role === "tool" ? "assistant" : record.role as UIMessage["role"],
    parts: [{ type: "text", text: record.content }],
  };
}

/**
 * Convert a UIMessage back to a flat ChatMessageRecord.
 * Used for backward-compatible API responses.
 */
/**
 * Media types we'll render as image attachments. Kept in sync with
 * `imageAttachmentSchema` in `src/coding-agent.ts` so only ingest-validated
 * types are emitted into data URLs for the frontend.
 */
const SAFE_IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

/**
 * Walk a tool result's `output` value looking for image content parts. The
 * AI SDK's `ToolResultOutput` variant `{type: "content", value: [...]}` can
 * carry `{type: "image-data", data, mediaType}` or `{type: "media", data,
 * mediaType}` (deprecated). We accept either.
 *
 * browser_execute currently returns text output (see src/browser/tools.ts)
 * and images flow via the `onToolAttachments` side channel, but this helper
 * future-proofs for tools that want to use the canonical multipart path.
 */
function collectToolOutputImages(
  output: unknown,
  attachments: Array<{ mediaType: string; url: string }>,
): void {
  if (!output || typeof output !== "object") return;
  const o = output as { type?: string; value?: unknown };
  if (o.type !== "content" || !Array.isArray(o.value)) return;
  for (const part of o.value) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: string; data?: string; mediaType?: string; url?: string };
    if (!p.mediaType || !SAFE_IMAGE_MEDIA_TYPES.has(p.mediaType)) continue;
    // image-data (canonical) or media (deprecated) carry base64 in `data`
    if ((p.type === "image-data" || p.type === "media") && typeof p.data === "string") {
      attachments.push({
        mediaType: p.mediaType,
        url: `data:${p.mediaType};base64,${p.data}`,
      });
      continue;
    }
    // file-url carries a URL we can serve through directly
    if (p.type === "file-url" && typeof p.url === "string") {
      const url = toClientUrl(p.url, p.mediaType);
      if (url) attachments.push({ mediaType: p.mediaType, url });
    }
  }
}

/**
 * Rewrite a stored attachment URL to something the browser can load:
 *   - `dodo-attachment://…` → `/session/:id/attachment/…` HTTP path
 *   - `data:image/…;base64,…` → unchanged (inline fallback for dev without R2)
 *   - Raw base64 → inflated to `data:<mediaType>;base64,…` (legacy messages)
 */
function toClientUrl(rawUrl: string, mediaType: string): string | null {
  if (rawUrl.startsWith("data:")) return rawUrl;
  if (isAttachmentUrl(rawUrl)) return attachmentUrlToHttpPath(rawUrl);
  // Treat anything else as raw base64 (legacy path — pre-R2 messages stored
  // the base64 payload directly in `url` to dodge AI SDK downloadAssets).
  return `data:${mediaType};base64,${rawUrl}`;
}

export function uiMessageToChatRecord(
  msg: UIMessage,
  meta: Partial<MessageMetadata> = {},
): ChatMessageRecord {
  // Extract text content from parts
  let content = "";
  // Attachments can come from three sources on the stored UIMessage:
  //   1. User/assistant `file` parts (direct uploads, model-generated images)
  //   2. Tool-result parts that carry image data in their output (screenshots)
  // In all cases the stored `url` is either a `dodo-attachment://` pointer to
  // an R2 object or — in legacy messages or local-dev fallbacks — a data URL
  // or raw base64. `toClientUrl()` normalises all three shapes to something
  // the browser can load.
  const attachments: Array<{ mediaType: string; url: string }> = [];
  if (msg.parts) {
    content = msg.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    for (const p of msg.parts) {
      // File parts on user/assistant messages
      if (p.type === "file") {
        const mediaType = (p as { mediaType?: string }).mediaType;
        // Defensive: re-check mediaType here even though the schema gated it on
        // ingest. Protects against malformed stored messages or future callers
        // that bypass the HTTP layer.
        if (!mediaType || !SAFE_IMAGE_MEDIA_TYPES.has(mediaType)) continue;
        const rawUrl = (p as { url?: string }).url;
        if (typeof rawUrl !== "string" || rawUrl.length === 0) continue;
        const url = toClientUrl(rawUrl, mediaType);
        if (!url) continue;
        attachments.push({ mediaType, url });
        continue;
      }
      // Tool parts — Think encodes these as `type: "tool-<name>"` with an
      // `output` field when the state is "output-available". If the output
      // carries image content parts, surface them as attachments so the UI
      // can render browser screenshots alongside the assistant's narration.
      const typed = p as { type?: string; output?: unknown };
      if (typeof typed.type === "string" && typed.type.startsWith("tool-") && typed.output) {
        collectToolOutputImages(typed.output, attachments);
      }
    }
  }

  const record: ChatMessageRecord = {
    id: msg.id,
    role: msg.role as ChatMessageRecord["role"],
    content,
    createdAt: meta.createdAt
      ? new Date(meta.createdAt * 1000).toISOString()
      : new Date().toISOString(),
    model: meta.model ?? null,
    provider: meta.provider ?? null,
    authorEmail: meta.authorEmail ?? null,
    tokenInput: meta.tokenInput ?? 0,
    tokenOutput: meta.tokenOutput ?? 0,
  };
  if (attachments.length > 0) record.attachments = attachments;
  return record;
}
