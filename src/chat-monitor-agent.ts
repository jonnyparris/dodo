/**
 * ChatMonitorAgent — proof-of-concept Durable Object that polls a Google
 * Chat space and decides whether to reply to each new message.
 *
 * Design
 * ------
 * - One DO instance per (ownerEmail, spaceId). Use
 *   `idFromName(`${ownerEmail}:${spaceId}`)` from callers so the same
 *   monitor is addressable across requests.
 * - Storage layout (SQLite-backed):
 *     monitor_state(
 *       owner_email TEXT, space_id TEXT, persona TEXT,
 *       poll_interval_seconds INTEGER, last_seen_iso TEXT,
 *       enabled INTEGER, last_error TEXT, last_run_iso TEXT,
 *       created_at INTEGER
 *     )                                                     — single row
 *     replied_messages(message_name TEXT PRIMARY KEY,
 *                      replied_at INTEGER)                  — dedupe set
 * - Alarm loop: when `enabled = 1`, every `alarm()` fire calls the
 *   poll-decide-reply pipeline, then re-arms `alarm()` `poll_interval`
 *   seconds out. When disabled, the alarm chain stops.
 *
 * Reading messages
 * ----------------
 * Uses the cf-portal MCP tool `google-workspace-mcp__chat_get_messages`,
 * with the owner's refresh-token MCP config registered in UserControl.
 * Auth + connection is identical to the CodingAgent path
 * (see `connectMcpServers` in `coding-agent.ts`) — we instantiate one
 * `HttpMcpClient`, call the tool, then disconnect.
 *
 * Sending replies
 * ---------------
 * Uses the ARIA chat middleware (https://chat-middleware.project-aria.workers.dev),
 * which already accepts thread-scoped replies. Auth via the
 * `ARIA_CHAT_AUTH_KEY` wrangler secret.
 *
 * Decision LLM
 * ------------
 * Kimi K2.6 via AI Gateway (`@cf/moonshotai/kimi-k2.6`). No API cost,
 * routed through Workers AI. The model is asked to reply with strict
 * JSON: `{ "reply": false }` or `{ "reply": true, "text": "..." }`.
 *
 * Hard caps (PoC safety rails)
 * ----------------------------
 * - `MAX_MESSAGES_PER_TICK = 5` — never process more than 5 new messages
 *   per alarm fire. Protects against the initial poll on a busy space.
 * - `MIN_POLL_INTERVAL_SECONDS = 10` — Dodo's user-scheduled-sessions
 *   floor is 5 minutes by product policy; this DO is operator-only and
 *   uses a much lower floor. 10s is the DO alarm minimum we'll honour.
 * - Replies always quote the source message text in the prompt — the
 *   model never sees a message without context.
 */

import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { getUserControlStub } from "./auth";
import { HttpMcpClient, type McpClientConfig } from "./mcp-client";
import type { Env } from "./types";

const MIN_POLL_INTERVAL_SECONDS = 10;
const DEFAULT_POLL_INTERVAL_SECONDS = 10;
const MAX_MESSAGES_PER_TICK = 5;
const ARIA_MIDDLEWARE_URL = "https://chat-middleware.project-aria.workers.dev/api/post-message";
/**
 * URLs we'll accept as "the cf-portal MCP server" when looking up the
 * owner's refresh-token MCP config. Both the normal and codemode variants
 * are registered side-by-side after running `/dodo-dcr-oauth` — we prefer
 * the normal one so individual chat tools (not the codemode search+execute
 * pair) are exposed.
 */
const CF_PORTAL_PREFERRED_URLS = [
  "https://portal.mcp.cfdata.org/mcp",
];
/** Substring fallback: any config whose URL hostname matches this hosts cf-portal. */
const CF_PORTAL_URL_SUBSTRING = "portal.mcp.cfdata.org";
/**
 * Substring used to locate the cf-portal "list chat messages" tool at
 * runtime. cf-portal namespaces its child MCP tools with single-underscore
 * separators (e.g. `google-workspace-mcp_chat_get_messages`), which is
 * easy to get wrong if we hard-code the full name and the convention
 * changes. We list portal's tools, find the unique one whose name ends
 * with `chat_get_messages`, and call it by its real name. Exported for
 * tests.
 */
