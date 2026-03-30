import { z } from "zod";
import {
  bytesToBase64,
  base64ToBytes,
  decryptSecret,
  derivePDK,
  deriveSDK,
  encryptSecret,
  generateDEK,
  generateSalt,
  unwrapDEK,
  wrapDEK,
} from "./crypto";
import { HttpMcpGatekeeper, type McpGatekeeperConfig } from "./mcp-gatekeeper";
import { epochToIso, nowEpoch, SqlHelper, type SqlRow } from "./sql-helpers";
import type { AppConfig, Env, MemoryEntry, SessionIndexRecord, UpdateConfigRequest } from "./types";

const updateConfigSchema = z
  .object({
    activeGateway: z.enum(["opencode", "ai-gateway"]).optional(),
    aiGatewayBaseURL: z.string().url().optional(),
    gitAuthorEmail: z.string().email().optional(),
    gitAuthorName: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    opencodeBaseURL: z.string().url().optional(),
  })
  .strict();

const memoryWriteSchema = z
  .object({
    content: z.string().min(1),
    tags: z.array(z.string().min(1)).default([]),
    title: z.string().min(1),
  })
  .strict();

const mcpConfigCreateSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(["http", "service-binding"]).default("http"),
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

const mcpConfigUpdateSchema = z
  .object({
    name: z.string().min(1).optional(),
    type: z.enum(["http", "service-binding"]).optional(),
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

/**
 * UserControl DO — one per user (`idFromName(email)`).
 *
 * Owns per-user state: sessions, config, memory, tasks,
 * key envelope (envelope encryption), encrypted secrets,
 * MCP configs, and fork snapshots.
 */
export class UserControl implements DurableObject {
  private readonly env: Env;
  private readonly db: SqlHelper;

  constructor(state: DurableObjectState, env: Env) {
    this.env = env;
    this.db = new SqlHelper(state.storage.sql);
    this.initializeSchema();
    this.seedDefaults();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ─── Owner email validation ───
    const headerEmail = request.headers.get("x-owner-email") ?? "";
    if (headerEmail) {
      const stored = this.getOwnerEmail();
      if (!stored) {
        // First request with an owner email — store it
        this.setOwnerEmail(headerEmail);
      } else if (stored !== headerEmail) {
        return Response.json({ error: "Owner email mismatch" }, { status: 403 });
      }
    }

    // Internal secret endpoint requires owner email header to match
    if (url.pathname.startsWith("/internal/secret/")) {
      const stored = this.getOwnerEmail();
      if (!headerEmail || (stored && stored !== headerEmail)) {
        return Response.json({ error: "Owner email required and must match" }, { status: 403 });
      }
    }

    try {
      // ─── Config ───

      if (request.method === "GET" && url.pathname === "/config") {
        return Response.json(this.readConfig());
      }

      if (request.method === "PUT" && url.pathname === "/config") {
        const body = updateConfigSchema.parse((await request.json()) as UpdateConfigRequest);
        return Response.json(this.updateConfig(body));
      }

      // ─── Sessions ───

      if (request.method === "GET" && url.pathname === "/sessions") {
        return Response.json({ sessions: this.listSessions() });
      }

      if (request.method === "POST" && url.pathname === "/sessions") {
        const body = z.object({
          id: z.string().min(1),
          title: z.string().nullable().optional(),
          ownerEmail: z.string().email(),
          createdBy: z.string().email(),
        }).parse(await request.json());
        return Response.json(this.registerSession(body.id, body.title ?? null, body.ownerEmail, body.createdBy), { status: 201 });
      }

      if (request.method === "PATCH" && url.pathname.startsWith("/sessions/")) {
        const sessionId = url.pathname.split("/").at(-1) ?? "";
        const body = z.object({ status: z.string().optional(), title: z.string().nullable().optional() }).strict().parse(await request.json());
        return Response.json(this.touchSession(sessionId, body));
      }

      if (request.method === "GET" && url.pathname.match(/^\/sessions\/[^/]+\/check$/)) {
        const sessionId = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
        const row = this.db.one("SELECT id FROM sessions WHERE id = ?", sessionId);
        if (!row) return Response.json({ error: "Session not found" }, { status: 404 });
        return Response.json({ found: true });
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/sessions/")) {
        const sessionId = url.pathname.split("/").at(-1) ?? "";
        this.db.exec("DELETE FROM sessions WHERE id = ?", sessionId);
        return Response.json({ deleted: true, id: sessionId });
      }

      // ─── Memory ───

      if (request.method === "GET" && url.pathname === "/memory") {
        return Response.json({ entries: this.searchMemory(url.searchParams.get("q") ?? "") });
      }

      if (request.method === "POST" && url.pathname === "/memory") {
        const body = memoryWriteSchema.parse(await request.json());
        return Response.json(this.createMemoryEntry(body), { status: 201 });
      }

      if (request.method === "GET" && url.pathname.startsWith("/memory/")) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        return Response.json(this.getMemoryEntry(id));
      }

      if (request.method === "PUT" && url.pathname.startsWith("/memory/")) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        const body = memoryWriteSchema.parse(await request.json());
        return Response.json(this.updateMemoryEntry(id, body));
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/memory/")) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        this.db.exec("DELETE FROM memory_entries WHERE id = ?", id);
        return Response.json({ deleted: true, id });
      }

      // ─── Tasks ───

      if (request.method === "GET" && url.pathname === "/tasks") {
        return Response.json({ tasks: this.listTasks(url.searchParams.get("status") ?? undefined) });
      }

      if (request.method === "POST" && url.pathname === "/tasks") {
        const body = z.object({ title: z.string().min(1), description: z.string().default(""), priority: z.enum(["low", "medium", "high"]).default("medium") }).parse(await request.json());
        return Response.json(this.createTask(body), { status: 201 });
      }

      if (request.method === "PUT" && url.pathname.startsWith("/tasks/")) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        const body = z.object({ title: z.string().min(1).optional(), description: z.string().optional(), status: z.enum(["backlog", "todo", "in_progress", "done", "cancelled"]).optional(), priority: z.enum(["low", "medium", "high"]).optional(), session_id: z.string().nullable().optional() }).strict().parse(await request.json());
        return Response.json(this.updateTask(id, body));
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/tasks/")) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        this.db.exec("DELETE FROM tasks WHERE id = ?", id);
        return Response.json({ deleted: true, id });
      }

      // ─── Fork snapshots ───

      if (request.method === "POST" && url.pathname === "/fork-snapshots") {
        const payload = await request.text();
        const id = crypto.randomUUID();
        this.db.exec("INSERT INTO fork_snapshots (id, payload, created_at) VALUES (?, ?, ?)", id, payload, nowEpoch());
        return Response.json({ id }, { status: 201 });
      }

      if (request.method === "GET" && url.pathname.startsWith("/fork-snapshots/")) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        const row = this.db.one("SELECT payload FROM fork_snapshots WHERE id = ?", id);
        if (!row) return Response.json({ error: `Fork snapshot ${id} not found` }, { status: 404 });
        return new Response(String(row.payload), { headers: { "content-type": "application/json" } });
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/fork-snapshots/")) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        this.db.exec("DELETE FROM fork_snapshots WHERE id = ?", id);
        return Response.json({ deleted: true, id });
      }

      // ─── MCP Configs ───

      if (request.method === "GET" && url.pathname === "/mcp-configs") {
        return Response.json({ configs: this.listMcpConfigs() });
      }

      if (request.method === "POST" && url.pathname === "/mcp-configs") {
        const body = mcpConfigCreateSchema.parse(await request.json());
        return Response.json(this.createMcpConfig(body), { status: 201 });
      }

      if (request.method === "PUT" && url.pathname.match(/^\/mcp-configs\/[^/]+$/) && !url.pathname.includes("/test")) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        const body = mcpConfigUpdateSchema.parse(await request.json());
        return Response.json(this.updateMcpConfig(id, body));
      }

      if (request.method === "DELETE" && url.pathname.match(/^\/mcp-configs\/[^/]+$/)) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        this.db.exec("DELETE FROM mcp_configs WHERE id = ?", id);
        return Response.json({ deleted: true, id });
      }

      if (request.method === "POST" && url.pathname.match(/^\/mcp-configs\/[^/]+\/test$/)) {
        const id = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
        const row = this.db.one("SELECT id, name, type, url, headers_json, enabled FROM mcp_configs WHERE id = ?", id);
        if (!row) return Response.json({ error: `MCP config ${id} not found` }, { status: 404 });
        const config = this.mapMcpConfigRow(row);
        const gatekeeper = new HttpMcpGatekeeper(config);
        const result = await gatekeeper.testConnection();
        return Response.json(result);
      }

      // ─── Status ───

      if (request.method === "GET" && url.pathname === "/status") {
        return Response.json(this.getStatus());
      }

      // ─── Key Envelope / Passkey ───

      if (request.method === "POST" && url.pathname === "/passkey/init") {
        const body = z.object({ passkey: z.string().min(4) }).parse(await request.json());
        const ownerEmail = request.headers.get("x-owner-email") ?? "";
        await this.initKeyEnvelope(body.passkey, ownerEmail);
        return Response.json({ initialized: true });
      }

      if (request.method === "POST" && url.pathname === "/passkey/change") {
        const body = z.object({ currentPasskey: z.string().min(1), newPasskey: z.string().min(4) }).parse(await request.json());
        const ownerEmail = request.headers.get("x-owner-email") ?? "";
        await this.changePasskey(body.currentPasskey, body.newPasskey, ownerEmail);
        return Response.json({ changed: true });
      }

      if (request.method === "GET" && url.pathname === "/passkey/status") {
        const hasEnvelope = !!this.db.one("SELECT id FROM key_envelope WHERE id = 'default'");
        return Response.json({ initialized: hasEnvelope });
      }

      // ─── Secrets ───

      if (request.method === "GET" && url.pathname === "/secrets") {
        const keys = this.db.all("SELECT key FROM encrypted_secrets ORDER BY key ASC").map((row) => String(row.key));
        return Response.json({ keys });
      }

      if (request.method === "PUT" && url.pathname.startsWith("/secrets/")) {
        const key = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        const body = z.object({ value: z.string().min(1) }).parse(await request.json());
        const ownerEmail = request.headers.get("x-owner-email") ?? "";
        await this.setSecret(key, body.value, ownerEmail);
        return Response.json({ key, updated: true });
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/secrets/") && !url.pathname.includes("/test")) {
        const key = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        this.db.exec("DELETE FROM encrypted_secrets WHERE key = ?", key);
        return Response.json({ deleted: true, key });
      }

      if (request.method === "GET" && url.pathname.match(/^\/secrets\/[^/]+\/test$/)) {
        const key = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
        const exists = !!this.db.one("SELECT key FROM encrypted_secrets WHERE key = ?", key);
        return Response.json({ key, exists });
      }

      // ─── Internal secret access (DO-to-DO) ───

      if (request.method === "GET" && url.pathname.startsWith("/internal/secret/")) {
        const key = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        const ownerEmail = request.headers.get("x-owner-email") ?? "";
        const value = await this.getSecret(key, ownerEmail);
        if (value === null) return Response.json({ error: "Secret not found" }, { status: 404 });
        return Response.json({ value });
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected request failure";
      return Response.json({ error: message }, { status: 400 });
    }
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        owner_email TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'backlog',
        priority TEXT NOT NULL DEFAULT 'medium',
        session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS key_envelope (
        id TEXT PRIMARY KEY DEFAULT 'default',
        pbkdf2_salt TEXT NOT NULL,
        wrapped_dek_passkey TEXT NOT NULL,
        wrapped_dek_server TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        rotated_at INTEGER
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS encrypted_secrets (
        key TEXT PRIMARY KEY,
        encrypted_value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fork_snapshots (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'http',
        url TEXT,
        headers_json TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // TTL cleanup: remove fork snapshots older than 1 hour
    const oneHourAgo = nowEpoch() - 3600;
    this.db.exec("DELETE FROM fork_snapshots WHERE created_at < ?", oneHourAgo);
  }

  private seedDefaults(): void {
    const now = nowEpoch();
    const defaults: AppConfig = {
      activeGateway: "opencode",
      aiGatewayBaseURL: this.env.AI_GATEWAY_BASE_URL,
      gitAuthorEmail: this.env.GIT_AUTHOR_EMAIL ?? "dodo@example.com",
      gitAuthorName: this.env.GIT_AUTHOR_NAME ?? "Dodo",
      model: this.env.DEFAULT_MODEL,
      opencodeBaseURL: this.env.OPENCODE_BASE_URL,
    };

    for (const [key, value] of Object.entries(defaults)) {
      this.db.exec("INSERT OR IGNORE INTO user_config (key, value, updated_at) VALUES (?, ?, ?)", key, String(value), now);
    }
  }

  // ─── Owner Email ───

  private getOwnerEmail(): string | null {
    const row = this.db.one("SELECT value FROM user_config WHERE key = 'owner_email'");
    return row ? String(row.value) : null;
  }

  private setOwnerEmail(email: string): void {
    this.db.exec(
      "INSERT INTO user_config (key, value, updated_at) VALUES ('owner_email', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      email,
      nowEpoch(),
    );
  }

  // ─── Config ───

  private readConfig(): AppConfig {
    const rows = this.db.all("SELECT key, value FROM user_config");
    const values = Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]));
    return {
      activeGateway: values.activeGateway === "ai-gateway" ? "ai-gateway" : "opencode",
      aiGatewayBaseURL: values.aiGatewayBaseURL ?? this.env.AI_GATEWAY_BASE_URL,
      gitAuthorEmail: values.gitAuthorEmail ?? this.env.GIT_AUTHOR_EMAIL ?? "dodo@example.com",
      gitAuthorName: values.gitAuthorName ?? this.env.GIT_AUTHOR_NAME ?? "Dodo",
      model: values.model ?? this.env.DEFAULT_MODEL,
      opencodeBaseURL: values.opencodeBaseURL ?? this.env.OPENCODE_BASE_URL,
    };
  }

  private updateConfig(input: UpdateConfigRequest): AppConfig {
    const nextConfig = { ...this.readConfig(), ...input };
    const now = nowEpoch();
    for (const [key, value] of Object.entries(nextConfig)) {
      this.db.exec(
        "INSERT INTO user_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        key,
        String(value),
        now,
      );
    }
    return this.readConfig();
  }

  // ─── Sessions ───

  private registerSession(id: string, title: string | null, ownerEmail: string, createdBy: string): SessionIndexRecord {
    const now = nowEpoch();
    this.db.exec(
      "INSERT INTO sessions (id, title, status, owner_email, created_by, created_at, updated_at) VALUES (?, ?, 'idle', ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
      id,
      title,
      ownerEmail,
      createdBy,
      now,
      now,
    );
    return this.getSession(id);
  }

  private touchSession(id: string, patch: { status?: string; title?: string | null }): SessionIndexRecord {
    const current = this.getSession(id);
    const nextTitle = patch.title === undefined ? current.title : patch.title;
    const nextStatus = patch.status ?? current.status;
    const now = nowEpoch();
    this.db.exec("UPDATE sessions SET title = ?, status = ?, updated_at = ? WHERE id = ?", nextTitle, nextStatus, now, id);
    return this.getSession(id);
  }

  private listSessions(): SessionIndexRecord[] {
    return this.db.all("SELECT id, title, status, owner_email, created_by, created_at, updated_at FROM sessions ORDER BY updated_at DESC")
      .map((row) => this.mapSessionRow(row));
  }

  private getSession(id: string): SessionIndexRecord {
    const row = this.db.one("SELECT id, title, status, owner_email, created_by, created_at, updated_at FROM sessions WHERE id = ?", id);
    if (!row) throw new Error(`Session ${id} not found`);
    return this.mapSessionRow(row);
  }

  private mapSessionRow(row: SqlRow): SessionIndexRecord {
    return {
      createdAt: epochToIso(row.created_at),
      id: String(row.id),
      ownerEmail: String(row.owner_email),
      createdBy: String(row.created_by),
      status: String(row.status),
      title: row.title === null ? null : String(row.title),
      updatedAt: epochToIso(row.updated_at),
    };
  }

  // ─── Memory ───

  private createMemoryEntry(input: { content: string; tags: string[]; title: string }): MemoryEntry {
    const id = crypto.randomUUID();
    const now = nowEpoch();
    this.db.exec(
      "INSERT INTO memory_entries (id, title, content, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      id, input.title, input.content, JSON.stringify(input.tags), now, now,
    );
    return this.getMemoryEntry(id);
  }

  private updateMemoryEntry(id: string, input: { content: string; tags: string[]; title: string }): MemoryEntry {
    this.db.exec(
      "UPDATE memory_entries SET title = ?, content = ?, tags_json = ?, updated_at = ? WHERE id = ?",
      input.title, input.content, JSON.stringify(input.tags), nowEpoch(), id,
    );
    return this.getMemoryEntry(id);
  }

  private getMemoryEntry(id: string): MemoryEntry {
    const row = this.db.one("SELECT id, title, content, tags_json, created_at, updated_at FROM memory_entries WHERE id = ?", id);
    if (!row) throw new Error(`Memory entry ${id} not found`);
    return this.mapMemoryRow(row);
  }

  private searchMemory(query: string): MemoryEntry[] {
    if (!query.trim()) {
      return this.db.all(
        "SELECT id, title, content, tags_json, created_at, updated_at FROM memory_entries ORDER BY updated_at DESC LIMIT 25",
      ).map((row) => this.mapMemoryRow(row));
    }
    const escaped = query.toLowerCase().replace(/[%_\\]/g, "\\$&");
    const pattern = `%${escaped}%`;
    return this.db.all(
      "SELECT id, title, content, tags_json, created_at, updated_at FROM memory_entries WHERE lower(title) LIKE ? ESCAPE '\\' OR lower(content) LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 25",
      pattern,
      pattern,
    ).map((row) => this.mapMemoryRow(row));
  }

  private mapMemoryRow(row: SqlRow): MemoryEntry {
    return {
      content: String(row.content),
      createdAt: epochToIso(row.created_at),
      id: String(row.id),
      tags: JSON.parse(String(row.tags_json)) as string[],
      title: String(row.title),
      updatedAt: epochToIso(row.updated_at),
    };
  }

  // ─── Tasks ───

  private createTask(input: { title: string; description: string; priority: string }): { id: string; title: string; description: string; status: string; priority: string; sessionId: string | null; createdAt: string; updatedAt: string } {
    const id = crypto.randomUUID();
    const now = nowEpoch();
    this.db.exec(
      "INSERT INTO tasks (id, title, description, status, priority, created_at, updated_at) VALUES (?, ?, ?, 'backlog', ?, ?, ?)",
      id, input.title, input.description, input.priority, now, now,
    );
    return this.getTask(id);
  }

  private updateTask(id: string, patch: { title?: string; description?: string; status?: string; priority?: string; session_id?: string | null }): { id: string; title: string; description: string; status: string; priority: string; sessionId: string | null; createdAt: string; updatedAt: string } {
    const current = this.getTask(id);
    const now = nowEpoch();
    this.db.exec(
      "UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, session_id = ?, updated_at = ? WHERE id = ?",
      patch.title ?? current.title,
      patch.description ?? current.description,
      patch.status ?? current.status,
      patch.priority ?? current.priority,
      patch.session_id === undefined ? (current.sessionId ?? null) : patch.session_id,
      now,
      id,
    );
    return this.getTask(id);
  }

  private getTask(id: string): { id: string; title: string; description: string; status: string; priority: string; sessionId: string | null; createdAt: string; updatedAt: string } {
    const row = this.db.one("SELECT id, title, description, status, priority, session_id, created_at, updated_at FROM tasks WHERE id = ?", id);
    if (!row) throw new Error(`Task ${id} not found`);
    return {
      id: String(row.id),
      title: String(row.title),
      description: String(row.description),
      status: String(row.status),
      priority: String(row.priority),
      sessionId: row.session_id === null ? null : String(row.session_id),
      createdAt: epochToIso(row.created_at),
      updatedAt: epochToIso(row.updated_at),
    };
  }

  private listTasks(statusFilter?: string): Array<{ id: string; title: string; description: string; status: string; priority: string; sessionId: string | null; createdAt: string; updatedAt: string }> {
    const rows = statusFilter
      ? this.db.all("SELECT id, title, description, status, priority, session_id, created_at, updated_at FROM tasks WHERE status = ? ORDER BY updated_at DESC", statusFilter)
      : this.db.all("SELECT id, title, description, status, priority, session_id, created_at, updated_at FROM tasks ORDER BY updated_at DESC");
    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      description: String(row.description),
      status: String(row.status),
      priority: String(row.priority),
      sessionId: row.session_id === null ? null : String(row.session_id),
      createdAt: epochToIso(row.created_at),
      updatedAt: epochToIso(row.updated_at),
    }));
  }

  // ─── MCP Configs ───

  private createMcpConfig(input: { name: string; type: string; url?: string; headers?: Record<string, string>; enabled: boolean }): McpGatekeeperConfig {
    const id = crypto.randomUUID();
    const now = nowEpoch();
    this.db.exec(
      "INSERT INTO mcp_configs (id, name, type, url, headers_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id, input.name, input.type, input.url ?? null, input.headers ? JSON.stringify(input.headers) : null, input.enabled ? 1 : 0, now, now,
    );
    return this.getMcpConfig(id);
  }

  private updateMcpConfig(id: string, patch: { name?: string; type?: string; url?: string; headers?: Record<string, string>; enabled?: boolean }): McpGatekeeperConfig {
    const current = this.getMcpConfig(id);
    const now = nowEpoch();
    this.db.exec(
      "UPDATE mcp_configs SET name = ?, type = ?, url = ?, headers_json = ?, enabled = ?, updated_at = ? WHERE id = ?",
      patch.name ?? current.name,
      patch.type ?? current.type,
      patch.url ?? current.url ?? null,
      patch.headers ? JSON.stringify(patch.headers) : (current.headers ? JSON.stringify(current.headers) : null),
      (patch.enabled !== undefined ? patch.enabled : current.enabled) ? 1 : 0,
      now,
      id,
    );
    return this.getMcpConfig(id);
  }

  private getMcpConfig(id: string): McpGatekeeperConfig {
    const row = this.db.one("SELECT id, name, type, url, headers_json, enabled FROM mcp_configs WHERE id = ?", id);
    if (!row) throw new Error(`MCP config ${id} not found`);
    return this.mapMcpConfigRow(row);
  }

  private listMcpConfigs(): McpGatekeeperConfig[] {
    return this.db.all("SELECT id, name, type, url, headers_json, enabled FROM mcp_configs ORDER BY name ASC")
      .map((row) => this.mapMcpConfigRow(row));
  }

  private mapMcpConfigRow(row: SqlRow): McpGatekeeperConfig {
    return {
      id: String(row.id),
      name: String(row.name),
      type: String(row.type) as "http" | "service-binding",
      url: row.url === null ? undefined : String(row.url),
      headers: row.headers_json ? (JSON.parse(String(row.headers_json)) as Record<string, string>) : undefined,
      enabled: Number(row.enabled) === 1,
    };
  }

  // ─── Status ───

  private getStatus(): { version: string; sessionCount: number; hasPasskey: boolean } {
    const sessionCount = Number(this.db.one("SELECT COUNT(*) AS count FROM sessions")?.count ?? 0);
    const hasPasskey = !!this.db.one("SELECT id FROM key_envelope WHERE id = 'default'");
    return {
      version: this.env.DODO_VERSION ?? "dev",
      sessionCount,
      hasPasskey,
    };
  }

  // ─── Key Envelope / Encryption ───

  private async initKeyEnvelope(passkey: string, ownerEmail: string): Promise<void> {
    const existing = this.db.one("SELECT id FROM key_envelope WHERE id = 'default'");
    if (existing) throw new Error("Key envelope already initialized. Use passkey/change to update.");

    const masterKeyHex = this.env.SECRETS_MASTER_KEY;
    if (!masterKeyHex) throw new Error("Server encryption not configured");

    const salt = generateSalt();
    const dek = generateDEK();
    const pdk = await derivePDK(passkey, salt);
    const sdk = await deriveSDK(masterKeyHex, ownerEmail);
    const wrappedPasskey = await wrapDEK(dek, pdk);
    const wrappedServer = await wrapDEK(dek, sdk);

    this.db.exec(
      "INSERT INTO key_envelope (id, pbkdf2_salt, wrapped_dek_passkey, wrapped_dek_server, created_at) VALUES ('default', ?, ?, ?, ?)",
      bytesToBase64(salt),
      wrappedPasskey,
      wrappedServer,
      nowEpoch(),
    );
  }

  private async unwrapDEKWithServer(ownerEmail: string): Promise<Uint8Array> {
    const masterKeyHex = this.env.SECRETS_MASTER_KEY;
    if (!masterKeyHex) throw new Error("Server encryption not configured");

    const envelope = this.db.one("SELECT wrapped_dek_server FROM key_envelope WHERE id = 'default'");
    if (!envelope) throw new Error("No key envelope. User must complete onboarding.");
    const sdk = await deriveSDK(masterKeyHex, ownerEmail);
    return unwrapDEK(String(envelope.wrapped_dek_server), sdk);
  }

  private async unwrapDEKWithPasskey(passkey: string): Promise<Uint8Array> {
    const envelope = this.db.one("SELECT pbkdf2_salt, wrapped_dek_passkey FROM key_envelope WHERE id = 'default'");
    if (!envelope) throw new Error("No key envelope.");
    const salt = base64ToBytes(String(envelope.pbkdf2_salt));
    const pdk = await derivePDK(passkey, salt);
    return unwrapDEK(String(envelope.wrapped_dek_passkey), pdk);
  }

  private async setSecret(key: string, plaintext: string, ownerEmail: string): Promise<void> {
    const dek = await this.unwrapDEKWithServer(ownerEmail);
    try {
      const encrypted = await encryptSecret(plaintext, dek);
      const now = nowEpoch();
      this.db.exec(
        "INSERT INTO encrypted_secrets (key, encrypted_value, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET encrypted_value = excluded.encrypted_value, updated_at = excluded.updated_at",
        key,
        encrypted,
        now,
        now,
      );
    } finally {
      dek.fill(0);
    }
  }

  private async getSecret(key: string, ownerEmail: string): Promise<string | null> {
    const row = this.db.one("SELECT encrypted_value FROM encrypted_secrets WHERE key = ?", key);
    if (!row) return null;
    const dek = await this.unwrapDEKWithServer(ownerEmail);
    try {
      return await decryptSecret(String(row.encrypted_value), dek);
    } finally {
      dek.fill(0);
    }
  }

  private async changePasskey(currentPasskey: string, newPasskey: string, ownerEmail: string): Promise<void> {
    // Verify current passkey works
    const dek = await this.unwrapDEKWithPasskey(currentPasskey);
    try {
      // Generate new salt and PDK
      const newSalt = generateSalt();
      const newPdk = await derivePDK(newPasskey, newSalt);
      const newWrappedPasskey = await wrapDEK(dek, newPdk);
      this.db.exec(
        "UPDATE key_envelope SET pbkdf2_salt = ?, wrapped_dek_passkey = ?, rotated_at = ? WHERE id = 'default'",
        bytesToBase64(newSalt),
        newWrappedPasskey,
        nowEpoch(),
      );
    } finally {
      dek.fill(0);
    }
  }
}
