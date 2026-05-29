/**
 * ChatMonitorAgent — Durable Object that polls a Google Chat space and
 * forwards allowlisted messages to a dedicated CodingAgent session.
 *
 * Architecture
 * ------------
 * The monitor is a thin trigger. It does NOT decide whether to reply,
 * it does NOT call an LLM directly, and it does NOT have its own tools.
 * Its job:
 *
 *   1. Alarm-driven poll of the GChat space via cf-portal MCP.
 *   2. Hard, code-level gates: BOT-skip (always), `commandSenders`
 *      allowlist (when non-empty), per-(owner,space) dedup.
 *   3. Forward HUMAN messages into a dedicated CodingAgent session:
 *      - Allowlisted senders' messages are sent as `user` prompts that
 *        trigger a session turn (the session may then call the
 *        `chat_reply` MCP tool to post to GChat).
 *      - Non-allowlisted senders' messages are appended as background
 *        annotations (no turn) when contextMode = 'recent'. They are
 *        never seen when contextMode = 'off'.
 *
 * The session is the brain. It has full Dodo MCP plumbing (cf-portal,
 * agent memory, browser, you-search, etc), full system-prompt + goal
 * support, real token budget, and a Dodo UI to inspect / debug.
 *
 * Storage
 * -------
 *   monitor_state(
 *     owner_email TEXT, space_id TEXT, persona TEXT,
 *     poll_interval_seconds INTEGER, command_senders_json TEXT,
 *     context_mode TEXT, brain_session_id TEXT,
 *     last_seen_iso TEXT, enabled INTEGER, last_error TEXT,
 *     last_run_iso TEXT, created_at INTEGER
 *   )                                              — single row
 *   replied_messages(message_name TEXT PRIMARY KEY,
 *                    forwarded_at INTEGER)         — dedup set
 *   forward_log(id PK, ts, message_name, sender_resource, sender_type,
 *               source_hash, kind, target_session_id)
 *                                                  — what we forwarded
 *
 * Privacy
 * -------
 * No message text persists in this DO. Source-message dedup uses the
 * Google Chat resource name. The forward log keeps a SHA-256 prefix for
 * cross-referencing but never the text itself. Text DOES live in the
 * brain session's chat history (that's the whole point) — which is
 * normal Dodo storage with normal Dodo access controls.
 */

import { DurableObject } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { z } from "zod";
import { getSharedIndexStub, getUserControlStub, resolveAdminEmail } from "./auth";
import { HttpMcpClient, type McpClientConfig } from "./mcp-client";
import type { Env } from "./types";

const MIN_POLL_INTERVAL_SECONDS = 1;
const DEFAULT_POLL_INTERVAL_SECONDS = 15;
const MAX_MESSAGES_PER_TICK = 5;
/** Emoji added to a message while the brain is processing a reply. */
const LOADING_EMOJI = ":loading-loading-forever:";
/** Emoji added to a message after the brain has replied. */
const DONE_EMOJI = ":b-yes-check:";
/** How long a brain prompt may run before runTick treats it as hung and
 *  aborts it. gemma-4 has been observed to chew on complex multi-tool
 *  queries indefinitely; this cap keeps the monitor from spinning
 *  forever on a stuck brain.
 *
 *  Sized for the legitimate worst case: DO cold start + ~7 MCP server
 *  connects + large system prompt assembly + Workers AI queue + tool-
 *  using inference. 3 min was too short — we observed apologies firing
 *  while the brain was still legitimately initialising. 10 min should
 *  be ample for a real query while still bounded enough to surface
 *  genuinely stuck prompts. */
const BRAIN_PROMPT_TIMEOUT_SECONDS = 600;
/** Re-fetch the cf-portal access token this many seconds before its
 *  stated expiry. Mirrors UserControl's own safety margin so the monitor
 *  and UC agree on when a token is "about to expire". */
const TOKEN_REFRESH_SAFETY_MARGIN_SECONDS = 60;
/** When UserControl doesn't report a token expiry (older deploy), cache
 *  the token for this long before re-fetching. Conservative: a transient
 *  502 on the token endpoint then only stalls reads for at most this
 *  window, and a stale token is caught by the auth-retry path anyway. */
const TOKEN_FALLBACK_TTL_SECONDS = 120;
/** How often the per-tick brain self-heal probe actually runs. The probe
 *  re-registers orphaned brain sessions in the UI and re-asserts the
 *  brain flag; it is not latency-critical, so we throttle it instead of
 *  paying a UC + CodingAgent DO hop on every poll. */
const SELFHEAL_MIN_INTERVAL_SECONDS = 300;
/** How long a fetched owner config is reused before re-reading from
 *  UserControl. Keeps the prompt-forward path off a UC hop on every
 *  command message. */
const OWNER_CONFIG_TTL_SECONDS = 60;
/** URLs we'll accept as the cf-portal MCP server when resolving the
 *  owner's refresh-token config. Codemode variant is excluded so the
 *  individual chat_get_messages tool is exposed. */
const CF_PORTAL_PREFERRED_URLS = ["https://portal.mcp.cfdata.org/mcp"];
const CF_PORTAL_URL_SUBSTRING = "portal.mcp.cfdata.org";
/** cf-portal's chat-listing tool name ends with this; we discover the
 *  full name at runtime via `client.listTools()`. */
export const CF_PORTAL_CHAT_TOOL_SUFFIX = "chat_get_messages";

/** Marker stored on a brain session's metadata so the chat_reply MCP
 *  tool can verify the caller is a chat-monitor brain. Without this,
 *  any session with Dodo MCP attached could call chat_reply. */
export const CHAT_MONITOR_BRAIN_FLAG = "is_chat_monitor_brain";

/** Supported context modes. */
export const CONTEXT_MODES = ["off", "recent"] as const;
export type ContextMode = (typeof CONTEXT_MODES)[number];

/** Sender resource pattern: Google Chat exposes users as `users/<digits>`. */
export const SENDER_RESOURCE_PATTERN = /^users\/\d+$/;

// ─── Schemas ───