export const CF_PORTAL_CHAT_TOOL_SUFFIX = "chat_get_messages";
const DECISION_MODEL = "@cf/moonshotai/kimi-k2.6";

// ─── Schemas ───

export const createMonitorSchema = z
  .object({
    ownerEmail: z.string().email(),
    spaceId: z.string().min(1).regex(/^spaces\//, "spaceId must look like 'spaces/AAAA...'"),
    persona: z
      .string()
      .min(1)
      .max(4000)
      .describe(
        "Free-form persona / instructions for the LLM decider. e.g. 'You are a polite bot that only replies when directly addressed by name.'",
      ),
    pollIntervalSeconds: z
      .number()
      .int()
      .min(MIN_POLL_INTERVAL_SECONDS)
      .max(3600)
      .default(DEFAULT_POLL_INTERVAL_SECONDS),
  })
  .strict();
export type CreateMonitorInput = z.infer<typeof createMonitorSchema>;

interface MonitorRow {
  owner_email: string;
  space_id: string;
  persona: string;
  poll_interval_seconds: number;
  last_seen_iso: string | null;
  enabled: number;
  last_error: string | null;
  last_run_iso: string | null;
  created_at: number;
}

interface ChatMessage {
  /** Resource name, e.g. `spaces/AAA/messages/BBB.CCC` — used as dedupe key. */
  name: string;
  text: string;
  /** Display name of the sender. */
  senderDisplay: string;
  /** ISO timestamp. */
  createTime: string;
  /** Thread resource name (`spaces/AAA/threads/BBB`) if available. */
  threadName?: string;
}

interface DecisionResult {
  reply: boolean;
  text?: string;
  /** Set when JSON parsing or the model misbehaves. Useful for last_error. */
  raw?: string;
}

// ─── Helpers ───

function isoNow(): string {
  return new Date().toISOString();
}

function log(level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>): void {
  // Match the style other DOs use — JSON-on-one-line for observability.
  const payload = { level, msg, ts: isoNow(), ...fields };
  const out = JSON.stringify(payload);
  if (level === "error") console.error(out);
  else if (level === "warn") console.warn(out);
  else console.info(out);
}

// ─── DO ───

export class ChatMonitorAgent extends DurableObject<Env> {
  private migrated = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  // ── Lifecycle ──

  private ensureMigrations(): void {
    if (this.migrated) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS monitor_state (
        owner_email TEXT NOT NULL,
        space_id TEXT NOT NULL,
        persona TEXT NOT NULL,
        poll_interval_seconds INTEGER NOT NULL,
        last_seen_iso TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_run_iso TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (owner_email, space_id)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS replied_messages (
        message_name TEXT PRIMARY KEY,
        replied_at INTEGER NOT NULL
      )
    `);
    this.migrated = true;
  }

  private readState(): MonitorRow | null {
    this.ensureMigrations();
    const rows = Array.from(this.ctx.storage.sql.exec("SELECT * FROM monitor_state LIMIT 1"));
    if (rows.length === 0) return null;
    const r = rows[0] as unknown as MonitorRow;
    return r;
  }

  private writeState(input: CreateMonitorInput): MonitorRow {
    this.ensureMigrations();
    const now = Math.floor(Date.now() / 1000);
    this.ctx.storage.sql.exec(
      `INSERT INTO monitor_state
         (owner_email, space_id, persona, poll_interval_seconds, last_seen_iso, enabled, created_at)
       VALUES (?, ?, ?, ?, NULL, 0, ?)
       ON CONFLICT (owner_email, space_id) DO UPDATE SET
         persona = excluded.persona,
         poll_interval_seconds = excluded.poll_interval_seconds`,
      input.ownerEmail,
      input.spaceId,
      input.persona,
      input.pollIntervalSeconds,
      now,
    );
    return this.readState()!;
  }

  private setEnabled(enabled: boolean): MonitorRow | null {
    this.ensureMigrations();
    this.ctx.storage.sql.exec(
      "UPDATE monitor_state SET enabled = ? WHERE 1=1",
      enabled ? 1 : 0,
    );
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

  private hasReplied(messageName: string): boolean {
    this.ensureMigrations();
    const rows = Array.from(
      this.ctx.storage.sql.exec(
        "SELECT 1 FROM replied_messages WHERE message_name = ? LIMIT 1",
        messageName,
      ),
    );
    return rows.length > 0;
  }

  private markReplied(messageName: string): void {
    this.ensureMigrations();
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO replied_messages (message_name, replied_at) VALUES (?, ?)",
      messageName,
      Math.floor(Date.now() / 1000),
    );
  }

  // ── HTTP surface (called by index.ts via proxy) ──

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      // POST /create — create or update config (does not start polling)
      if (request.method === "POST" && url.pathname === "/create") {
        const body = createMonitorSchema.parse(await request.json());
        const row = this.writeState(body);
        return Response.json({ state: this.serializeState(row) });
      }

      // POST /start — flip enabled=1 and arm the alarm
      if (request.method === "POST" && url.pathname === "/start") {
        const row = this.setEnabled(true);
        if (!row) {
          return Response.json({ error: "monitor not created — POST /create first" }, { status: 400 });
        }
        await this.ctx.storage.setAlarm(Date.now() + row.poll_interval_seconds * 1000);
        log("info", "monitor started", { space: row.space_id, owner: row.owner_email, intervalS: row.poll_interval_seconds });
        return Response.json({ state: this.serializeState(row) });
      }

      // POST /stop — flip enabled=0; the next alarm fire will see it and not re-arm
      if (request.method === "POST" && url.pathname === "/stop") {
        const row = this.setEnabled(false);
        if (!row) return Response.json({ error: "monitor not created" }, { status: 404 });
        try {
          await this.ctx.storage.deleteAlarm();
        } catch { /* best-effort */ }
        log("info", "monitor stopped", { space: row.space_id, owner: row.owner_email });
        return Response.json({ state: this.serializeState(row) });
      }

      // GET /state
      if (request.method === "GET" && url.pathname === "/state") {
        const row = this.readState();
        if (!row) return Response.json({ error: "monitor not created" }, { status: 404 });
        return Response.json({ state: this.serializeState(row) });
      }

      // POST /tick — fire one cycle now (used for tests / manual debugging)
      if (request.method === "POST" && url.pathname === "/tick") {
        const result = await this.runTick();
        return Response.json(result);
      }

      // DELETE / — wipe storage entirely
      if (request.method === "DELETE" && url.pathname === "/") {
        try {
          await this.ctx.storage.deleteAlarm();
        } catch { /* best-effort */ }
        this.ctx.storage.sql.exec("DROP TABLE IF EXISTS monitor_state");
        this.ctx.storage.sql.exec("DROP TABLE IF EXISTS replied_messages");
        this.migrated = false;
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
      log("warn", "alarm fired with no state — skipping", {});
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
    // Re-arm regardless of success — a single failure shouldn't kill the loop.
    const next = this.readState();
    if (next && next.enabled === 1) {
      await this.ctx.storage.setAlarm(Date.now() + next.poll_interval_seconds * 1000);
    }
  }

  // ── Core loop ──

  /**
   * One poll-decide-reply cycle. Returns a summary suitable for HTTP
   * responses (so `/tick` is useful for debugging).
   */
  private async runTick(): Promise<{
    fetched: number;
    new: number;
    replied: number;
    skipped: number;
    errors: string[];
    /**
     * Per-message decisions (PoC-only). One entry per candidate that the
     * model evaluated, regardless of replied/skipped outcome. Helpful for
     * tuning personas and verifying the model is parsing input correctly.
     * Truncated to first 200 chars of model output.
     */
    decisions: Array<{
      messageName: string;
      senderDisplay: string;
      sourceText: string;
      reply: boolean;
      replyText?: string;
      rawModelOutput?: string;
    }>;
  }> {
    const row = this.readState();
    if (!row) throw new Error("runTick: no state");

    const errors: string[] = [];

    // 1. Pull recent messages from cf-portal.
    const messages = await this.fetchMessages(row.owner_email, row.space_id, row.last_seen_iso);

    // 2. Filter to never-seen-before and not-already-replied-to.
    const candidates: ChatMessage[] = [];
    for (const m of messages) {
      if (this.hasReplied(m.name)) continue;
      if (row.last_seen_iso && m.createTime <= row.last_seen_iso) continue;
      candidates.push(m);
    }
    candidates.sort((a, b) => a.createTime.localeCompare(b.createTime));
    const limited = candidates.slice(0, MAX_MESSAGES_PER_TICK);

    let replied = 0;
    let skipped = 0;
    const decisions: Array<{
      messageName: string;
      senderDisplay: string;
      sourceText: string;
      reply: boolean;
      replyText?: string;
      rawModelOutput?: string;
    }> = [];

    // 3. For each, ask the model whether to reply; if yes, send it.
    for (const msg of limited) {
      try {
        const decision = await this.decide(row.persona, msg);
        decisions.push({
          messageName: msg.name,
          senderDisplay: msg.senderDisplay,
          sourceText: msg.text.slice(0, 200),
          reply: decision.reply,
          replyText: decision.text,
          rawModelOutput: decision.raw?.slice(0, 200),
        });
        if (decision.reply && decision.text) {
          await this.sendReply(row.space_id, msg, decision.text);
          replied++;
        } else {
          skipped++;
        }
        this.markReplied(msg.name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${msg.name}: ${message}`);
      }
    }

    // 4. Update lastSeen to the newest message we observed (even if we
    //    skipped it). Use the max of observed createTime, not just the
    //    processed batch, so a busy space doesn't loop forever.
    const newestSeen = messages
      .map((m) => m.createTime)
      .sort()
      .pop();
    this.recordTick(newestSeen ?? row.last_seen_iso);

    return { fetched: messages.length, new: candidates.length, replied, skipped, errors, decisions };
  }

  // ── cf-portal MCP read path ──

  /**
   * Open a one-shot HttpMcpClient against cf-portal, call
   * `chat_get_messages`, return parsed messages. Disconnect on the way
   * out. Mirrors `connectMcpServers` in coding-agent.ts but without the
   * gatekeeper machinery (single tool, single call).
   */
  private async fetchMessages(
    ownerEmail: string,
    spaceId: string,
    afterIso: string | null,
  ): Promise<ChatMessage[]> {
    const stub = getUserControlStub(this.env, ownerEmail);

    // 1. Look up the cf-portal config. Configs are listed by id (UUID after
    //    DCR), so we have to match on URL. Prefer the canonical portal URL
    //    over the codemode variant.
    const cfgRes = await stub.fetch("https://user-control/mcp-configs", {
      headers: { "x-owner-email": ownerEmail },
    });
    if (!cfgRes.ok) {
      throw new Error(`cf-portal config list failed (${cfgRes.status})`);
    }
    const { configs } = (await cfgRes.json()) as { configs: McpClientConfig[] };
    const cfg = pickCfPortalConfig(configs);
    if (!cfg) {
      throw new Error(
        `cf-portal MCP config not found for ${ownerEmail}. Run /dodo-dcr-oauth first.`,
      );
    }
    if (!cfg.url) throw new Error("cf-portal config has no url");

    // 2. Resolve current access token by the resolved config's ID.
    const tokenRes = await stub.fetch(
      `https://user-control/mcp-configs/${encodeURIComponent(cfg.id)}/access-token`,
      { headers: { "x-owner-email": ownerEmail } },
    );
    if (!tokenRes.ok) {
      throw new Error(
        `cf-portal access-token fetch failed (${tokenRes.status}) for config ${cfg.id}.`,
      );
    }
    const { accessToken } = (await tokenRes.json()) as { accessToken?: string };
    if (!accessToken) throw new Error("cf-portal returned no access token");

    const client = new HttpMcpClient(
      {
        ...cfg,
        headers: { Authorization: `Bearer ${accessToken}` },
      },
      0,
    );
    try {
      await client.connect();
      // HttpMcpClient.listTools() returns tools already namespaced as
      // `<configId>__<originalName>`. callTool() strips the `<configId>__`
      // prefix before forwarding, so we have to pass the namespaced form.
      // We pick the unique `chat_get_messages` variant — cf-portal uses
      // single-underscore separators (e.g. `google-workspace-mcp_chat_get_messages`),
      // so a literal compile-time name is fragile.
      const tools = await client.listTools();
      const chatTool = findChatGetMessagesTool(tools);
      if (!chatTool) {
        throw new Error(
          `chat_get_messages tool not found on cf-portal; available: ${tools.slice(0, 5).map((t) => t.name).join(", ")}`,
        );
      }
      const callArgs: Record<string, unknown> = {
        spaceName: spaceId,
        maxResults: 25,
        newestFirst: false,
      };
      if (afterIso) callArgs.after = afterIso;

      const result = await client.callTool(chatTool.name, callArgs);
      if (result.isError) {
        const text = result.content.map((c) => c.text ?? "").join("\n");
        throw new Error(`chat_get_messages error: ${text.slice(0, 500)}`);
      }
      return parseChatGetMessagesResult(result.content);
    } finally {
      client.disconnect();
    }
  }

  // ── LLM decider ──

  private async decide(persona: string, msg: ChatMessage): Promise<DecisionResult> {
    const system = [
      "You are a Google Chat reply-decider.",
      "Given a persona description and ONE incoming chat message, decide whether to reply.",
      "",
      "Persona:",
      persona,
      "",
      "Output rules — STRICT:",
      '- Reply with one line of JSON, no prose, no markdown fences.',
      '- If you should NOT reply: {"reply": false}',
      '- If you should reply: {"reply": true, "text": "..."}',
      "- Keep reply text under 500 characters.",
      "- Never include @mentions, links you weren't given, or fabricated facts.",
    ].join("\n");

    const user = [
      `Sender: ${msg.senderDisplay}`,
      `Time: ${msg.createTime}`,
      `Message: ${msg.text}`,
    ].join("\n");

    // Workers AI binding — direct call. The PoC doesn't need the full
    // subagent-runner stack since we have no tools, no system-prompt
    // chunking, no streaming.
    // The Workers AI types are auto-generated from a fixed model list; Kimi
    // K2.6 isn't in the published `AiModels` map yet, so the model id has to
    // be cast through `string` to satisfy the binding's overloads.
    const aiResp = (await this.env.AI.run(
      DECISION_MODEL as unknown as Parameters<Ai["run"]>[0],
      {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: 256,
      } as unknown as Parameters<Ai["run"]>[1],
    )) as { response?: string };

    const raw = (aiResp?.response ?? "").trim();
    if (!raw) return { reply: false, raw: "(empty model output)" };

    // Try to find JSON in case the model wrapped it.
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const candidate = jsonMatch ? jsonMatch[0] : raw;
    try {
      const parsed = JSON.parse(candidate) as { reply?: boolean; text?: string };
      if (parsed.reply === true && typeof parsed.text === "string" && parsed.text.trim().length > 0) {
        return { reply: true, text: parsed.text.trim().slice(0, 500), raw };
      }
      return { reply: false, raw };
    } catch {
      return { reply: false, raw };
    }
  }

  // ── ARIA send path ──

  private async sendReply(spaceId: string, source: ChatMessage, text: string): Promise<void> {
    const key = this.env.ARIA_CHAT_AUTH_KEY;
    if (!key) {
      throw new Error(
        "ARIA_CHAT_AUTH_KEY not set on Dodo Worker — wrangler secret put ARIA_CHAT_AUTH_KEY",
      );
    }

    const body: Record<string, unknown> = {
      spaceId,
      card: {
        sections: [{ widgets: [{ textParagraph: { text } }] }],
      },
    };
    if (source.threadName) {
      body.thread = { name: source.threadName };
    }

    const res = await fetch(ARIA_MIDDLEWARE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Chat-Middleware-Auth-Key": key,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ARIA send failed ${res.status}: ${text.slice(0, 300)}`);
    }
  }

  // ── Serializers ──

  private serializeState(row: MonitorRow) {
    return {
      ownerEmail: row.owner_email,
      spaceId: row.space_id,
      persona: row.persona,
      pollIntervalSeconds: row.poll_interval_seconds,
      lastSeenIso: row.last_seen_iso,
      enabled: row.enabled === 1,
      lastError: row.last_error,
      lastRunIso: row.last_run_iso,
      createdAt: row.created_at,
    };
  }
}

