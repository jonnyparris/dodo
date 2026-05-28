import { getAgentByName } from "agents";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { canonicalizeEmail, resolveAdminEmail } from "./auth";
import { chatMonitorIdName, sendChatReaction, sendChatReply } from "./chat-monitor-agent";
import type { Env } from "./types";

/**
 * Resolve the MCP caller's email. Prefers an explicit userEmail (from a
 * user-scoped dodo_* token validated upstream), falls back to ADMIN_EMAIL
 * for service-mode callers using the shared DODO_MCP_TOKEN.
 *
 * When the fallback is taken we log a warning so operators can audit
 * operations that get attributed to the admin. In production, review the
 * log stream periodically to confirm the expected service-mode callers
 * (CI etc.) are the only ones hitting this path.
 */
export function mcpUserEmail(env: Env, userEmail?: string, label = "mcp"): string {
  const canonical = canonicalizeEmail(userEmail ?? null);
  if (canonical) return canonical;
  const email = resolveAdminEmail(env);
  if (!email) throw new Error("ADMIN_EMAIL must be configured for MCP access. Set it as a secret or in wrangler.jsonc vars.");
  console.warn(`[${label}] Operation attributed to admin via service-mode fallback (no userEmail threaded).`);
  return email;
}

export function errorResult(data: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: true };
}

export function propagateMcpDepth(headers: Headers, depth: number): void {
  headers.set("x-dodo-mcp-depth", String(depth + 1));
}

function textResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/**
 * Register the `chat_reply` MCP tool on the given server. Shared by the
 * full (`/mcp`) and codemode (`/mcp/codemode`) MCP servers so chat-monitor
 * brain sessions can post replies regardless of which connection they use.
 *
 * Authorization is enforced at call time: the caller-session must carry
 * the CHAT_MONITOR_BRAIN_FLAG metadata (set by ChatMonitorAgent when it
 * spawns the brain) AND must have a registered space id. The `spaceId`
 * the model passes is ignored — we always post to the brain's
 * pre-registered space.
 */
export function registerChatReplyTool(server: McpServer, env: Env, userEmail: string): void {
  server.tool(
    "chat_reply",
    "Post a reply to a Google Chat space. Callable ONLY by a CodingAgent session flagged as a chat-monitor brain (the flag is set on session creation by ChatMonitorAgent). Posts to the brain's pre-registered space — the `spaceId` arg is ignored if it doesn't match. `threadName` is optional; supply it to reply in a specific thread. Pass text exactly `<NO_REPLY>` to acknowledge the message without posting anything to chat (use when you decided silence was correct). Always pass `messageName` (from the `[Message resource: ...]` header in the prompt) so the system can manage the loading/check reactions on the original message.",
    {
      sessionId: z.string().min(1).describe("Your own session id (the brain session calling this tool)."),
      text: z.string().min(1).max(2000).describe("Reply text. Plain text only; cards aren't supported. Use the literal string `<NO_REPLY>` to mark the turn handled without posting to chat."),
      threadName: z.string().optional().describe("Full thread resource name (`spaces/X/threads/Y`) to reply in-thread. Omit to post at top-level."),
      messageName: z.string().optional().describe("The Google Chat message resource name from the prompt header `[Message resource: ...]`. Required so the system can remove the loading reaction and add the done reaction."),
    },
    async ({ sessionId, text, threadName, messageName }) => {
      // 1. Look up the calling session and verify the brain flag.
      const agent = await getAgentByName(env.CODING_AGENT as never, sessionId);
      const flagRes = await (agent as unknown as { fetch: (req: Request) => Promise<Response> }).fetch(
        new Request("https://coding-agent/chat-monitor-flag", {
          headers: { "x-dodo-session-id": sessionId, "x-owner-email": userEmail },
        }),
      );
      if (!flagRes.ok) {
        return errorResult({ error: "could not verify caller session", status: flagRes.status });
      }
      const flag = (await flagRes.json()) as { isChatMonitorBrain?: boolean; spaceId?: string };
      if (!flag.isChatMonitorBrain) {
        return errorResult({ error: "calling session is not a chat-monitor brain — chat_reply refused" });
      }
      if (!flag.spaceId) {
        return errorResult({ error: "calling session has no registered chat_monitor_space_id" });
      }

      const isNoReply = text.trim() === "<NO_REPLY>";

      // 2. Manage reactions on the original message when messageName is provided.
      if (messageName) {
        const reactionEmoji = ":loading-loading-forever:";
        const doneEmoji = ":b-yes-check:";

        // Always remove the loading reaction (best-effort).
        await sendChatReaction(env, {
          messageName,
          emoji: reactionEmoji,
          action: "remove",
        }).catch((err) => {
          console.warn("[chat_reply] failed to remove loading reaction (non-fatal):", err instanceof Error ? err.message : String(err));
        });

        // Add the done reaction only when we actually posted a reply.
        if (!isNoReply) {
          await sendChatReaction(env, {
            messageName,
            emoji: doneEmoji,
            action: "add",
          }).catch((err) => {
            console.warn("[chat_reply] failed to add done reaction (non-fatal):", err instanceof Error ? err.message : String(err));
          });
        }

        // Notify the monitor DO to clear its pending-reaction record.
        try {
          const monitorId = chatMonitorIdName(userEmail, flag.spaceId);
          const monitorStub = env.CHAT_MONITOR.get(env.CHAT_MONITOR.idFromName(monitorId));
          await monitorStub.fetch("https://chat-monitor/clear-reaction", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ messageName }),
          });
        } catch (err) {
          console.warn("[chat_reply] failed to notify monitor of reaction clear (non-fatal):", err instanceof Error ? err.message : String(err));
        }
      }

      // Recognise the `<NO_REPLY>` tombstone: the brain wants to mark the
      // turn as handled without sending anything to chat. Counts as a
      // successful chat_reply call from the nudge-validator's POV (the
      // tool name is what it checks, not whether bytes hit GChat).
      if (isNoReply) {
        return textResult({ posted: false, reason: "no_reply_tombstone", spaceId: flag.spaceId });
      }

      // 3. Send via ARIA.
      const result = await sendChatReply(env, {
        spaceId: flag.spaceId,
        text,
        threadName,
      });
      if (!result.ok) {
        return errorResult({ error: `ARIA send failed`, status: result.status, body: result.body });
      }
      return textResult({ posted: true, spaceId: flag.spaceId, threadName: threadName ?? null });
    },
  );
}
