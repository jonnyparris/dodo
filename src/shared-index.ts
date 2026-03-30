import { z } from "zod";
import { epochToIso, nowEpoch, SqlHelper, type SqlRow } from "./sql-helpers";
import type { AllowlistEntry, Env } from "./types";

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase();
}

/**
 * SharedIndex DO — global singleton (`idFromName("global")`).
 *
 * Owns cross-user state: user allowlist/registry, host allowlist,
 * models cache, and (Phase 2) session shares/permissions.
 */
export class SharedIndex implements DurableObject {
  private readonly db: SqlHelper;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.env = env;
    this.db = new SqlHelper(state.storage.sql);
    this.initializeSchema();
    this.seedAdmin();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      // ─── User allowlist / registry ───

      if (request.method === "GET" && url.pathname === "/users/check") {
        const email = url.searchParams.get("email") ?? "";
        if (!email) return Response.json({ allowed: false }, { status: 403 });
        const user = this.getUser(email);
        if (!user || user.blockedAt) return Response.json({ allowed: false }, { status: 403 });
        // Update last_seen_at
        this.db.exec("UPDATE users SET last_seen_at = ? WHERE email = ?", nowEpoch(), email);
        return Response.json({ allowed: true, role: user.role });
      }

      if (request.method === "GET" && url.pathname === "/users") {
        return Response.json({ users: this.listUsers() });
      }

      if (request.method === "POST" && url.pathname === "/users") {
        const body = z.object({
          email: z.string().email(),
          displayName: z.string().optional(),
          role: z.enum(["admin", "user"]).default("user"),
        }).parse(await request.json());
        return Response.json(this.addUser(body.email, body.displayName ?? null, body.role), { status: 201 });
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/users/")) {
        const email = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        this.db.exec("DELETE FROM users WHERE email = ?", email);
        return Response.json({ deleted: true, email });
      }

      if (request.method === "POST" && url.pathname.match(/^\/users\/[^/]+\/block$/)) {
        const email = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
        this.db.exec("UPDATE users SET blocked_at = ? WHERE email = ?", nowEpoch(), email);
        return Response.json({ blocked: true, email });
      }

      if (request.method === "DELETE" && url.pathname.match(/^\/users\/[^/]+\/block$/)) {
        const email = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
        this.db.exec("UPDATE users SET blocked_at = NULL WHERE email = ?", email);
        return Response.json({ unblocked: true, email });
      }

      // ─── Host allowlist ───

      if (request.method === "GET" && url.pathname === "/allowlist") {
        return Response.json({ hosts: this.listAllowlist() });
      }

      if (request.method === "POST" && url.pathname === "/allowlist") {
        const body = z.object({ hostname: z.string().min(1) }).strict().parse(await request.json());
        return Response.json(this.addAllowlistHost(body.hostname), { status: 201 });
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/allowlist/") && !url.pathname.includes("/check")) {
        const hostname = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        this.db.exec("DELETE FROM host_allowlist WHERE hostname = ?", normalizeHostname(hostname));
        return Response.json({ deleted: true, hostname: normalizeHostname(hostname) });
      }

      if (request.method === "GET" && url.pathname === "/allowlist/check") {
        const hostname = normalizeHostname(url.searchParams.get("hostname") ?? "");
        return Response.json({ allowed: hostname ? this.isAllowedHost(hostname) : false, hostname });
      }

      // ─── Models cache ───