// ─── Result parser ───

/**
 * Parse the cf-portal `chat_get_messages` response into our shape.
 * The MCP server returns its body as a JSON string inside `content[0].text`.
 *
 * The Google Chat API result is `{ messages: Message[], nextPageToken?: string }`.
 * Each Message has `name`, `text`, `createTime`, `sender { displayName }`,
 * and `thread { name }`. Tolerant to missing fields — exported for tests.
 */
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
    const messageText = typeof obj.text === "string" ? obj.text : "";
    const sender = obj.sender as { displayName?: string } | undefined;
    const senderDisplay = sender?.displayName ?? "Unknown";
    const thread = obj.thread as { name?: string } | undefined;
    out.push({
      name,
      text: messageText,
      senderDisplay,
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
    // cf-portal sometimes wraps the API response in `{ result: { messages: [...] } }`.
    if (obj.result && typeof obj.result === "object") {
      const inner = obj.result as Record<string, unknown>;
      if (Array.isArray(inner.messages)) return inner.messages;
    }
  }
  return [];
}

/** Resolve the canonical DO id for a given (owner, space) pair. */
export function chatMonitorIdName(ownerEmail: string, spaceId: string): string {
  return `${ownerEmail.toLowerCase()}:${spaceId}`;
}

/**
 * Find the `chat_get_messages` tool in cf-portal's tool list. cf-portal's
 * tool names look like `google-workspace-mcp_chat_get_messages` after
 * HttpMcpClient adds its `<configId>__` namespace prefix — so the full
 * name is `<configId>__google-workspace-mcp_chat_get_messages`. We
 * tolerate small naming changes by matching against the suffix.
 *
 * Prefer an exact suffix match over substring matches so we don't pick up
 * `chat_get_messages_history` or similar variants. Exported for tests.
 */
