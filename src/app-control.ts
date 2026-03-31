/** @deprecated Use UserControl + SharedIndex instead. Kept only for one-time data migration. */

import { z } from "zod";
import { epochToIso, nowEpoch, SqlHelper, type SqlRow } from "./sql-helpers";
import type { AllowlistEntry, AppConfig, Env, MemoryEntry, UpdateConfigRequest } from "./types";

/** Legacy session record (without owner_email, created_by). */
interface LegacySessionIndexRecord {
  createdAt: string;
  id: string;
  status: string;
  title: string | null;
  updatedAt: string;
}

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

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase();
}

export class AppControl implements DurableObject {
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

    if (request.method === "GET" && url.pathname === "/config") {
      return Response.json(this.readConfig());
    }

    if (request.method === "PUT" && url.pathname === "/config") {
      const body = updateConfigSchema.parse((await request.json()) as UpdateConfigRequest);
      return Response.json(this.updateConfig(body));
    }

    if (request.method === "GET" && url.pathname === "/sessions") {
      return Response.json({ sessions: this.listSessions() });
    }

    if (request.method === "POST" && url.pathname === "/sessions") {
      const body = z.object({ id: z.string().min(1), title: z.string().nullable().optional() }).parse(await request.json());
      return Response.json(this.registerSession(body.id, body.title ?? null), { status: 201 });
    }

    if (request.method === "PATCH" && url.pathname.startsWith("/sessions/")) {
      const sessionId = url.pathname.split("/").at(-1) ?? "";
      const body = z.object({ status: z.string().optional(), title: z.string().nullable().optional() }).strict().parse(await request.json());
      return Response.json(this.touchSession(sessionId, body));
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/sessions/")) {
      const sessionId = url.pathname.split("/").at(-1) ?? "";
      this.db.exec("DELETE FROM sessions WHERE id = ?", sessionId);
      return Response.json({ deleted: true, id: sessionId });
    }

    if (request.method === "GET" && url.pathname === "/allowlist") {
      return Response.json({ hosts: this.listAllowlist() });
    }

    if (request.method === "POST" && url.pathname === "/allowlist") {
      const body = z.object({ hostname: z.string().min(1) }).strict().parse(await request.json());
      return Response.json(this.addAllowlistHost(body.hostname), { status: 201 });
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/allowlist/")) {
      const hostname = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      this.db.exec("DELETE FROM host_allowlist WHERE hostname = ?", normalizeHostname(hostname));
      return Response.json({ deleted: true, hostname: normalizeHostname(hostname) });
    }

    if (request.method === "GET" && url.pathname === "/allowlist/check") {
      const hostname = normalizeHostname(url.searchParams.get("hostname") ?? "");
      return Response.json({ allowed: hostname ? this.isAllowedHost(hostname) : false, hostname });
    }

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

    if (request.method === "POST" && url.pathname === "/fork-snapshots") {
      const payload = await request.text();
      const id = crypto.randomUUID();
      this.db.exec("INSERT INTO fork_snapshots (id, payload, created_at) VALUES (?, ?, ?)", id, payload, nowEpoch());
      return Response.json({ id }, { status: 201 });
    }

