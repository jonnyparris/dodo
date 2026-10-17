/**
 * Base class for CodingAgent: an Agents SDK agent (fibers are built in since
 * agents 0.2x: runFiber / startFiber / onFiberRecovered), plus
 * the two pieces of the old Think base that Dodo still needs.
 *
 * - Config: one JSON row in `_think_config`, the table Think used, so
 *   existing sessions keep their config with no migration.
 * - Think-era history: a read-only ThinkHistory over Think's old tables,
 *   until a session migrates to pi on its next prompt
 *   (CodingAgent.migrateThinkSessionToPi). Nothing writes Think history.
 *
 * Dodo's agent loop is pi (src/pi/). ADR 0002, phase 2.
 */
import { Agent } from "agents";
import { ThinkHistory } from "./think-history";
import type { Env } from "./types";

/** Error on prompts an upgrade cut off (see migrateLegacyFiberTable). */
export const UPGRADE_INTERRUPTED_ERROR = "Interrupted by a Dodo upgrade. Send it again.";

/**
 * agents 0.8.7's experimental fibers (withFibers) and the built-in fibers of
 * agents >= 0.2x both use a table named `cf_agents_fibers`, with different
 * columns. The SDK's `CREATE TABLE IF NOT EXISTS` keeps the old one and then
 * fails creating its indexes, so the object can't start. Runs before
 * `super()`: fail prompts an old fiber was still running (they can't resume
 * on the new runtime), clear the session's active prompt, drop the table.
 */
export function migrateLegacyFiberTable(sql: SqlStorage): void {
  const cols = Array.from(sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('cf_agents_fibers')")).map((r) => r.name);
  if (!cols.includes("callback") || cols.includes("fiber_id")) return;
  const hasTable = (name: string) => sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;
  if (hasTable("prompts")) {
    const now = Math.floor(Date.now() / 1000);
    const cut = sql
      .exec<{ id: string }>(
        `SELECT id FROM prompts WHERE status IN ('queued', 'running')
           AND fiber_id IN (SELECT id FROM cf_agents_fibers WHERE status IN ('running', 'interrupted'))`,
      )
      .toArray()
      .map((r) => r.id);
    for (const id of cut) {
      sql.exec("UPDATE prompts SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", UPGRADE_INTERRUPTED_ERROR, now, id);
    }
    if (cut.length && hasTable("metadata")) {
      const active = sql.exec<{ value: string }>("SELECT value FROM metadata WHERE key = 'active_prompt_id'").toArray()[0]?.value;
      if (active && cut.includes(active)) {
        sql.exec("DELETE FROM metadata WHERE key = 'active_prompt_id'");
        sql.exec("INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES ('status', 'idle', ?)", now);
      }
    }
  }
  sql.exec("DROP TABLE cf_agents_fibers");
}

export class DodoAgentBase<Config> extends Agent<Env> {
  /** Think-era transcript tables, read-only. */
  sessions!: ThinkHistory;
  #thinkSessionId: string | null = null;
  #config: Config | null = null;
  #configTableReady = false;

  constructor(ctx: DurableObjectState, env: Env) {
    migrateLegacyFiberTable(ctx.storage.sql);
    super(ctx, env);
  }

  override onStart(): void | Promise<void> {
    this.sessions = new ThinkHistory(this.ctx.storage.sql);
    this.#thinkSessionId = this.sessions.sessionIds()[0] ?? null;
    // Interrupted fibers are recovered by the SDK (onFiberRecovered) on
    // activation and from the keepAlive alarm.
  }

  /** The Think session holding pre-pi history, if this session has one. */
  getCurrentSessionId(): string | null {
    return this.#thinkSessionId;
  }

  /** Point at a Think session (used when collapsing duplicate sessions). */
  protected setThinkSessionId(id: string | null): void {
    this.#thinkSessionId = id;
  }

  private ensureConfigTable(): void {
    if (this.#configTableReady) return;
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS _think_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.#configTableReady = true;
  }

  configure(config: Config): void {
    this.ensureConfigTable();
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO _think_config (key, value) VALUES ('config', ?)", JSON.stringify(config));
    this.#config = config;
  }

  getConfig(): Config | null {
    if (this.#config) return this.#config;
    this.ensureConfigTable();
    const row = Array.from(this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM _think_config WHERE key = 'config'"))[0];
    if (!row) return null;
    this.#config = JSON.parse(String(row.value)) as Config;
    return this.#config;
  }
}