export function findChatGetMessagesTool<T extends { name: string }>(
  tools: T[],
): T | null {
  const exact = tools.find((t) => t.name.endsWith(`_${CF_PORTAL_CHAT_TOOL_SUFFIX}`));
  if (exact) return exact;
  return tools.find((t) => t.name.endsWith(CF_PORTAL_CHAT_TOOL_SUFFIX)) ?? null;
}

/**
 * Pick the cf-portal MCP config from a user's config list.
 *
 * After `/dodo-dcr-oauth` two configs land side-by-side: the canonical
 * URL and the `?codemode=search_and_execute` variant. The codemode
 * variant exposes only `search` and `execute`, not the individual
 * `chat_get_messages` tool — so we prefer the canonical URL.
 *
 * Falls back to any config whose URL contains `portal.mcp.cfdata.org`.
 * Returns null if nothing matches. Exported for tests.
 */
export function pickCfPortalConfig(
  configs: McpClientConfig[],
): McpClientConfig | null {
  for (const preferred of CF_PORTAL_PREFERRED_URLS) {
    const hit = configs.find((c) => c.url === preferred);
    if (hit) return hit;
  }
  const fallback = configs.find(
    (c) =>
      c.auth_type === "refresh_token" &&
      typeof c.url === "string" &&
      c.url.includes(CF_PORTAL_URL_SUBSTRING) &&
      !c.url.includes("codemode"),
  );
  return fallback ?? null;
}
