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
  model: string;
  opencodeBaseURL: string;
  aiGatewayBaseURL: string;
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
export function uiMessageToChatRecord(
  msg: UIMessage,
  meta: Partial<MessageMetadata> = {},
): ChatMessageRecord {
  // Extract text content from parts
  let content = "";
  if (msg.parts) {
    content = msg.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
  }

  return {
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
}
