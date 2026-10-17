/**
 * Write Think-era history the way @cloudflare/think's SessionManager did
 * (same tables and columns), so tests can build pre-pi sessions now that
 * Dodo only reads them (src/think-history.ts).
 */
import type { UIMessage } from "ai";

type Sql = DurableObjectStorage["sql"];

export class ThinkHistoryWriter {
  private last: string | null = null;
  private tick = 0;
  constructor(private readonly sql: Sql, readonly sessionId = crypto.randomUUID()) {
    sql.exec(`CREATE TABLE IF NOT EXISTS assistant_sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS assistant_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_id TEXT,
      role TEXT NOT NULL, content TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS assistant_compactions (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, summary TEXT NOT NULL,
      from_message_id TEXT NOT NULL, to_message_id TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    sql.exec("INSERT OR IGNORE INTO assistant_sessions (id, name) VALUES (?, 'default')", sessionId);
  }

  append(msg: Pick<UIMessage, "id" | "role"> & { parts: unknown[] }): this {
    // Distinct created_at values keep "latest leaf" ordering deterministic.
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick++)).toISOString().replace("T", " ").slice(0, 19);
    this.sql.exec(
      "INSERT INTO assistant_messages (id, session_id, parent_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      msg.id, this.sessionId, this.last, msg.role, JSON.stringify(msg), at,
    );
    this.last = msg.id;
    return this;
  }

  compact(summary: string, fromId: string, toId: string): this {
    this.sql.exec(
      "INSERT INTO assistant_compactions (id, session_id, summary, from_message_id, to_message_id) VALUES (?, ?, ?, ?, ?)",
      crypto.randomUUID(), this.sessionId, summary, fromId, toId,
    );
    return this;
  }
}