export const createMonitorSchema = z
  .object({
    ownerEmail: z.string().email(),
    spaceId: z.string().min(1).regex(/^spaces\//, "spaceId must look like 'spaces/AAAA...'"),
    persona: z
      .string()
      .min(1)
      .max(8000)
      .describe(
        "Free-form persona / instructions for the brain session. Becomes the session's goal text — visible to the model on every turn.",
      ),
    pollIntervalSeconds: z
      .number()
      .int()
      .min(MIN_POLL_INTERVAL_SECONDS)
      .max(3600)
      .default(DEFAULT_POLL_INTERVAL_SECONDS),
    /**
     * Hard, code-level allowlist of sender resource names. Only messages
     * from these senders trigger a session turn. Others either enter as
     * background (contextMode = 'recent') or are skipped entirely. The
     * model is never consulted on whether to reply; the allowlist is
     * enforced before the prompt is sent.
     */
    commandSenders: z
      .array(z.string().regex(SENDER_RESOURCE_PATTERN))
      .max(20)
      .default([]),
    /**
     * Controls whether non-allowlisted HUMAN messages are forwarded to
     * the brain session as background annotations. `off` (default) means
     * the brain only ever sees messages from allowlisted senders.
     */
    contextMode: z.enum(CONTEXT_MODES).default("off"),
  })
  .strict();
export type CreateMonitorInput = z.infer<typeof createMonitorSchema>;

// ─── Types ───

interface MonitorRow {
  owner_email: string;
  space_id: string;
  persona: string;
  poll_interval_seconds: number;
  command_senders_json: string;
  context_mode: string;
  brain_session_id: string | null;
  last_seen_iso: string | null;
  enabled: number;
  last_error: string | null;
  last_run_iso: string | null;
  created_at: number;
  /** Unix seconds of the most recent /prompt POST to the brain. Used by
   *  the runTick watchdog to abort hung brain prompts. */
  last_brain_forward_ts: number | null;
  /** Cached resolved name of the cf-portal `chat_get_messages` tool, so
   *  we don't enumerate cf-portal's full tool surface via listTools()
   *  on every poll. Cleared (→ re-listed) if a call ever reports the
   *  tool is unknown. */
  chat_tool_name: string | null;
  /** Unix seconds of the most recent brain self-heal probe. Throttles
   *  the per-tick orphaned-session re-register so it isn't a hop on
   *  every poll. */
  last_selfheal_ts: number | null;
}

/** Owner gateway/model config forwarded as headers on the brain prompt. */
interface OwnerConfig {
  aiGatewayBaseURL?: string;
  activeGateway?: string;
  model?: string;
  opencodeBaseURL?: string;
}

interface ChatMessage {
  name: string;
  text: string;
  senderResource: string;
  senderType: "HUMAN" | "BOT" | "UNKNOWN";
  createTime: string;
  threadName?: string;
}

export interface ForwardLogEntry {
  ts: number;
  messageName: string;
  senderResource: string;
  senderType: ChatMessage["senderType"];
  sourceHash: string;
  /** "command" — forwarded as a user-turn prompt; "background" —
   *  appended as a system annotation; "skip" — not forwarded. */
  kind: "command" | "background" | "skip";
  /** Reason when kind = 'skip'. */
  skipReason: string | null;
  /** brain session id at the time of forwarding (when applicable). */
  targetSessionId: string | null;
}

// ─── Helpers (exported for tests) ───

export function chatMonitorIdName(ownerEmail: string, spaceId: string): string {
  return `${ownerEmail.toLowerCase()}:${spaceId}`;
}

/** Parse the JSON-encoded commandSenders column. Tolerant. */
export function parseCommandSenders(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

export async function sha256Prefix(text: string): Promise<string> {
  if (!text) return "";
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < 8; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export function pickCfPortalConfig(configs: McpClientConfig[]): McpClientConfig | null {
  for (const preferred of CF_PORTAL_PREFERRED_URLS) {
    const hit = configs.find((c) => c.url === preferred);
    if (hit) return hit;
  }
  return (
    configs.find(
      (c) =>
        c.auth_type === "refresh_token" &&
        typeof c.url === "string" &&
        c.url.includes(CF_PORTAL_URL_SUBSTRING) &&
        !c.url.includes("codemode"),
    ) ?? null
  );
}

export function findChatGetMessagesTool<T extends { name: string }>(tools: T[]): T | null {
  const exact = tools.find((t) => t.name.endsWith(`_${CF_PORTAL_CHAT_TOOL_SUFFIX}`));
  if (exact) return exact;
  return tools.find((t) => t.name.endsWith(CF_PORTAL_CHAT_TOOL_SUFFIX)) ?? null;
}

export function parseChatGetMessagesResult(
  content: Array<{ type: string; text?: string }>,
): ChatMessage[] {
  const text = content.map((c) => c.text ?? "").join("");
  if (!text.trim()) return [];

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return [];
  }

  const messages = extractMessagesArray(payload);
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const obj = m as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name : null;
    const createTime = typeof obj.createTime === "string" ? obj.createTime : null;
    if (!name || !createTime) continue;
    const messageText = extractMessageText(obj);
    const sender = obj.sender as { name?: unknown; type?: unknown } | undefined;
    const senderResource = typeof sender?.name === "string" ? sender.name : "";
    const rawType = typeof sender?.type === "string" ? sender.type.toUpperCase() : "";
    const senderType: ChatMessage["senderType"] =
      rawType === "HUMAN" || rawType === "BOT" ? rawType : "UNKNOWN";
    const thread = obj.thread as { name?: string } | undefined;
    out.push({
      name,
      text: messageText,
      senderResource,
      senderType,
      createTime,
      threadName: thread?.name,
    });
  }
  return out;
}

function extractMessagesArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.messages)) return obj.messages;
    if (obj.result && typeof obj.result === "object") {
      const inner = obj.result as Record<string, unknown>;
      if (Array.isArray(inner.messages)) return inner.messages;
    }
  }
  return [];
}

export function extractMessageText(message: Record<string, unknown>): string {
  const parts: string[] = [];
  const direct =
    pickString(message.text) ?? pickString(message.formattedText) ?? pickString(message.argumentText);
  if (direct) parts.push(direct);

  const cards = message.cardsV2;
  if (Array.isArray(cards)) {
    for (const wrapper of cards) {
      if (!wrapper || typeof wrapper !== "object") continue;
      const card = (wrapper as Record<string, unknown>).card;
      if (!card || typeof card !== "object") continue;
      const cardObj = card as Record<string, unknown>;
      const header = cardObj.header as Record<string, unknown> | undefined;
      const title = pickString(header?.title);
      const subtitle = pickString(header?.subtitle);
      if (title) parts.push(title);
      if (subtitle) parts.push(subtitle);
      const sections = cardObj.sections;
      if (Array.isArray(sections)) {
        for (const section of sections) {
          if (!section || typeof section !== "object") continue;
          const widgets = (section as Record<string, unknown>).widgets;
          if (!Array.isArray(widgets)) continue;
          for (const widget of widgets) {
            if (!widget || typeof widget !== "object") continue;
            const w = widget as Record<string, unknown>;
            const tp = w.textParagraph as { text?: unknown } | undefined;
            const tpText = pickString(tp?.text);
            if (tpText) parts.push(tpText);
            const dt = w.decoratedText as
              | { text?: unknown; topLabel?: unknown; bottomLabel?: unknown }
              | undefined;
            const dtTop = pickString(dt?.topLabel);
            const dtText = pickString(dt?.text);
            const dtBottom = pickString(dt?.bottomLabel);
            if (dtTop) parts.push(dtTop);
            if (dtText) parts.push(dtText);
            if (dtBottom) parts.push(dtBottom);
          }
        }
      }
    }
  }

  const dedup: string[] = [];
  for (const p of parts) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    if (dedup[dedup.length - 1] === trimmed) continue;
    dedup.push(trimmed);
  }
  return dedup.join("\n");
}

function pickString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ─── Logging ───

function isoNow(): string {
  return new Date().toISOString();
}

function log(level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>): void {
  const payload = { level, msg, ts: isoNow(), ...fields };
  const out = JSON.stringify(payload);
  if (level === "error") console.error(out);
  else if (level === "warn") console.warn(out);
  else console.info(out);
}

// ─── Brain-session goal preamble ───

/**
 * Build the system-prompt prefix the brain session sees on every turn.
 * The user-supplied persona is wrapped in a hard rules section that:
 *   - Tells the model it is a Google Chat agent in space X.
 *   - Names the allowlisted command senders so the model can identify
 *     them in user prompts (where the sender is included as a header).
 *   - Instructs the model to NEVER reply unless it calls the `chat_reply`
 *     MCP tool. Reading messages and using tools is fine; the only way
 *     to surface anything to humans in the space is `chat_reply`.
 *   - Treats `[Background]` system annotations as read-only context.
 *
 * Note: chat-monitor brain sessions are event-driven (one user-prompt
 * per forwarded message), so this is installed as a per-session
 * system-prompt prefix, NOT as a Dodo "goal" — there's no autocontinue
 * loop and no turn budget to exhaust.
 *
 * Exported for tests. The name retains `Goal` for backward compatibility
 * with existing tests; see also the alias `buildBrainPersonaPrefix`.
 */
