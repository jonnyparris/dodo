import { z } from "zod";
import { hashShareToken } from "./share";
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

      if (request.method === "DELETE" && url.pathname.match(/^\/users\/[^/]+$/)) {
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

      // ─── Browser access ───

      if (request.method === "POST" && url.pathname.match(/^\/users\/[^/]+\/browser$/)) {
        const email = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
        this.db.exec("UPDATE users SET browser_enabled = 1 WHERE email = ?", email);
        return Response.json({ browserEnabled: true, email });
      }

      if (request.method === "DELETE" && url.pathname.match(/^\/users\/[^/]+\/browser$/)) {
        const email = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
        this.db.exec("UPDATE users SET browser_enabled = 0 WHERE email = ?", email);
        return Response.json({ browserEnabled: false, email });
      }

      if (request.method === "GET" && url.pathname.match(/^\/users\/[^/]+\/browser$/)) {
        const email = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
        const row = this.db.one("SELECT browser_enabled FROM users WHERE email = ?", email);
        if (!row) return Response.json({ error: "User not found" }, { status: 404 });
        return Response.json({ browserEnabled: Number(row.browser_enabled) === 1, email });
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

      // ─── Session shares ───

      if (request.method === "POST" && url.pathname === "/shares") {
        const body = z.object({
          sessionId: z.string().min(1),
          ownerEmail: z.string().email(),
          permission: z.enum(["readonly", "readwrite"]).default("readonly"),
          label: z.string().optional(),
          expiresAt: z.string().optional(),
          createdBy: z.string().email(),
        }).parse(await request.json());

        const token = await this.createShare(body);
        return Response.json(token, { status: 201 });
      }

      if (request.method === "GET" && url.pathname === "/shares") {
        const sessionId = url.searchParams.get("sessionId") ?? "";
        if (!sessionId) return Response.json({ error: "sessionId required" }, { status: 400 });
        return Response.json({ shares: this.listShares(sessionId) });
      }

      if (request.method === "DELETE" && url.pathname.match(/^\/shares\/[^/]+$/)) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        this.db.exec("UPDATE session_shares SET revoked_at = ? WHERE id = ?", nowEpoch(), id);
        return Response.json({ revoked: true, id });
      }

      if (request.method === "POST" && url.pathname === "/shares/verify") {
        const body = z.object({ token: z.string().min(1) }).parse(await request.json());
        const result = await this.verifyShareToken(body.token);
        return Response.json(result);
      }

      // ─── Session permissions ───

      if (request.method === "GET" && url.pathname.match(/^\/permissions\/[^/]+\/[^/]+$/)) {
        const parts = url.pathname.split("/");
        const sessionId = decodeURIComponent(parts[2]);
        const email = decodeURIComponent(parts[3]);
        const perm = this.getPermission(sessionId, email);
        if (!perm) return Response.json({ error: "No permission found" }, { status: 404 });
        return Response.json(perm);
      }

      if (request.method === "POST" && url.pathname === "/permissions") {
        const body = z.object({
          sessionId: z.string().min(1),
          ownerEmail: z.string().email(),
          granteeEmail: z.string().email(),
          permission: z.enum(["readonly", "readwrite"]).default("readonly"),
          grantedBy: z.string().email(),
        }).parse(await request.json());
        this.grantPermission(body);
        return Response.json({ granted: true, ...body }, { status: 201 });
      }

      if (request.method === "DELETE" && url.pathname.match(/^\/permissions\/[^/]+\/[^/]+$/)) {
        const parts = url.pathname.split("/");
        const sessionId = decodeURIComponent(parts[2]);
        const email = decodeURIComponent(parts[3]);
        this.db.exec("DELETE FROM session_permissions WHERE session_id = ? AND grantee_email = ?", sessionId, email);
        return Response.json({ revoked: true, sessionId, email });
      }

      if (request.method === "GET" && url.pathname === "/permissions") {
        const sessionId = url.searchParams.get("sessionId");
        const granteeEmail = url.searchParams.get("granteeEmail");
        if (sessionId) {
          return Response.json({ permissions: this.listPermissionsBySession(sessionId) });
        }
        if (granteeEmail) {
          return Response.json({ permissions: this.listPermissionsByGrantee(granteeEmail) });
        }
        return Response.json({ error: "sessionId or granteeEmail required" }, { status: 400 });
      }

      // ─── Account permissions ───

      if (request.method === "POST" && url.pathname === "/account-permissions") {
        const body = z.object({
          accountOwner: z.string().email(),
          granteeEmail: z.string().email(),
          permission: z.string().min(1),
          grantedBy: z.string().email(),
        }).parse(await request.json());
        this.grantAccountPermission(body);
        return Response.json({ granted: true, ...body }, { status: 201 });
      }

      if (request.method === "DELETE" && url.pathname.match(/^\/account-permissions\/[^/]+\/[^/]+$/)) {
        const parts = url.pathname.split("/");
        const owner = decodeURIComponent(parts[2]);
        const email = decodeURIComponent(parts[3]);
        this.db.exec(
          "UPDATE account_permissions SET revoked_at = ? WHERE account_owner = ? AND grantee_email = ?",
          nowEpoch(), owner, email,
        );
        return Response.json({ revoked: true, owner, email });
      }

      if (request.method === "GET" && url.pathname === "/account-permissions") {
        const owner = url.searchParams.get("owner") ?? "";
        if (!owner) return Response.json({ error: "owner required" }, { status: 400 });
        return Response.json({ permissions: this.listAccountPermissions(owner) });
      }

      // ─── Admin stats ───

      if (request.method === "GET" && url.pathname === "/stats") {
        return Response.json(this.getStats());
      }

      if (request.method === "GET" && url.pathname === "/users/detailed") {
        return Response.json({ users: this.listUsersDetailed() });
      }

      // ─── Stat increment (internal, called from Worker) ───

      if (request.method === "POST" && url.pathname === "/stats/increment") {
        const body = (await request.json()) as { stat: string; delta?: number };
        this.incrementStat(body.stat, body.delta ?? 1);
        return Response.json({ ok: true });
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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS aggregate_stats (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0
      )
    `);
    // Seed default stat keys
    this.db.exec("INSERT OR IGNORE INTO aggregate_stats (key, value) VALUES ('sessionCount', 0)");

    // Phase 6: browser_enabled column (migration-safe)
    this.migrateAddBrowserEnabled();
  }

  private migrateAddBrowserEnabled(): void {
    // Check if column already exists by querying table_info
    const cols = this.db.all("PRAGMA table_info(users)");
    const hasBrowserEnabled = cols.some((col) => String(col.name) === "browser_enabled");
    if (!hasBrowserEnabled) {
      this.db.exec("ALTER TABLE users ADD COLUMN browser_enabled INTEGER NOT NULL DEFAULT 0");
    }
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

  private getUser(email: string): { email: string; displayName: string | null; role: string; blockedAt: number | null; browserEnabled: boolean; createdAt: string; lastSeenAt: string } | null {
    const row = this.db.one("SELECT email, display_name, role, blocked_at, browser_enabled, created_at, last_seen_at FROM users WHERE email = ?", email);
    if (!row) return null;
    return this.mapUserRow(row);
  }

  private listUsers(): Array<{ email: string; displayName: string | null; role: string; blockedAt: number | null; browserEnabled: boolean; createdAt: string; lastSeenAt: string }> {
    return this.db.all("SELECT email, display_name, role, blocked_at, browser_enabled, created_at, last_seen_at FROM users ORDER BY created_at ASC")
      .map((row) => this.mapUserRow(row));
  }

  private addUser(email: string, displayName: string | null, role: string): { email: string; displayName: string | null; role: string; blockedAt: number | null; browserEnabled: boolean; createdAt: string; lastSeenAt: string } {
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

  private mapUserRow(row: SqlRow): { email: string; displayName: string | null; role: string; blockedAt: number | null; browserEnabled: boolean; createdAt: string; lastSeenAt: string } {
    return {
      email: String(row.email),
      displayName: row.display_name === null ? null : String(row.display_name),
      role: String(row.role),
      blockedAt: row.blocked_at === null ? null : Number(row.blocked_at),
      browserEnabled: Number(row.browser_enabled) === 1,
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

  // ─── Session shares ───

  private async createShare(input: {
    sessionId: string;
    ownerEmail: string;
    permission: string;
    label?: string;
    expiresAt?: string;
    createdBy: string;
  }): Promise<{ id: string; token: string; permission: string; sessionId: string }> {
    const { generateShareToken } = await import("./share");
    const token = generateShareToken();
    const tokenHash = await hashShareToken(token);
    const now = nowEpoch();
    const expiresAt = input.expiresAt ? Math.floor(new Date(input.expiresAt).getTime() / 1000) : null;

    this.db.exec(
      `INSERT INTO session_shares (id, session_id, owner_email, permission, created_by, created_at, expires_at, label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      tokenHash,
      input.sessionId,
      input.ownerEmail,
      input.permission,
      input.createdBy,
      now,
      expiresAt,
      input.label ?? null,
    );

    return { id: tokenHash, token, permission: input.permission, sessionId: input.sessionId };
  }

  private listShares(sessionId: string): Array<{
    id: string;
    sessionId: string;
    ownerEmail: string;
    permission: string;
    label: string | null;
    createdAt: string;
    expiresAt: string | null;
    revokedAt: string | null;
  }> {
    return this.db
      .all("SELECT id, session_id, owner_email, permission, label, created_at, expires_at, revoked_at FROM session_shares WHERE session_id = ? ORDER BY created_at DESC", sessionId)
      .map((row) => ({
        id: String(row.id),
        sessionId: String(row.session_id),
        ownerEmail: String(row.owner_email),
        permission: String(row.permission),
        label: row.label === null ? null : String(row.label),
        createdAt: epochToIso(row.created_at),
        expiresAt: row.expires_at === null ? null : epochToIso(row.expires_at),
        revokedAt: row.revoked_at === null ? null : epochToIso(row.revoked_at),
      }));
  }

  private async verifyShareToken(token: string): Promise<{
    valid: boolean;
    sessionId?: string;
    permission?: string;
    ownerEmail?: string;
  }> {
    const tokenHash = await hashShareToken(token);
    const row = this.db.one(
      "SELECT session_id, owner_email, permission, expires_at, revoked_at FROM session_shares WHERE id = ?",
      tokenHash,
    );

    if (!row) return { valid: false };
    if (row.revoked_at !== null) return { valid: false };

    // Check expiration
    if (row.expires_at !== null) {
      const expiresAt = Number(row.expires_at);
      if (expiresAt <= nowEpoch()) return { valid: false };
    }

    return {
      valid: true,
      sessionId: String(row.session_id),
      permission: String(row.permission),
      ownerEmail: String(row.owner_email),
    };
  }

  // ─── Session permissions ───

  private getPermission(sessionId: string, email: string): {
    sessionId: string;
    ownerEmail: string;
    granteeEmail: string;
    permission: string;
    grantedBy: string;
    createdAt: string;
  } | null {
    const row = this.db.one(
      "SELECT session_id, owner_email, grantee_email, permission, granted_by, created_at FROM session_permissions WHERE session_id = ? AND grantee_email = ?",
      sessionId, email,
    );
    if (!row) return null;
    return {
      sessionId: String(row.session_id),
      ownerEmail: String(row.owner_email),
      granteeEmail: String(row.grantee_email),
      permission: String(row.permission),
      grantedBy: String(row.granted_by),
      createdAt: epochToIso(row.created_at),
    };
  }

  private grantPermission(input: {
    sessionId: string;
    ownerEmail: string;
    granteeEmail: string;
    permission: string;
    grantedBy: string;
  }): void {
    this.db.exec(
      `INSERT INTO session_permissions (session_id, owner_email, grantee_email, permission, granted_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, grantee_email) DO UPDATE SET permission = excluded.permission, granted_by = excluded.granted_by`,
      input.sessionId,
      input.ownerEmail,
      input.granteeEmail,
      input.permission,
      input.grantedBy,
      nowEpoch(),
    );
  }

  private listPermissionsBySession(sessionId: string): Array<{
    sessionId: string;
    ownerEmail: string;
    granteeEmail: string;
    permission: string;
    grantedBy: string;
    createdAt: string;
  }> {
    return this.db
      .all("SELECT session_id, owner_email, grantee_email, permission, granted_by, created_at FROM session_permissions WHERE session_id = ? ORDER BY created_at ASC", sessionId)
      .map((row) => this.mapPermissionRow(row));
  }

  private listPermissionsByGrantee(granteeEmail: string): Array<{
    sessionId: string;
    ownerEmail: string;
    granteeEmail: string;
    permission: string;
    grantedBy: string;
    createdAt: string;
  }> {
    return this.db
      .all("SELECT session_id, owner_email, grantee_email, permission, granted_by, created_at FROM session_permissions WHERE grantee_email = ? ORDER BY created_at ASC", granteeEmail)
      .map((row) => this.mapPermissionRow(row));
  }

  private mapPermissionRow(row: SqlRow): {
    sessionId: string;
    ownerEmail: string;
    granteeEmail: string;
    permission: string;
    grantedBy: string;
    createdAt: string;
  } {
    return {
      sessionId: String(row.session_id),
      ownerEmail: String(row.owner_email),
      granteeEmail: String(row.grantee_email),
      permission: String(row.permission),
      grantedBy: String(row.granted_by),
      createdAt: epochToIso(row.created_at),
    };
  }

  // ─── Account permissions ───

  private grantAccountPermission(input: {
    accountOwner: string;
    granteeEmail: string;
    permission: string;
    grantedBy: string;
  }): void {
    this.db.exec(
      `INSERT INTO account_permissions (account_owner, grantee_email, permission, granted_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_owner, grantee_email, permission) DO UPDATE SET granted_by = excluded.granted_by, revoked_at = NULL`,
      input.accountOwner,
      input.granteeEmail,
      input.permission,
      input.grantedBy,
      nowEpoch(),
    );
  }

  private listAccountPermissions(owner: string): Array<{
    accountOwner: string;
    granteeEmail: string;
    permission: string;
    grantedBy: string;
    createdAt: string;
    revokedAt: string | null;
  }> {
    return this.db
      .all("SELECT account_owner, grantee_email, permission, granted_by, created_at, revoked_at FROM account_permissions WHERE account_owner = ? ORDER BY created_at ASC", owner)
      .map((row) => ({
        accountOwner: String(row.account_owner),
        granteeEmail: String(row.grantee_email),
        permission: String(row.permission),
        grantedBy: String(row.granted_by),
        createdAt: epochToIso(row.created_at),
        revokedAt: row.revoked_at === null ? null : epochToIso(row.revoked_at),
      }));
  }

  // ─── Admin stats ───

  private getStats(): {
    userCount: number;
    sessionCount: number;
    totalShares: number;
    totalPermissions: number;
  } {
    const userCount = Number(this.db.one("SELECT COUNT(*) AS c FROM users")?.c ?? 0);
    const sessionCount = Number(this.db.one("SELECT value FROM aggregate_stats WHERE key = 'sessionCount'")?.value ?? 0);
    const totalShares = Number(this.db.one("SELECT COUNT(*) AS c FROM session_shares WHERE revoked_at IS NULL")?.c ?? 0);
    const totalPermissions = Number(this.db.one("SELECT COUNT(*) AS c FROM session_permissions")?.c ?? 0);
    return { userCount, sessionCount, totalShares, totalPermissions };
  }

  private listUsersDetailed(): Array<{
    email: string;
    displayName: string | null;
    role: string;
    blockedAt: number | null;
    browserEnabled: boolean;
    createdAt: string;
    lastSeenAt: string;
  }> {
    return this.db
      .all("SELECT email, display_name, role, blocked_at, browser_enabled, created_at, last_seen_at FROM users ORDER BY last_seen_at DESC")
      .map((row) => this.mapUserRow(row));
  }

  private incrementStat(key: string, delta: number): void {
    this.db.exec(
      "INSERT INTO aggregate_stats (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = aggregate_stats.value + ?",
      key,
      delta,
      delta,
    );
  }
}
