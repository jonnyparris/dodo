/**
 * Read-only access to Think-era transcripts (sessions from before pi).
 *
 * Think stored a branching message tree in `assistant_sessions` /
 * `assistant_messages` / `assistant_compactions`. Dodo only reads it to show
 * an unmigrated session and to move it to pi on its next prompt
 * (CodingAgent.migrateThinkSessionToPi). Same semantics as Think's
 * SessionManager.getHistory: the path to the latest leaf, with compacted
 * ranges replaced by a `[Previous conversation summary]` system message.
 *
 * Never creates tables: a session with no Think history has none.
 */
import type { UIMessage } from "ai";

type Sql = DurableObjectStorage["sql"];
type Row = Record<string, SqlStorageValue>;

export class ThinkHistory {
  #present = false;
  constructor(private readonly sql: Sql) {}

  /** Whether this DO has Think tables at all. Only a yes is cached. */
  private present(): boolean {
    this.#present ||=
      Array.from(this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'assistant_messages'")).length > 0;
    return this.#present;
  }

  /** Think session ids, most recently updated first. */
  sessionIds(): string[] {
    if (!this.present()) return [];
    return Array.from(this.sql.exec("SELECT id FROM assistant_sessions ORDER BY updated_at DESC")).map((r) => String(r.id));
  }

  getMessageCount(sessionId: string): number {
    if (!this.present()) return 0;
    const row = Array.from(this.sql.exec("SELECT COUNT(*) AS n FROM assistant_messages WHERE session_id = ?", sessionId))[0];
    return Number(row?.n ?? 0);
  }

  compactionCount(sessionId: string): number {
    if (!this.present()) return 0;
    const row = Array.from(this.sql.exec("SELECT COUNT(*) AS n FROM assistant_compactions WHERE session_id = ?", sessionId))[0];
    return Number(row?.n ?? 0);
  }

  getHistory(sessionId: string): UIMessage[] {
    if (!this.present()) return [];
    const leaf = Array.from(
      this.sql.exec(
        `SELECT m.id FROM assistant_messages m
         LEFT JOIN assistant_messages c ON c.parent_id = m.id
         WHERE m.session_id = ? AND c.id IS NULL
         ORDER BY m.created_at DESC LIMIT 1`,
        sessionId,
      ),
    )[0];
    if (!leaf) return [];
    const path = Array.from(
      this.sql.exec(
        `WITH RECURSIVE path AS (
           SELECT id, parent_id, content, 0 AS depth FROM assistant_messages WHERE id = ?
           UNION ALL
           SELECT m.id, m.parent_id, m.content, p.depth + 1 FROM assistant_messages m JOIN path p ON m.id = p.parent_id
         )
         SELECT id, content FROM path ORDER BY depth DESC`,
        String(leaf.id),
      ),
    ) as Row[];
    const compactions = Array.from(
      this.sql.exec("SELECT id, summary, from_message_id, to_message_id FROM assistant_compactions WHERE session_id = ? ORDER BY created_at ASC", sessionId),
    ) as Row[];
    const ids = path.map((m) => String(m.id));
    const out: UIMessage[] = [];
    for (let i = 0; i < path.length; ) {
      const c = compactions.find((x) => String(x.from_message_id) === ids[i]);
      const end = c ? ids.indexOf(String(c.to_message_id)) : -1;
      if (c && end >= i) {
        out.push({ id: `compaction_${String(c.id)}`, role: "system", parts: [{ type: "text", text: `[Previous conversation summary]\n${String(c.summary)}` }] });
        i = end + 1;
      } else {
        out.push(JSON.parse(String(path[i]!.content)) as UIMessage);
        i++;
      }
    }
    return out;
  }

  delete(sessionId: string): void {
    if (!this.present()) return;
    this.sql.exec("DELETE FROM assistant_compactions WHERE session_id = ?", sessionId);
    this.sql.exec("DELETE FROM assistant_messages WHERE session_id = ?", sessionId);
    this.sql.exec("DELETE FROM assistant_sessions WHERE id = ?", sessionId);
  }
}