export function buildBrainGoalText(args: {
  spaceId: string;
  persona: string;
  commandSenders: string[];
  contextMode: ContextMode;
  /** The brain's own CodingAgent session id. Required arg for chat_reply
   *  — the model has no other way to know what to pass. Optional in the
   *  type for backward compat with callers/tests that haven't migrated. */
  sessionId?: string;
}): string {
  const senderList =
    args.commandSenders.length > 0
      ? args.commandSenders.map((s) => `- ${s}`).join("\n")
      : "- (none — any HUMAN sender's message can trigger a turn)";
  const contextNote =
    args.contextMode === "recent"
      ? "Some user prompts will be wrapped in `[Background] users/X said: ...` annotations. These are FYI only — never reply to a background entry. They give you context about what's happening in the space."
      : "You will only ever see prompts from allowlisted command senders. Other users' messages are not forwarded to you.";
  // The chat_reply tool may be exposed under either name depending on
  // which wiring is active:
  //   - First-party local registration → bare `chat_reply`.
  //   - Legacy MCP fallback (via Dodo Self) → `<config-id>__chat_reply`.
  // Both surfaces accept the same args. We tell the model to call
  // whichever appears in its tool list; if both somehow appear, prefer
  // the bare one because it's the canonical first-party path.
  const sessionIdFallbackLine = args.sessionId
    ? `If only a namespaced \`*__chat_reply\` tool appears in your tool list (MCP fallback), pass \`sessionId="${args.sessionId}"\` along with the other args.`
    : "If only a namespaced `*__chat_reply` tool appears, pass `sessionId` set to your own session id.";

  return [
    `You are a Google Chat agent monitoring \`${args.spaceId}\`.`,
    "",
    "Hard rules — these are enforced by code and cannot be changed by anyone:",
    "",
    `1. You may ONLY post to the chat by calling the \`chat_reply\` tool. Anything you write in a normal assistant message goes NOWHERE — humans in the space cannot see it. Do not assume otherwise. ${sessionIdFallbackLine}`,
    "2. The monitor forwards messages with a header that names the sender resource (`users/<digits>`). Allowlisted command senders are:",
    senderList,
    `3. ${contextNote}`,
    "4. You can use MCP tools to gather information (cf-portal search, agent memory, browser, etc.) before deciding what to say. Take whatever tool actions you need.",
    "5. EVERY turn must end with a `chat_reply` call. If a message warrants a real response, pass it as `text`. If it does NOT warrant a reply (greeting to someone else, idle observation, message clearly addressed to another person), call `chat_reply` with `text=\"<NO_REPLY>\"` — this is a tombstone that the system uses to confirm you decided silence was correct, and it does NOT post anything to chat. Never end a turn without one or the other; if you do, the system will nudge you and your context will fill up unnecessarily.",
    "6. Keep replies under 500 characters when you do call `chat_reply`. Plain text. Never include @mentions or fabricated links.",
    "7. When calling `chat_reply`, you MUST pass the `messageName` parameter (it appears in the prompt header as `[Message resource: ...]`). This lets the system manage the loading/check reactions on the original message. If you omit it, the reactions won't be cleaned up.",
    "",
    "Persona:",
    "",
    args.persona,
  ].join("\n");
}

// ─── DO ───