      if (request.method === "GET" && url.pathname === "/models") {
        const refresh = url.searchParams.get("refresh") === "1";
        if (refresh) {
          this.db.exec("DELETE FROM models_cache");
        }
        return Response.json({ models: await this.getModels() });
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected request failure";
      return Response.json({ error: message }, { status: 400 });
    }
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        email TEXT PRIMARY KEY,
        display_name TEXT,
        role TEXT NOT NULL DEFAULT 'user',
        blocked_at INTEGER,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS host_allowlist (
        hostname TEXT PRIMARY KEY,
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

    // Phase 2 tables — created now so schema is stable
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_shares (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        owner_email TEXT NOT NULL,
        permission TEXT NOT NULL DEFAULT 'readonly',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER,
        label TEXT
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_shares_session ON session_shares(session_id)");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_permissions (
        session_id TEXT NOT NULL,
        owner_email TEXT NOT NULL,
        grantee_email TEXT NOT NULL,
        permission TEXT NOT NULL DEFAULT 'readonly',
        granted_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, grantee_email)
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_perms_grantee ON session_permissions(grantee_email)");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_permissions (
        account_owner TEXT NOT NULL,
        grantee_email TEXT NOT NULL,
        permission TEXT NOT NULL,
        granted_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        PRIMARY KEY (account_owner, grantee_email, permission)
      )
    `);
  }

  private seedAdmin(): void {
    const adminEmail = this.env.ADMIN_EMAIL ?? "you@example.com";
    const now = nowEpoch();
    this.db.exec(
      "INSERT OR IGNORE INTO users (email, display_name, role, created_at, last_seen_at) VALUES (?, ?, 'admin', ?, ?)",
      adminEmail,
      "Admin",
      now,
      now,
    );
  }

  // ─── User management ───

  private getUser(email: string): { email: string; displayName: string | null; role: string; blockedAt: number | null; createdAt: string; lastSeenAt: string } | null {
    const row = this.db.one("SELECT email, display_name, role, blocked_at, created_at, last_seen_at FROM users WHERE email = ?", email);
    if (!row) return null;
    return this.mapUserRow(row);
  }

  private listUsers(): Array<{ email: string; displayName: string | null; role: string; blockedAt: number | null; createdAt: string; lastSeenAt: string }> {
    return this.db.all("SELECT email, display_name, role, blocked_at, created_at, last_seen_at FROM users ORDER BY created_at ASC")
      .map((row) => this.mapUserRow(row));
  }

  private addUser(email: string, displayName: string | null, role: string): { email: string; displayName: string | null; role: string; blockedAt: number | null; createdAt: string; lastSeenAt: string } {
    const now = nowEpoch();
    this.db.exec(
      "INSERT INTO users (email, display_name, role, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET display_name = COALESCE(excluded.display_name, users.display_name), role = excluded.role",
      email,
      displayName,
      role,
      now,
      now,
    );
    return this.getUser(email)!;
  }

  private mapUserRow(row: SqlRow): { email: string; displayName: string | null; role: string; blockedAt: number | null; createdAt: string; lastSeenAt: string } {
    return {
      email: String(row.email),
      displayName: row.display_name === null ? null : String(row.display_name),
      role: String(row.role),
      blockedAt: row.blocked_at === null ? null : Number(row.blocked_at),
      createdAt: epochToIso(row.created_at),
      lastSeenAt: epochToIso(row.last_seen_at),
    };
  }

  // ─── Host allowlist ───

  private addAllowlistHost(hostname: string): AllowlistEntry {
    const normalized = normalizeHostname(hostname);
    if (!normalized) throw new Error("Hostname is required");
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

  // ─── Models cache (migrated from AppControl) ───

  private async getModels(): Promise<Array<{ id: string; name: string; costInput: number | null; costOutput: number | null; contextWindow: number | null }>> {
    const CACHE_TTL = 86400;
    const now = nowEpoch();
    const cached = this.db.all("SELECT id, name, cost_input, cost_output, context_window FROM models_cache WHERE fetched_at > ?", now - CACHE_TTL);

    if (cached.length > 0) {
      const needsEnrichment = cached.filter((row) => row.cost_input === null);
      if (needsEnrichment.length > 0) {
        await this.enrichModelCosts(needsEnrichment.map((row) => String(row.id)));
        const enriched = this.db.all("SELECT id, name, cost_input, cost_output, context_window FROM models_cache WHERE fetched_at > ?", now - CACHE_TTL);
        return enriched.map((row) => this.mapModelRow(row));
      }
      return cached.map((row) => this.mapModelRow(row));
    }

    try {
      const response = await fetch("https://api.github.com/repos/anomalyco/models.dev/contents/providers/opencode/models", {
        headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "dodo-agent" },
      });
      if (!response.ok) return [];
      const files = (await response.json()) as Array<{ name: string; download_url?: string }>;
      const tomlFiles = files.filter((f) => f.name.endsWith(".toml") && f.name !== "logo.svg");

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

  private mapModelRow(row: SqlRow): { id: string; name: string; costInput: number | null; costOutput: number | null; contextWindow: number | null } {
    return {
      id: String(row.id),
      name: String(row.name),
      costInput: row.cost_input === null ? null : Number(row.cost_input),
      costOutput: row.cost_output === null ? null : Number(row.cost_output),
      contextWindow: row.context_window === null ? null : Number(row.context_window),
    };
  }
}