    if (request.method === "GET" && url.pathname.startsWith("/fork-snapshots/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const row = this.db.one("SELECT payload FROM fork_snapshots WHERE id = ?", id);
      if (!row) {
        return Response.json({ error: `Fork snapshot ${id} not found` }, { status: 404 });
      }
      return new Response(String(row.payload), { headers: { "content-type": "application/json" } });
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/fork-snapshots/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      this.db.exec("DELETE FROM fork_snapshots WHERE id = ?", id);
      return Response.json({ deleted: true, id });
    }

    if (request.method === "GET" && url.pathname === "/models") {
      const refresh = url.searchParams.get("refresh") === "1";
      if (refresh) {
        this.db.exec("DELETE FROM models_cache");
      }
      return Response.json({ models: await this.getModels() });
    }

    if (request.method === "GET" && url.pathname === "/status") {
      return Response.json(this.getStatus());
    }

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

    return new Response("Not Found", { status: 404 });
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_config (
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
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS host_allowlist (
        hostname TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
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
      CREATE TABLE IF NOT EXISTS fork_snapshots (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS models_cache (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cost_input REAL,
        cost_output REAL,
        context_window INTEGER,
        fetched_at INTEGER NOT NULL
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
      this.db.exec("INSERT OR IGNORE INTO app_config (key, value, updated_at) VALUES (?, ?, ?)", key, String(value), now);
    }

    // TTL cleanup: remove fork snapshots older than 1 hour
    const oneHourAgo = now - 3600;
    this.db.exec("DELETE FROM fork_snapshots WHERE created_at < ?", oneHourAgo);
  }

  private readConfig(): AppConfig {
    const rows = this.db.all("SELECT key, value FROM app_config");
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
        "INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        key,
        String(value),
        now,
      );
    }

    return this.readConfig();
  }

  private registerSession(id: string, title: string | null): LegacySessionIndexRecord {
    const now = nowEpoch();
    this.db.exec(
      "INSERT INTO sessions (id, title, status, created_at, updated_at) VALUES (?, ?, 'idle', ?, ?) ON CONFLICT(id) DO NOTHING",
      id,
      title,
      now,
      now,
    );
    return this.getSession(id);
  }

  private touchSession(id: string, patch: { status?: string; title?: string | null }): LegacySessionIndexRecord {
    const current = this.getSession(id);
    const nextTitle = patch.title === undefined ? current.title : patch.title;
    const nextStatus = patch.status ?? current.status;
    const now = nowEpoch();

    this.db.exec("UPDATE sessions SET title = ?, status = ?, updated_at = ? WHERE id = ?", nextTitle, nextStatus, now, id);
    return this.getSession(id);
  }

  private listSessions(): LegacySessionIndexRecord[] {
    return this.db.all("SELECT id, title, status, created_at, updated_at FROM sessions ORDER BY updated_at DESC").map((row) => ({
      createdAt: epochToIso(row.created_at),
      id: String(row.id),
      status: String(row.status),
      title: row.title === null ? null : String(row.title),
      updatedAt: epochToIso(row.updated_at),
    }));
  }

  private getSession(id: string): LegacySessionIndexRecord {
    const row = this.db.one("SELECT id, title, status, created_at, updated_at FROM sessions WHERE id = ?", id);
    if (!row) {
      throw new Error(`Session ${id} not found`);
    }

    return {
      createdAt: epochToIso(row.created_at),
      id: String(row.id),
      status: String(row.status),
      title: row.title === null ? null : String(row.title),
      updatedAt: epochToIso(row.updated_at),
    };
  }

  private addAllowlistHost(hostname: string): AllowlistEntry {
    const normalized = normalizeHostname(hostname);
    if (!normalized) {
      throw new Error("Hostname is required");
    }

    this.db.exec("INSERT OR IGNORE INTO host_allowlist (hostname, created_at) VALUES (?, ?)", normalized, nowEpoch());
    return this.listAllowlist().find((entry) => entry.hostname === normalized)!;
  }

  private listAllowlist(): AllowlistEntry[] {
    return this.db.all("SELECT hostname, created_at FROM host_allowlist ORDER BY hostname ASC").map((row) => ({
      createdAt: epochToIso(row.created_at),
      hostname: String(row.hostname),
    }));
  }

  private isAllowedHost(hostname: string): boolean {
    return !!this.db.one("SELECT hostname FROM host_allowlist WHERE hostname = ?", hostname);
  }

  private createMemoryEntry(input: { content: string; tags: string[]; title: string }): MemoryEntry {
    const id = crypto.randomUUID();
    const now = nowEpoch();
    this.db.exec(
      "INSERT INTO memory_entries (id, title, content, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      input.title,
      input.content,
      JSON.stringify(input.tags),
      now,
      now,
    );
    return this.getMemoryEntry(id);
  }

  private updateMemoryEntry(id: string, input: { content: string; tags: string[]; title: string }): MemoryEntry {
    this.db.exec(
      "UPDATE memory_entries SET title = ?, content = ?, tags_json = ?, updated_at = ? WHERE id = ?",
      input.title,
      input.content,
      JSON.stringify(input.tags),
      nowEpoch(),
      id,
    );
    return this.getMemoryEntry(id);
  }

  private getMemoryEntry(id: string): MemoryEntry {
    const row = this.db.one("SELECT id, title, content, tags_json, created_at, updated_at FROM memory_entries WHERE id = ?", id);
    if (!row) {
      throw new Error(`Memory entry ${id} not found`);
    }

    return {
      content: String(row.content),
      createdAt: epochToIso(row.created_at),
      id: String(row.id),
      tags: JSON.parse(String(row.tags_json)) as string[],
      title: String(row.title),
      updatedAt: epochToIso(row.updated_at),
    };
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

  private async getModels(): Promise<Array<{ id: string; name: string; costInput: number | null; costOutput: number | null; contextWindow: number | null }>> {
    const CACHE_TTL = 86400; // 24 hours
    const now = nowEpoch();
    const cached = this.db.all("SELECT id, name, cost_input, cost_output, context_window FROM models_cache WHERE fetched_at > ?", now - CACHE_TTL);

    // If we have cached entries but some are missing cost data, try to enrich them
    if (cached.length > 0) {
      const needsEnrichment = cached.filter((row) => row.cost_input === null);
      if (needsEnrichment.length > 0) {
        await this.enrichModelCosts(needsEnrichment.map((row) => String(row.id)));
        // Re-read after enrichment
        const enriched = this.db.all("SELECT id, name, cost_input, cost_output, context_window FROM models_cache WHERE fetched_at > ?", now - CACHE_TTL);
        return enriched.map((row) => ({
          id: String(row.id),
          name: String(row.name),
          costInput: row.cost_input === null ? null : Number(row.cost_input),
          costOutput: row.cost_output === null ? null : Number(row.cost_output),
          contextWindow: row.context_window === null ? null : Number(row.context_window),
        }));
      }

      return cached.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        costInput: row.cost_input === null ? null : Number(row.cost_input),
        costOutput: row.cost_output === null ? null : Number(row.cost_output),
        contextWindow: row.context_window === null ? null : Number(row.context_window),
      }));
    }

