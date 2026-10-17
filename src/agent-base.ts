/**
 * Base class for CodingAgent: an Agents SDK agent with durable fibers, plus
 * the two pieces of the old Think base that Dodo still needs.
 *
 * - Config: one JSON row in `_think_config`, the table Think used, so
 *   existing sessions keep their config with no migration.
 * - Think-era history: a SessionManager over Think's session tables, read
 *   only until a session migrates to pi on its next prompt
 *   (CodingAgent.migrateThinkSessionToPi). Nothing writes new Think history.
 *
 * Dodo's agent loop is pi (src/pi/). ADR 0002, phase 2.
 */
import { Agent } from "agents";
import { withFibers } from "agents/experimental/forever";
import { SessionManager } from "@cloudflare/think/session";
import type { Env } from "./types";

const FiberAgent = withFibers(Agent);

export class DodoAgentBase<Config> extends FiberAgent<Env> {
  /** Think-era transcript tables (read-only in practice). */
  sessions!: SessionManager;
  #thinkSessionId: string | null = null;
  #config: Config | null = null;
  #configTableReady = false;

  override onStart(): void | Promise<void> {
    this.sessions = new SessionManager(this as never, {
      exec: (query: string, ...values: unknown[]) => {
        this.ctx.storage.sql.exec(query, ...(values as never[]));
      },
    } as never);
    this.#thinkSessionId = this.sessions.list()[0]?.id ?? null;
    // Restart fibers an eviction interrupted (the alarm heartbeat also does this).
    void this.checkFibers();
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
    const row = Array.from(this.ctx.storage.sql.exec("SELECT value FROM _think_config WHERE key = 'config'"))[0];
    if (!row) return null;
    this.#config = JSON.parse(String(row.value)) as Config;
    return this.#config;
  }
}