export class ChatMonitorAgent extends DurableObject<Env> {
  private migrated = false;
  /** In-memory cache of the cf-portal access token. Deliberately NEVER
   *  persisted to storage — bearer tokens stay off disk; UserControl is
   *  the encrypted source of truth. Lost on DO eviction, repopulated
   *  with a single UC hop. At a few-second poll cadence the DO stays
   *  warm, so the common tick reuses this. */
  private tokenCache: { value: string; expiresAt: number } | null = null;
  /** In-memory cache of the picked cf-portal MCP config (id + url +
   *  auth metadata). Rarely changes; cleared on the auth-retry path and
   *  on DO eviction. */
  private cfgCache: McpClientConfig | null = null;
  /** In-memory cache of the owner's gateway/model config. */
  private ownerConfigCache: { value: OwnerConfig; fetchedAt: number } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private ensureMigrations(): void {
    if (this.migrated) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS monitor_state (
        owner_email TEXT NOT NULL,
        space_id TEXT NOT NULL,
        persona TEXT NOT NULL,
        poll_interval_seconds INTEGER NOT NULL,
        command_senders_json TEXT NOT NULL DEFAULT '[]',
        context_mode TEXT NOT NULL DEFAULT 'off',
        brain_session_id TEXT,
        last_seen_iso TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_run_iso TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (owner_email, space_id)
      )
    `);
    // Idempotent adds for upgraders.
    const addCol = (sql: string) => {
      try { this.ctx.storage.sql.exec(sql); } catch { /* already exists */ }
    };
    addCol("ALTER TABLE monitor_state ADD COLUMN command_senders_json TEXT NOT NULL DEFAULT '[]'");
    addCol("ALTER TABLE monitor_state ADD COLUMN context_mode TEXT NOT NULL DEFAULT 'off'");
    addCol("ALTER TABLE monitor_state ADD COLUMN brain_session_id TEXT");
    // Unix-second timestamp of the most recent /prompt POST to the brain.
    // The watchdog in runTick uses it to detect hung brain prompts (gemma
    // can chew on complex tool-using queries indefinitely without
    // returning) and abort them.
    addCol("ALTER TABLE monitor_state ADD COLUMN last_brain_forward_ts INTEGER");
    // Cached resolved cf-portal chat tool name — skips listTools() per tick.
    addCol("ALTER TABLE monitor_state ADD COLUMN chat_tool_name TEXT");
    // Throttle anchor for the per-tick brain self-heal probe.
    addCol("ALTER TABLE monitor_state ADD COLUMN last_selfheal_ts INTEGER");

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS replied_messages (
        message_name TEXT PRIMARY KEY,
        forwarded_at INTEGER NOT NULL
      )
    `);
    // Older versions called the column `replied_at`. Keep the table-level
    // shape consistent by tolerating either.
    addCol("ALTER TABLE replied_messages ADD COLUMN forwarded_at INTEGER NOT NULL DEFAULT 0");

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS forward_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        message_name TEXT NOT NULL,
        sender_resource TEXT NOT NULL,
        sender_type TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        kind TEXT NOT NULL,
        skip_reason TEXT,
        target_session_id TEXT
      )
    `);
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS forward_log_ts ON forward_log(ts DESC)",
    );

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_reactions (
        message_name TEXT PRIMARY KEY,
        added_at INTEGER NOT NULL
      )
    `);

    // Best-effort drop of legacy tables from the pre-refactor monitor.
    // These held LLM decisions and the context buffer; the brain session
    // is now the source of truth for both.
    addCol("DROP TABLE IF EXISTS decision_log"); // technically not ALTER — but addCol just swallows errors
    addCol("DROP TABLE IF EXISTS recent_messages");

    this.migrated = true;
  }

  private readState(): MonitorRow | null {
    this.ensureMigrations();
    const rows = Array.from(this.ctx.storage.sql.exec("SELECT * FROM monitor_state LIMIT 1"));
    if (rows.length === 0) return null;
    return rows[0] as unknown as MonitorRow;
  }

  private writeState(input: CreateMonitorInput): MonitorRow {
    this.ensureMigrations();
    const now = Math.floor(Date.now() / 1000);
    const sendersJson = JSON.stringify(input.commandSenders);
    // Seed last_seen_iso with the current time on first insert so the
    // initial tick doesn't flood the brain with backlog from the space.
    // Subsequent re-upserts (ON CONFLICT) preserve the existing cursor.
    this.ctx.storage.sql.exec(
      `INSERT INTO monitor_state
         (owner_email, space_id, persona, poll_interval_seconds, command_senders_json,
          context_mode, brain_session_id, last_seen_iso, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, ?)
       ON CONFLICT (owner_email, space_id) DO UPDATE SET
         persona = excluded.persona,
         poll_interval_seconds = excluded.poll_interval_seconds,
         command_senders_json = excluded.command_senders_json,
         context_mode = excluded.context_mode`,
      input.ownerEmail,
      input.spaceId,
      input.persona,
      input.pollIntervalSeconds,
      sendersJson,
      input.contextMode,
      isoNow(),
      now,
    );
    return this.readState()!;
  }

  private setEnabled(enabled: boolean): MonitorRow | null {
    this.ensureMigrations();
    this.ctx.storage.sql.exec("UPDATE monitor_state SET enabled = ? WHERE 1=1", enabled ? 1 : 0);
    return this.readState();
  }

  private recordError(message: string): void {
    this.ensureMigrations();
    this.ctx.storage.sql.exec(
      "UPDATE monitor_state SET last_error = ?, last_run_iso = ? WHERE 1=1",
      message,
      isoNow(),
    );
  }

  private recordTick(lastSeenIso: string | null): void {
    this.ensureMigrations();
    if (lastSeenIso !== null) {
      this.ctx.storage.sql.exec(
        "UPDATE monitor_state SET last_seen_iso = ?, last_error = NULL, last_run_iso = ? WHERE 1=1",
        lastSeenIso,
        isoNow(),
      );
    } else {
      this.ctx.storage.sql.exec(
        "UPDATE monitor_state SET last_error = NULL, last_run_iso = ? WHERE 1=1",
        isoNow(),
      );
    }
  }

  private hasForwarded(messageName: string): boolean {
    this.ensureMigrations();
    const rows = Array.from(
      this.ctx.storage.sql.exec(
        "SELECT 1 FROM replied_messages WHERE message_name = ? LIMIT 1",
        messageName,
      ),
    );
    return rows.length > 0;
  }

  private markForwarded(messageName: string): void {
    this.ensureMigrations();
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO replied_messages (message_name, forwarded_at) VALUES (?, ?)",
      messageName,
      Math.floor(Date.now() / 1000),
    );
  }

  private recordPendingReaction(messageName: string): void {
    this.ensureMigrations();
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO pending_reactions (message_name, added_at) VALUES (?, ?)",
      messageName,
      Math.floor(Date.now() / 1000),
    );
  }

  private clearPendingReaction(messageName: string): void {
    this.ensureMigrations();
    this.ctx.storage.sql.exec(
      "DELETE FROM pending_reactions WHERE message_name = ?",
      messageName,
    );
  }

  private listPendingReactions(): string[] {
    this.ensureMigrations();
    const rows = Array.from(
      this.ctx.storage.sql.exec("SELECT message_name FROM pending_reactions ORDER BY added_at DESC"),
    );
    return rows.map((r) => String((r as unknown as Record<string, unknown>).message_name ?? ""));
  }

  private async appendForwardLog(entry: Omit<ForwardLogEntry, "ts">): Promise<void> {
    this.ensureMigrations();
    this.ctx.storage.sql.exec(
      `INSERT INTO forward_log
         (ts, message_name, sender_resource, sender_type, source_hash, kind, skip_reason, target_session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      Math.floor(Date.now() / 1000),
      entry.messageName,
      entry.senderResource,
      entry.senderType,
      entry.sourceHash,
      entry.kind,
      entry.skipReason ?? null,
      entry.targetSessionId ?? null,
    );
    // Retention: keep newest 200.
    this.ctx.storage.sql.exec(
      `DELETE FROM forward_log
       WHERE id IN (
         SELECT id FROM forward_log ORDER BY id DESC LIMIT -1 OFFSET 200
       )`,
    );
  }

  private readForwardLog(limit: number): ForwardLogEntry[] {
    this.ensureMigrations();
    const capped = Math.max(1, Math.min(200, limit));
    const rows = Array.from(
      this.ctx.storage.sql.exec(
        "SELECT ts, message_name, sender_resource, sender_type, source_hash, kind, skip_reason, target_session_id FROM forward_log ORDER BY id DESC LIMIT ?",
        capped,
      ),
    );
    return rows.map((row) => {
      const r = row as unknown as Record<string, unknown>;
      return {
        ts: Number(r.ts ?? 0),
        messageName: String(r.message_name ?? ""),
        senderResource: String(r.sender_resource ?? ""),
        senderType: String(r.sender_type ?? "UNKNOWN") as ChatMessage["senderType"],
        sourceHash: String(r.source_hash ?? ""),
        kind: (String(r.kind ?? "skip") as ForwardLogEntry["kind"]),
        skipReason: r.skip_reason === null || r.skip_reason === undefined ? null : String(r.skip_reason),
        targetSessionId: r.target_session_id === null || r.target_session_id === undefined ? null : String(r.target_session_id),
      };
    });
  }

  private serializeState(row: MonitorRow) {
    return {
      ownerEmail: row.owner_email,
      spaceId: row.space_id,
      persona: row.persona,
      pollIntervalSeconds: row.poll_interval_seconds,
      commandSenders: parseCommandSenders(row.command_senders_json),
      contextMode: row.context_mode === "recent" ? "recent" : "off",
      brainSessionId: row.brain_session_id,
      lastSeenIso: row.last_seen_iso,
      enabled: row.enabled === 1,
      lastError: row.last_error,
      lastRunIso: row.last_run_iso,
      createdAt: row.created_at,
    };
  }

  // ── SharedIndex registry ──

  private async registerWithIndex(row: MonitorRow): Promise<void> {
    try {
      const stub = getSharedIndexStub(this.env);
      await stub.fetch("https://shared-index/chat-monitors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerEmail: row.owner_email,
          spaceId: row.space_id,
          enabled: row.enabled === 1,
          pollIntervalSeconds: row.poll_interval_seconds,
          createdAt: row.created_at,
        }),
      });
    } catch (err) {
      log("warn", "SharedIndex register failed (non-fatal)", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async unregisterFromIndex(ownerEmail: string, spaceId: string): Promise<void> {
    try {
      const stub = getSharedIndexStub(this.env);
      await stub.fetch(
        `https://shared-index/chat-monitors/${encodeURIComponent(ownerEmail)}/${encodeURIComponent(spaceId)}`,
        { method: "DELETE" },
      );
    } catch (err) {
      log("warn", "SharedIndex unregister failed (non-fatal)", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── HTTP surface (called by index.ts via proxy) ──

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/create") {
        const body = createMonitorSchema.parse(await request.json());
        const row = this.writeState(body);
        // Re-sync the brain session goal so the persona / allowlist /
        // contextMode change takes effect immediately, before the next tick.
        if (row.brain_session_id) {
          await this.updateBrainGoal(row).catch((err) =>
            log("warn", "brain goal update failed (non-fatal)", {
              err: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        await this.registerWithIndex(row);
        return Response.json({ state: this.serializeState(row) });
      }

      if (request.method === "POST" && url.pathname === "/start") {
        const row = this.setEnabled(true);
        if (!row) {
          return Response.json({ error: "monitor not created — POST /create first" }, { status: 400 });
        }
        await this.ctx.storage.setAlarm(Date.now() + row.poll_interval_seconds * 1000);
        await this.registerWithIndex(row);
        log("info", "monitor started", { space: row.space_id, owner: row.owner_email, intervalS: row.poll_interval_seconds });
        return Response.json({ state: this.serializeState(row) });
      }

      if (request.method === "POST" && url.pathname === "/stop") {
        const row = this.setEnabled(false);
        if (!row) return Response.json({ error: "monitor not created" }, { status: 404 });
        try {
          await this.ctx.storage.deleteAlarm();
        } catch { /* best-effort */ }
        await this.registerWithIndex(row);
        log("info", "monitor stopped", { space: row.space_id, owner: row.owner_email });
        return Response.json({ state: this.serializeState(row) });
      }

      if (request.method === "GET" && url.pathname === "/state") {
        const row = this.readState();
        if (!row) return Response.json({ error: "monitor not created" }, { status: 404 });
        return Response.json({ state: this.serializeState(row) });
      }

      if (request.method === "GET" && url.pathname === "/forwards") {
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? parseInt(limitParam, 10) || 50 : 50;
        return Response.json({ forwards: this.readForwardLog(limit) });
      }

      if (request.method === "POST" && url.pathname === "/tick") {
        const result = await this.runTick();
        return Response.json(result);
      }

      if (request.method === "POST" && url.pathname === "/clear-reaction") {
        const body = (await request.json()) as { messageName?: string };
        if (body.messageName) {
          this.clearPendingReaction(body.messageName);
        }
        return Response.json({ cleared: body.messageName ?? null });
      }

      if (request.method === "DELETE" && url.pathname === "/") {
        const existing = this.readState();
        try {
          await this.ctx.storage.deleteAlarm();
        } catch { /* best-effort */ }
        this.ctx.storage.sql.exec("DROP TABLE IF EXISTS monitor_state");
        this.ctx.storage.sql.exec("DROP TABLE IF EXISTS replied_messages");
        this.ctx.storage.sql.exec("DROP TABLE IF EXISTS forward_log");
        this.migrated = false;
        if (existing) {
          await this.unregisterFromIndex(existing.owner_email, existing.space_id);
        }
        return Response.json({ deleted: true });
      }

      return Response.json({ error: "not found" }, { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", "chat-monitor fetch failed", { path: url.pathname, error: message });
      return Response.json({ error: message }, { status: 500 });
    }
  }

  override async alarm(): Promise<void> {
    const row = this.readState();
    if (!row) {
      log("warn", "alarm fired with no state", {});
      return;
    }
    if (row.enabled !== 1) {
      log("info", "alarm fired but monitor disabled — not re-arming", {});
      return;
    }
    try {
      await this.runTick();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", "alarm tick failed", { error: message });
      this.recordError(message);
    }
    const next = this.readState();
    if (next && next.enabled === 1) {
      await this.ctx.storage.setAlarm(Date.now() + next.poll_interval_seconds * 1000);
    }
  }

  // ── Brain session lifecycle ──

  /**
   * Ensure a brain session exists for this monitor and is wired up with
   * the current persona / allowlist / contextMode. Idempotent — calling
   * multiple times on an already-wired monitor is a no-op aside from
   * refreshing the goal text.
   *
   * Returns the brain session id.
   */
  private async ensureBrainSession(row: MonitorRow): Promise<string> {
    const ownerEmail = row.owner_email;
    const ucStub = getUserControlStub(this.env, ownerEmail);

    // Self-heal path: an existing brain_session_id may not be registered
    // in UserControl. This happens when an old monitor lost its session
    // row (manual cleanup, idle-sweep race during creation, schema reset)
    // while the CodingAgent DO and brain_session_id pointer survived.
    // Symptom: the brain replies on GChat but the session is invisible in
    // the UI session list. POST /sessions is idempotent (ON CONFLICT
    // DO NOTHING), so re-registering an already-known id is a cheap no-op
    // on the happy path and the fix-up on the broken path.
    if (row.brain_session_id) {
      const existingId = row.brain_session_id;
      try {
        const checkRes = await ucStub.fetch(
          `https://user-control/sessions/${encodeURIComponent(existingId)}/check`,
          { method: "GET", headers: { "x-owner-email": ownerEmail } },
        );
        if (checkRes.status === 404) {
          log("warn", "brain session missing from UserControl — re-registering", {
            sessionId: existingId,
            owner: ownerEmail,
            space: row.space_id,
          });
          const reRegister = await ucStub.fetch("https://user-control/sessions", {
            method: "POST",
            headers: { "content-type": "application/json", "x-owner-email": ownerEmail },
            body: JSON.stringify({ id: existingId, ownerEmail, createdBy: ownerEmail }),
          });
          if (reRegister.ok) {
            // Restore the title so the listing isn't blank.
            await ucStub
              .fetch(`https://user-control/sessions/${encodeURIComponent(existingId)}`, {
                method: "PATCH",
                headers: { "content-type": "application/json", "x-owner-email": ownerEmail },
                body: JSON.stringify({ title: `[chat-monitor] ${row.space_id}` }),
              })
              .catch(() => {});
          } else {
            const text = await reRegister.text().catch(() => "");
            log("error", "brain session re-register failed", {
              sessionId: existingId,
              status: reRegister.status,
              body: text.slice(0, 200),
            });
          }
        }
      } catch (err) {
        // Best-effort — never fail the whole tick over a self-heal probe.
        log("warn", "brain session re-register probe failed (non-fatal)", {
          sessionId: existingId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Idempotently re-assert the chat-monitor-flag on the CodingAgent
      // DO. Persisted metadata can be missing for brains created before
      // this code shipped (the original create path was the only writer)
      // or if the DO was wiped. The first-party `chat_reply` tool reads
      // these metadata keys to decide whether to register itself; without
      // them the brain falls back to the namespaced MCP `chat_reply`
      // which the persona has no way to name correctly.
      try {
        const agentStub = await getAgentByName(this.env.CODING_AGENT as never, existingId);
        await (agentStub as unknown as { fetch: (req: Request) => Promise<Response> }).fetch(
          new Request("https://coding-agent/chat-monitor-flag", {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              "x-dodo-session-id": existingId,
              "x-owner-email": ownerEmail,
            },
            body: JSON.stringify({ isChatMonitorBrain: true, spaceId: row.space_id }),
          }),
        );
      } catch (err) {
        log("warn", "brain flag re-assert failed (non-fatal)", {
          sessionId: existingId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return existingId;
    }

    // Fresh-create path. The monitor's ownerEmail must already exist on
    // UserControl — that's where cf-portal MCP credentials live; the
    // monitor wouldn't be working at all otherwise.
    const sessionId = crypto.randomUUID();
    const createRes = await ucStub.fetch("https://user-control/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-owner-email": ownerEmail },
      body: JSON.stringify({ id: sessionId, ownerEmail, createdBy: ownerEmail }),
    });
    if (!createRes.ok) {
      const text = await createRes.text().catch(() => "");
      throw new Error(`failed to create brain session: ${createRes.status} ${text.slice(0, 200)}`);
    }

    // Patch a useful title.
    await ucStub
      .fetch(`https://user-control/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-owner-email": ownerEmail },
        body: JSON.stringify({ title: `[chat-monitor] ${row.space_id}` }),
      })
      .catch(() => {});

    // Flag the session as a chat-monitor brain so the chat_reply tool
    // accepts calls from it.
    const agentStub = await getAgentByName(this.env.CODING_AGENT as never, sessionId);
    await (agentStub as unknown as { fetch: (req: Request) => Promise<Response> }).fetch(
      new Request("https://coding-agent/chat-monitor-flag", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-dodo-session-id": sessionId,
          "x-owner-email": ownerEmail,
        },
        body: JSON.stringify({ isChatMonitorBrain: true, spaceId: row.space_id }),
      }),
    );

    // Enable the built-in admin-only browser tools (browser_search +
    // browser_execute) by default. The chat-monitor brain runs on the
    // admin's account so the binding-level admin check passes; the
    // per-session flag is what we flip here. The tools are only useful
    // for owners answering questions like "what does this page look
    // like?" — best-effort: if the bindings aren't configured the
    // tools-builder skips them, this PUT just sets the flag.
    await (agentStub as unknown as { fetch: (req: Request) => Promise<Response> }).fetch(
      new Request("https://coding-agent/browser", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-dodo-session-id": sessionId,
          "x-owner-email": ownerEmail,
        },
        body: JSON.stringify({ enabled: true }),
      }),
    ).catch((err) => {
      log("warn", "failed to enable browser on chat-monitor brain", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Persist the session id on the monitor row.
    this.ctx.storage.sql.exec(
      "UPDATE monitor_state SET brain_session_id = ? WHERE 1=1",
      sessionId,
    );

    // Install the persona + hard rules as a per-session system-prompt
    // prefix. Chat-monitor brains don't use the goal+autocontinue
    // mechanism — they're event-driven (one user-prompt per forwarded
    // message) so a goal would either burn turns idling or get exhausted.
    await this.setBrainPersona(sessionId, ownerEmail, row);

    log("info", "brain session created", { sessionId, owner: ownerEmail, space: row.space_id });
    return sessionId;
  }

  /** Install or refresh the brain session's system-prompt prefix. */
  private async setBrainPersona(sessionId: string, ownerEmail: string, row: MonitorRow): Promise<void> {
    const personaText = buildBrainGoalText({
      spaceId: row.space_id,
      persona: row.persona,
      commandSenders: parseCommandSenders(row.command_senders_json),
      contextMode: row.context_mode === "recent" ? "recent" : "off",
      sessionId,
    });
    const agentStub = await getAgentByName(this.env.CODING_AGENT as never, sessionId);
    const res = await (agentStub as unknown as { fetch: (req: Request) => Promise<Response> }).fetch(
      new Request("https://coding-agent/system-prompt-prefix", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-dodo-session-id": sessionId,
          "x-owner-email": ownerEmail,
        },
        body: JSON.stringify({ text: personaText }),
      }),
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`failed to set brain persona: ${res.status} ${text.slice(0, 200)}`);
    }
  }

  /** Refresh the persona for an existing brain session (after upsert).
   *  Also clears any active goal — chat-monitor brains are event-driven
   *  and should not autocontinue between forwarded messages. */
  private async updateBrainGoal(row: MonitorRow): Promise<void> {
    if (!row.brain_session_id) return;
    await this.setBrainPersona(row.brain_session_id, row.owner_email, row);
    // Best-effort: clear any goal that earlier monitor versions installed,
    // so the autocontinue loop stops.
    try {
      const agentStub = await getAgentByName(this.env.CODING_AGENT as never, row.brain_session_id);
      await (agentStub as unknown as { fetch: (req: Request) => Promise<Response> }).fetch(
        new Request("https://coding-agent/goal", {
          method: "DELETE",
          headers: {
            "x-dodo-session-id": row.brain_session_id,
            "x-owner-email": row.owner_email,
          },
        }),
      );
    } catch (err) {
      log("warn", "brain goal clear failed (non-fatal)", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Watchdog: abort a hung brain prompt and apologise in chat.
   *
   * Called from runTick when the brain has been working on a single
   * prompt for longer than BRAIN_PROMPT_TIMEOUT_SECONDS. Posts an
   * apology to the GChat space (best-effort) then signals the brain's
   * AbortController via POST /abort so the next message can be picked
   * up. Clears last_brain_forward_ts so subsequent ticks don't fire
   * the watchdog again until the next /prompt POST resets the clock.
   */
  private async watchdogAbortBrain(row: MonitorRow, ageSec: number): Promise<void> {
    log("warn", "brain prompt watchdog firing — aborting", {
      sessionId: row.brain_session_id,
      ageSec,
      space: row.space_id,
    });
    // 1. Best-effort: post apology to chat. We bypass chat_reply (which
    //    requires the brain's identity) and call sendChatReply directly
    //    with the monitor's pre-registered space.
    await sendChatReply(this.env, {
      spaceId: row.space_id,
      text:
        "Sorry — that query took too long (over " +
        `${Math.floor(ageSec / 60)} min) and I had to give up. ` +
        "Try rephrasing or breaking it into smaller pieces.",
    }).catch((err) => {
      log("warn", "watchdog apology to chat failed (non-fatal)", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    // 2. Signal the brain's AbortController.
    if (row.brain_session_id) {
      try {
        const agentStub = await getAgentByName(this.env.CODING_AGENT as never, row.brain_session_id);
        await (agentStub as unknown as { fetch: (req: Request) => Promise<Response> }).fetch(
          new Request("https://coding-agent/abort", {
            method: "POST",
            headers: {
              "x-dodo-session-id": row.brain_session_id,
              "x-owner-email": row.owner_email,
            },
          }),
        );
      } catch (err) {
        log("warn", "watchdog abort POST failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // 3. Clear the deadline so the watchdog won't refire on the next
    //    tick — only a fresh forward will set a new deadline.
    this.ctx.storage.sql.exec(
      "UPDATE monitor_state SET last_brain_forward_ts = NULL WHERE 1=1",
    );
  }

  /**
   * Forward a single chat message to the brain session.
   *
   * - When `asCommand` is true, the message is sent as a `user`-role
   *   prompt that triggers a session turn (the model may then call
   *   `chat_reply`).
   * - When `asCommand` is false, the message is sent as a `[Background]`
   *   annotation: the session sees it in its history but no turn is
   *   triggered (we use a metadata-only POST that adds the message to
   *   the session log without invoking the model).
   */
  private async forwardToBrain(
    sessionId: string,
    ownerEmail: string,
    spaceId: string,
    msg: ChatMessage,
    asCommand: boolean,
    sideEffects?: Promise<unknown>[],
  ): Promise<void> {
    // Best-effort: add a loading reaction so the human knows the message
    // was received and is being processed. We kick this off WITHOUT
    // awaiting it here — an ARIA round-trip in front of the prompt POST
    // just delays the brain starting. The promise is handed to the
    // caller's `sideEffects` array and drained at the end of the tick;
    // if no array is supplied (legacy callers/tests) we fall back to
    // awaiting inline.
    if (asCommand) {
      this.recordPendingReaction(msg.name);
      const reactionPromise = sendChatReaction(this.env, {
        messageName: msg.name,
        emoji: LOADING_EMOJI,
        action: "add",
      }).catch((err) => {
        log("warn", "failed to add loading reaction (non-fatal)", {
          messageName: msg.name,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      if (sideEffects) sideEffects.push(reactionPromise);
      else await reactionPromise;
    }

    const agentStub = await getAgentByName(this.env.CODING_AGENT as never, sessionId);
    const fetcher = (agentStub as unknown as { fetch: (req: Request) => Promise<Response> }).fetch.bind(agentStub);

    if (asCommand) {
      // Build a prompt block that names the sender + space metadata so
      // the model knows where this came from and who said it. The model
      // is instructed (by the goal) to call `chat_reply` to respond.
      const promptBody = [
        `[Chat space: ${spaceId}]`,
        `[Sender: ${msg.senderResource} (${msg.senderType})]`,
        `[Thread: ${msg.threadName ?? "(none)"}]`,
        `[Message resource: ${msg.name}]`,
        "",
        msg.text,
      ].join("\n");

      const ownerConfig = await this.getOwnerConfig(ownerEmail);
      const res = await fetcher(
        new Request("https://coding-agent/prompt", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-dodo-session-id": sessionId,
            "x-owner-email": ownerEmail,
            "x-author-email": ownerEmail,
            ...(ownerConfig?.aiGatewayBaseURL ? { "x-dodo-ai-base-url": ownerConfig.aiGatewayBaseURL } : {}),
            ...(ownerConfig?.activeGateway ? { "x-dodo-gateway": ownerConfig.activeGateway } : {}),
            ...(ownerConfig?.model ? { "x-dodo-model": ownerConfig.model } : {}),
            ...(ownerConfig?.opencodeBaseURL ? { "x-dodo-opencode-base-url": ownerConfig.opencodeBaseURL } : {}),
          },
          body: JSON.stringify({ content: promptBody }),
        }),
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`brain prompt rejected: ${res.status} ${text.slice(0, 200)}`);
      }
      // Record the forward time so the watchdog in runTick can detect
      // hung brain prompts. We use the *latest* forward as the deadline
      // anchor — multiple queued forwards reset the clock so a slow
      // legitimate prompt followed by a fresh trivial one doesn't get
      // killed prematurely.
      this.ctx.storage.sql.exec(
        "UPDATE monitor_state SET last_brain_forward_ts = ? WHERE 1=1",
        Math.floor(Date.now() / 1000),
      );
      return;
    }

    // Background mode — append a user-role annotation without triggering
    // a turn. CodingAgent doesn't have a "passive append" endpoint today,
    // so this is best-effort: we just skip background forwarding for the
    // moment and log it. (Implementing a non-triggering append would
    // require a small new endpoint; tracked as follow-up.)
    log("info", "background forward skipped (no passive-append endpoint yet)", {
      sessionId,
      messageName: msg.name,
    });
  }

  /** Cached read of the owner's app config. The underlying values change
   *  rarely (gateway / model picks), so reusing them for
   *  OWNER_CONFIG_TTL_SECONDS keeps a UC DO hop off the prompt-forward
   *  critical path on back-to-back commands. */
  private async getOwnerConfig(ownerEmail: string): Promise<OwnerConfig | null> {
    const nowSec = Math.floor(Date.now() / 1000);
    if (this.ownerConfigCache && nowSec - this.ownerConfigCache.fetchedAt < OWNER_CONFIG_TTL_SECONDS) {
      return this.ownerConfigCache.value;
    }
    const cfg = await this.readOwnerConfig(ownerEmail);
    if (cfg) this.ownerConfigCache = { value: cfg, fetchedAt: nowSec };
    return cfg;
  }

  /** Read the owner's app config so we can forward the right model /
   *  gateway headers with the prompt POST. Best-effort. */
  private async readOwnerConfig(ownerEmail: string): Promise<OwnerConfig | null> {
    try {
      const stub = getUserControlStub(this.env, ownerEmail);
      const res = await stub.fetch("https://user-control/config", {
        headers: { "x-owner-email": ownerEmail },
      });
      if (!res.ok) return null;
      const cfg = (await res.json()) as Record<string, unknown>;
      return {
        aiGatewayBaseURL: typeof cfg.aiGatewayBaseURL === "string" ? cfg.aiGatewayBaseURL : undefined,
        activeGateway: typeof cfg.activeGateway === "string" ? cfg.activeGateway : undefined,
        model: typeof cfg.model === "string" ? cfg.model : undefined,
        opencodeBaseURL: typeof cfg.opencodeBaseURL === "string" ? cfg.opencodeBaseURL : undefined,
      };
    } catch {
      return null;
    }
  }

  // ── Core loop ──

  private async runTick(): Promise<{
    fetched: number;
    forwarded: number;
    skipped: number;
    errors: string[];
    brainSessionId: string | null;
    forwards: Array<{
      messageName: string;
      senderResource: string;
      senderType: ChatMessage["senderType"];
      sourceHash: string;
      kind: ForwardLogEntry["kind"];
      skipReason?: string;
    }>;
  }> {
    const row = this.readState();
    if (!row) throw new Error("runTick: no state");

    const errors: string[] = [];

    const messages = await this.fetchMessages(row.owner_email, row.space_id, row.last_seen_iso);

    // Filter to never-seen-before + after last_seen_iso.
    const candidates: ChatMessage[] = [];
    for (const m of messages) {
      if (this.hasForwarded(m.name)) continue;
      if (row.last_seen_iso && m.createTime <= row.last_seen_iso) continue;
      candidates.push(m);
    }
    candidates.sort((a, b) => a.createTime.localeCompare(b.createTime));
    const limited = candidates.slice(0, MAX_MESSAGES_PER_TICK);

    // Watchdog: if the brain has been working on a prompt for longer than
    // BRAIN_PROMPT_TIMEOUT_SECONDS, abort it before piling on more work.
    // Only abort when there are actual new messages waiting — if the queue
    // is empty, clear the deadline so a nudge (or idle brain) doesn't get
    // killed falsely.
    if (row.brain_session_id && row.last_brain_forward_ts) {
      const ageSec = Math.floor(Date.now() / 1000) - row.last_brain_forward_ts;
      if (ageSec > BRAIN_PROMPT_TIMEOUT_SECONDS) {
        if (limited.length > 0) {
          await this.watchdogAbortBrain(row, ageSec).catch((err) => {
            errors.push(`watchdog abort failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        } else {
          this.ctx.storage.sql.exec(
            "UPDATE monitor_state SET last_brain_forward_ts = NULL WHERE 1=1",
          );
        }
      }
    }

    // Self-heal probe — if an existing brain session is missing from the
    // UserControl session index (orphaned by a past schema reset or a
    // creation-time race), this re-registers it so it shows up in the UI.
    // It costs a /check GET against the UC DO plus a flag PUT against the
    // CodingAgent DO. That's pure overhead on a silent space, so throttle
    // it to SELFHEAL_MIN_INTERVAL_SECONDS rather than paying it on every
    // poll. Orphaned-session recovery is a slow-path safety net, not a
    // latency-critical operation; the fresh-create path below still spins
    // up a brain immediately on the first forwarded message.
    if (row.brain_session_id) {
      const nowSec = Math.floor(Date.now() / 1000);
      const lastSelfheal = row.last_selfheal_ts ?? 0;
      if (nowSec - lastSelfheal > SELFHEAL_MIN_INTERVAL_SECONDS) {
        this.ctx.storage.sql.exec(
          "UPDATE monitor_state SET last_selfheal_ts = ? WHERE 1=1",
          nowSec,
        );
        await this.ensureBrainSession(row).catch((err) => {
          log("warn", "brain session self-heal probe failed (non-fatal)", {
            sessionId: row.brain_session_id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    const commandSenders = parseCommandSenders(row.command_senders_json);
    const allowlistActive = commandSenders.length > 0;
    const contextOn = row.context_mode === "recent";

    let forwarded = 0;
    let skipped = 0;
    const out: Array<{
      messageName: string;
      senderResource: string;
      senderType: ChatMessage["senderType"];
      sourceHash: string;
      kind: ForwardLogEntry["kind"];
      skipReason?: string;
    }> = [];

    // Lazily spawn the brain session on first message we'd send to it.
    let brainSessionId: string | null = row.brain_session_id;

    // Best-effort side effects (loading reactions) kicked off during
    // forwarding. We don't await them inline — they'd otherwise sit on
    // the critical path before the brain prompt is even POSTed — but we
    // DO await them at the end of the tick so the DO doesn't return
    // before they complete (unawaited promises aren't guaranteed to run
    // to completion after an alarm handler returns).
    const sideEffects: Promise<unknown>[] = [];

    for (const msg of limited) {
      try {
        const sourceHash = await sha256Prefix(msg.text);

        // Gate a — BOT senders, always skipped.
        if (msg.senderType === "BOT") {
          await this.appendForwardLog({
            messageName: msg.name,
            senderResource: msg.senderResource,
            senderType: msg.senderType,
            sourceHash,
            kind: "skip",
            skipReason: "sender_is_bot",
            targetSessionId: null,
          });
          out.push({ messageName: msg.name, senderResource: msg.senderResource, senderType: msg.senderType, sourceHash, kind: "skip", skipReason: "sender_is_bot" });
          skipped++;
          this.markForwarded(msg.name);
          continue;
        }

        const isCommand = !allowlistActive || commandSenders.includes(msg.senderResource);
        const kind: ForwardLogEntry["kind"] = isCommand
          ? "command"
          : contextOn
            ? "background"
            : "skip";

        if (kind === "skip") {
          await this.appendForwardLog({
            messageName: msg.name,
            senderResource: msg.senderResource,
            senderType: msg.senderType,
            sourceHash,
            kind: "skip",
            skipReason: "sender_not_in_allowlist",
            targetSessionId: null,
          });
          out.push({ messageName: msg.name, senderResource: msg.senderResource, senderType: msg.senderType, sourceHash, kind: "skip", skipReason: "sender_not_in_allowlist" });
          skipped++;
          this.markForwarded(msg.name);
          continue;
        }

        // We need a brain session. The per-tick self-heal probe above
        // already covers the "exists but missing from UserControl" case,
        // so this branch only fires the very first time a forwarded
        // message arrives.
        if (!brainSessionId) {
          brainSessionId = await this.ensureBrainSession(row);
          this.ctx.storage.sql.exec(
            "UPDATE monitor_state SET brain_session_id = ? WHERE 1=1",
            brainSessionId,
          );
        }

        await this.forwardToBrain(brainSessionId, row.owner_email, row.space_id, msg, kind === "command", sideEffects);
        await this.appendForwardLog({
          messageName: msg.name,
          senderResource: msg.senderResource,
          senderType: msg.senderType,
          sourceHash,
          kind,
          skipReason: null,
          targetSessionId: brainSessionId,
        });
        out.push({ messageName: msg.name, senderResource: msg.senderResource, senderType: msg.senderType, sourceHash, kind });
        forwarded++;
        this.markForwarded(msg.name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${msg.name}: ${message}`);
      }
    }

    // Drain best-effort side effects (loading reactions) before returning
    // so they complete within the tick rather than being cut off.
    if (sideEffects.length > 0) {
      await Promise.allSettled(sideEffects);
    }

    // Advance cursor to the newest message we saw, even if we skipped it.
    const newestSeen = messages.map((m) => m.createTime).sort().pop();
    this.recordTick(newestSeen ?? row.last_seen_iso);

    return {
      fetched: messages.length,
      forwarded,
      skipped,
      errors,
      brainSessionId,
      forwards: out,
    };
  }

  // ── cf-portal MCP read path ──

  private async fetchMessages(
    ownerEmail: string,
    spaceId: string,
    afterIso: string | null,
  ): Promise<ChatMessage[]> {
    const cfg = await this.getCfPortalConfig(ownerEmail);
    try {
      return await this.fetchMessagesOnce(ownerEmail, spaceId, cfg, false);
    } catch (err) {
      // A stale cached token (401), a connect blip, or a dropped config
      // surfaces here. Drop the in-memory caches and retry exactly once
      // with a force-refreshed token + freshly-picked config before
      // surfacing the error. This is the common path when the cached
      // token expired between ticks.
      this.tokenCache = null;
      this.cfgCache = null;
      const msg = err instanceof Error ? err.message : String(err);
      log("warn", "chat fetch failed; retrying once with forced token refresh", {
        error: msg.slice(0, 200),
      });
      const freshCfg = await this.getCfPortalConfig(ownerEmail);
      return await this.fetchMessagesOnce(ownerEmail, spaceId, freshCfg, true);
    }
  }

  /** Resolve (and cache) the cf-portal MCP config for this owner. */
  private async getCfPortalConfig(ownerEmail: string): Promise<McpClientConfig> {
    if (this.cfgCache) return this.cfgCache;
    const stub = getUserControlStub(this.env, ownerEmail);
    const cfgRes = await stub.fetch("https://user-control/mcp-configs", {
      headers: { "x-owner-email": ownerEmail },
    });
    if (!cfgRes.ok) throw new Error(`cf-portal config list failed (${cfgRes.status})`);
    const { configs } = (await cfgRes.json()) as { configs: McpClientConfig[] };
    const cfg = pickCfPortalConfig(configs);
    if (!cfg) {
      throw new Error(`cf-portal MCP config not found for ${ownerEmail}. Run /dodo-dcr-oauth first.`);
    }
    if (!cfg.url) throw new Error("cf-portal config has no url");
    this.cfgCache = cfg;
    return cfg;
  }

  /** Return a cf-portal access token, reusing the in-memory cache unless
   *  forced or within the refresh safety margin of expiry. */
  private async getAccessToken(ownerEmail: string, configId: string, force: boolean): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    if (
      !force &&
      this.tokenCache &&
      this.tokenCache.expiresAt - nowSec > TOKEN_REFRESH_SAFETY_MARGIN_SECONDS
    ) {
      return this.tokenCache.value;
    }
    const stub = getUserControlStub(this.env, ownerEmail);
    const tokenRes = await stub.fetch(
      `https://user-control/mcp-configs/${encodeURIComponent(configId)}/access-token${force ? "?force=1" : ""}`,
      { headers: { "x-owner-email": ownerEmail } },
    );
    if (!tokenRes.ok) {
      throw new Error(`cf-portal access-token fetch failed (${tokenRes.status}) for config ${configId}.`);
    }
    const body = (await tokenRes.json()) as { accessToken?: string; expiresAt?: number };
    if (!body.accessToken) throw new Error("cf-portal returned no access token");
    const expiresAt =
      typeof body.expiresAt === "number" && body.expiresAt > 0
        ? body.expiresAt
        : nowSec + TOKEN_FALLBACK_TTL_SECONDS;
    this.tokenCache = { value: body.accessToken, expiresAt };
    return body.accessToken;
  }

  /** Read the cached cf-portal chat tool name, if resolved. */
  private readChatToolName(): string | null {
    this.ensureMigrations();
    const rows = Array.from(
      this.ctx.storage.sql.exec("SELECT chat_tool_name FROM monitor_state LIMIT 1"),
    );
    if (rows.length === 0) return null;
    const v = (rows[0] as unknown as Record<string, unknown>).chat_tool_name;
    return typeof v === "string" && v.length > 0 ? v : null;
  }

  private writeChatToolName(name: string | null): void {
    this.ensureMigrations();
    this.ctx.storage.sql.exec("UPDATE monitor_state SET chat_tool_name = ? WHERE 1=1", name);
  }

  /** Single read attempt against cf-portal with a given token freshness. */
  private async fetchMessagesOnce(
    ownerEmail: string,
    spaceId: string,
    cfg: McpClientConfig,
    force: boolean,
  ): Promise<ChatMessage[]> {
    const accessToken = await this.getAccessToken(ownerEmail, cfg.id, force);
    const client = new HttpMcpClient({ ...cfg, headers: { Authorization: `Bearer ${accessToken}` } }, 0);
    try {
      await client.connect();

      // Resolve the tool name from cache; only enumerate cf-portal's full
      // tool surface (listTools) when we don't have it. cf-portal proxies
      // a large tool set, so listTools is the dominant per-tick cost — at
      // a few-second cadence we'd otherwise pay it ~20×/min for a value
      // that never changes.
      let toolName = this.readChatToolName();
      if (!toolName) {
        const tools = await client.listTools();
        const chatTool = findChatGetMessagesTool(tools);
        if (!chatTool) {
          throw new Error(
            `chat_get_messages tool not found on cf-portal; available: ${tools.slice(0, 5).map((t) => t.name).join(", ")}`,
          );
        }
        toolName = chatTool.name;
        this.writeChatToolName(toolName);
      }

      // Pull newest-first and filter locally. Empirically the cf-portal
      // tool's `after` parameter doesn't reliably narrow results when
      // newestFirst=false (returns 0 even when newer messages exist).
      // Asking for the newest 25 and applying the `lastSeenIso` filter
      // in runTick is robust to that quirk and to clock-skew between
      // Google and our cursor.
      const callArgs: Record<string, unknown> = {
        spaceName: spaceId,
        maxResults: 25,
        newestFirst: true,
      };
      const result = await client.callTool(toolName, callArgs);
      if (result.isError) {
        const text = result.content.map((c) => c.text ?? "").join("\n");
        // A cached tool name that no longer resolves — drop it so the
        // retry (or next tick) re-lists and re-caches.
        if (/not\s*found|unknown tool|no such tool/i.test(text)) {
          this.writeChatToolName(null);
        }
        throw new Error(`chat_get_messages error: ${text.slice(0, 500)}`);
      }
      return parseChatGetMessagesResult(result.content);
    } finally {
      client.disconnect();
    }
  }
}

/**
 * The chat_reply MCP tool dispatch: post to GChat via the ARIA chat
 * middleware. Exported so the MCP server (src/mcp.ts) can register it
 * without re-implementing the send logic. Auth is the wrangler secret
 * `ARIA_CHAT_AUTH_KEY`; this is the *only* place outbound chat replies
 * leave Dodo.
 *
 * Caller is responsible for verifying the caller-session is flagged as
 * a chat-monitor brain (CHAT_MONITOR_BRAIN_FLAG).
 */
export async function sendChatReply(
  env: Env,
  args: { spaceId: string; text: string; threadName?: string },
): Promise<{ ok: boolean; status: number; body: string }> {
  const key = env.ARIA_CHAT_AUTH_KEY;
  if (!key) {
    return { ok: false, status: 500, body: "ARIA_CHAT_AUTH_KEY not set on the Worker" };
  }
  const body: Record<string, unknown> = {
    spaceId: args.spaceId,
    card: { sections: [{ widgets: [{ textParagraph: { text: args.text } }] }] },
  };
  if (args.threadName) body.thread = { name: args.threadName };

  const res = await fetch("https://chat-middleware.project-aria.workers.dev/api/post-message", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Chat-Middleware-Auth-Key": key,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, body: text.slice(0, 500) };
}

/**
 * Add or remove an emoji reaction on a Google Chat message via the ARIA
 * chat middleware. Best-effort — failures are non-fatal.
 */
export async function sendChatReaction(
  env: Env,
  args: { messageName: string; emoji: string; action: "add" | "remove" },
): Promise<{ ok: boolean; status: number; body: string }> {
  const key = env.ARIA_CHAT_AUTH_KEY;
  if (!key) {
    return { ok: false, status: 500, body: "ARIA_CHAT_AUTH_KEY not set on the Worker" };
  }
  const res = await fetch("https://chat-middleware.project-aria.workers.dev/api/react", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Chat-Middleware-Auth-Key": key,
    },
    body: JSON.stringify({
      messageName: args.messageName,
      action: args.action,
      emoji: args.emoji,
    }),
  });
  const text = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, body: text.slice(0, 500) };
}

/** Helper to silence the unused-symbol lint on resolveAdminEmail import
 *  when callers don't need it. (Kept in the import for future admin
 *  enforcement of who can POST to /create across owners.) */
export const _resolveAdminEmail = resolveAdminEmail;

/** Alias for `buildBrainGoalText` reflecting its current role as a
 *  per-session system-prompt prefix rather than a Dodo goal. */
export const buildBrainPersonaPrefix = buildBrainGoalText;