    try {
      const response = await fetch("https://api.github.com/repos/anomalyco/models.dev/contents/providers/opencode/models", {
        headers: { "Accept": "application/vnd.github.v3+json", "User-Agent": "dodo-agent" },
      });
      if (!response.ok) {
        return [];
      }
      const files = (await response.json()) as Array<{ name: string; download_url?: string }>;
      const tomlFiles = files.filter((f) => f.name.endsWith(".toml") && f.name !== "logo.svg");

      // Fetch TOML content via raw.githubusercontent.com (no API rate limit)
      const details = await Promise.all(
        tomlFiles.map(async (f) => {
          const slug = f.name.replace(".toml", "");
          const id = `anthropic/${slug}`;
          const displayName = slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
          try {
            const tomlRes = await fetch(
              `https://raw.githubusercontent.com/anomalyco/models.dev/dev/providers/opencode/models/${encodeURIComponent(f.name)}`,
              { headers: { "User-Agent": "dodo-agent" } },
            );
            if (!tomlRes.ok) return { id, name: displayName, costInput: null, costOutput: null, contextWindow: null };
            const toml = await tomlRes.text();
            const nameMatch = toml.match(/^name\s*=\s*"([^"]+)"/m);
            const costInputMatch = toml.match(/\[cost\][\s\S]*?input\s*=\s*([\d.]+)/);
            const costOutputMatch = toml.match(/\[cost\][\s\S]*?output\s*=\s*([\d.]+)/);
            const contextMatch = toml.match(/context\s*=\s*([\d_]+)/);
            return {
              id,
              name: nameMatch?.[1] ?? displayName,
              costInput: costInputMatch ? parseFloat(costInputMatch[1]) : null,
              costOutput: costOutputMatch ? parseFloat(costOutputMatch[1]) : null,
              contextWindow: contextMatch ? parseInt(contextMatch[1].replace(/_/g, ""), 10) : null,
            };
          } catch {
            return { id, name: displayName, costInput: null, costOutput: null, contextWindow: null };
          }
        }),
      );

      this.db.exec("DELETE FROM models_cache");
      for (const m of details) {
        this.db.exec(
          "INSERT INTO models_cache (id, name, cost_input, cost_output, context_window, fetched_at) VALUES (?, ?, ?, ?, ?, ?)",
          m.id, m.name, m.costInput, m.costOutput, m.contextWindow, now,
        );
      }

      return details;
    } catch {
      return [];
    }
  }

  private async enrichModelCosts(modelIds: string[]): Promise<void> {
    await Promise.all(
      modelIds.map(async (id) => {
        try {
          const slug = id.replace("anthropic/", "");
          const res = await fetch(
            `https://raw.githubusercontent.com/anomalyco/models.dev/dev/providers/opencode/models/${encodeURIComponent(slug)}.toml`,
            { headers: { "User-Agent": "dodo-agent" } },
          );
          if (!res.ok) return;
          const toml = await res.text();
          const nameMatch = toml.match(/^name\s*=\s*"([^"]+)"/m);
          const costInputMatch = toml.match(/\[cost\][\s\S]*?input\s*=\s*([\d.]+)/);
          const costOutputMatch = toml.match(/\[cost\][\s\S]*?output\s*=\s*([\d.]+)/);
          const contextMatch = toml.match(/context\s*=\s*([\d_]+)/);
          this.db.exec(
            "UPDATE models_cache SET name = ?, cost_input = ?, cost_output = ?, context_window = ? WHERE id = ?",
            nameMatch?.[1] ?? slug,
            costInputMatch ? parseFloat(costInputMatch[1]) : null,
            costOutputMatch ? parseFloat(costOutputMatch[1]) : null,
            contextMatch ? parseInt(contextMatch[1].replace(/_/g, ""), 10) : null,
            id,
          );
        } catch { /* skip failures */ }
      }),
    );
  }

  private getStatus(): { version: string; commit: string; tokenExpiry: string | null; sessionCount: number; modelCount: number } {
    const sessionCount = Number(this.db.one("SELECT COUNT(*) AS count FROM sessions")?.count ?? 0);
    const modelCount = Number(this.db.one("SELECT COUNT(*) AS count FROM models_cache")?.count ?? 0);

    let tokenExpiry: string | null = null;
    try {
      const token = this.env.OPENCODE_GATEWAY_TOKEN;
      if (token) {
        const parts = token.split(".");
        if (parts.length === 3) {
          const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
          if (payload.exp) {
            tokenExpiry = new Date(payload.exp * 1000).toISOString();
          }
        }
      }
    } catch {
      // JWT decode failure — token may not be a JWT
    }

    return {
      version: this.env.DODO_VERSION ?? "dev",
      commit: this.env.DODO_COMMIT ?? "",
      tokenExpiry,
      sessionCount,
      modelCount,
    };
  }

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
    if (!row) {
      throw new Error(`Task ${id} not found`);
    }
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
}
