import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { resolveAdminEmail } from "./auth";
import { hashShareToken } from "./share";
import { epochToIso, nowEpoch, SqlHelper, type SqlRow } from "./sql-helpers";
import type { AllowlistEntry, Env, SeedRecord } from "./types";

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase();
}

export const FALLBACK_MODELS = [
  { id: "openai/gpt-5.4", name: "GPT-5.4", provider: "OpenAI", costInput: 2, costOutput: 8, contextWindow: 1_000_000 },
  { id: "openai/gpt-4.1", name: "GPT-4.1", provider: "OpenAI", costInput: 2, costOutput: 8, contextWindow: 1_000_000 },
  { id: "openai/gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "OpenAI", costInput: 0.4, costOutput: 1.6, contextWindow: 1_000_000 },
  { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "Anthropic", costInput: 3, costOutput: 15, contextWindow: 200_000 },
  { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6", provider: "Anthropic", costInput: 15, costOutput: 75, contextWindow: 200_000 },
  { id: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "Anthropic", costInput: 0.8, costOutput: 4, contextWindow: 200_000 },
  { id: "openai/o3-mini", name: "o3-mini", provider: "OpenAI", costInput: 1.1, costOutput: 4.4, contextWindow: 200_000 },
  { id: "openai/o4-mini", name: "o4-mini", provider: "OpenAI", costInput: 1.1, costOutput: 4.4, contextWindow: 200_000 },
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "Google", costInput: 1.25, costOutput: 10, contextWindow: 1_000_000 },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "Google", costInput: 0.15, costOutput: 0.6, contextWindow: 1_000_000 },
  { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", provider: "DeepSeek", costInput: 0.27, costOutput: 1.1, contextWindow: 128_000 },
  { id: "deepseek/deepseek-reasoner", name: "DeepSeek Reasoner", provider: "DeepSeek", costInput: 0.55, costOutput: 2.19, contextWindow: 128_000 },
];

/** Workers AI chat/text models — advertised in the model picker so users can
 *  set them as their session default. Routed via AI Gateway's OpenAI-compatible
 *  endpoint. These only work when `activeGateway === "ai-gateway"`. */
export const WORKERS_AI_MODELS = [
  { id: "@cf/moonshotai/kimi-k2.6", name: "Kimi K2.6 (Workers AI)", provider: "Workers AI", costInput: null, costOutput: null, contextWindow: 262_144 },
  { id: "@cf/google/gemma-4-26b-a4b-it", name: "Gemma 4 26B A4B (Workers AI)", provider: "Workers AI", costInput: null, costOutput: null, contextWindow: 256_000 },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout 17B (Workers AI)", provider: "Workers AI", costInput: null, costOutput: null, contextWindow: 131_072 },
  { id: "@cf/qwen/qwen2.5-coder-32b-instruct", name: "Qwen 2.5 Coder 32B (Workers AI)", provider: "Workers AI", costInput: null, costOutput: null, contextWindow: 32_768 },
];

/** Workers AI image-generation models. Not surfaced in the chat model picker —
 *  they're invoked via dedicated endpoints (e.g. POST /session/:id/generate).
 *  Kept here so the catalog is documented in one place. */
export const WORKERS_AI_IMAGE_MODELS = [
  { id: "@cf/black-forest-labs/flux-1-schnell", name: "FLUX.1 Schnell", provider: "Workers AI", kind: "text-to-image" },
];

/** Default model for /generate. Central constant so tests and handlers stay in sync. */
export const FLUX_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
export const FLUX_IMAGE_MEDIA_TYPE = "image/jpeg";
/** FLUX-1-schnell API limit per the model schema (developers.cloudflare.com/workers-ai/models/flux-1-schnell). */
export const FLUX_MAX_PROMPT_LENGTH = 2048;

/** Canonical /generate slash command regex. Shared by the server entry points
 *  (handleMessage/handlePrompt) and the browser client so all paths agree on
 *  what qualifies as an image-generation request. `[\s\S]+` (not `.+`) preserves
 *  multi-line prompts — dot-any-char would clip at the first newline. */
export const GENERATE_SLASH_REGEX = /^\/generate\s+([\s\S]+)$/i;

/** Extract the image prompt from a message if it's a /generate slash command.
 *  Returns null for normal messages. The returned prompt is trimmed; callers
 *  should reject empty strings (whitespace-only user input). */
export function extractGeneratePrompt(content: string): string | null {
  const match = content.match(GENERATE_SLASH_REGEX);
  if (!match) return null;
  const prompt = match[1].trim();
  return prompt.length > 0 ? prompt : null;
}

/** Provider prefixes the opencode gateway can actually route.
 *  The models.dev provider TOMLs often fall back to `anthropic/` for non-Anthropic models
 *  (kimi, glm, qwen, mimo, minimax, etc.), which the gateway then forwards to Anthropic
 *  and Anthropic rejects with 404. We filter those out server-side so the UI never shows
 *  a model that will fail on first prompt. Use Workers AI (ai-gateway) instead. */
const OPENCODE_SUPPORTED_PROVIDER_PREFIXES = new Set(["openai", "anthropic", "google", "deepseek"]);

/** Slug prefixes (after the provider/) that are known to NOT be real Anthropic models.
 *  These slugs slip through as `anthropic/…` because models.dev defaults to `anthropic` when
 *  the TOML has no `[provider].npm`. The gateway forwards to Anthropic and 404s. */
const OPENCODE_BAD_SLUG_PREFIXES = [
  "kimi", "glm", "qwen", "qwen3", "mimo", "minimax", "nemotron", "trinity", "grok-code", "big-pickle",
];

function isRoutableByOpencodeGateway(id: string): boolean {
  const slashIdx = id.indexOf("/");
  if (slashIdx === -1) return false;
  const providerPrefix = id.slice(0, slashIdx);
  const slug = id.slice(slashIdx + 1);
  if (id.startsWith("@cf/")) return false; // Workers AI — ai-gateway only
  if (!OPENCODE_SUPPORTED_PROVIDER_PREFIXES.has(providerPrefix)) return false;
  if (providerPrefix === "anthropic") {
    // Filter models falsely labelled `anthropic/...` because of the models.dev fallback
    return !OPENCODE_BAD_SLUG_PREFIXES.some((bad) => slug.startsWith(bad));
  }
  return true;
}

/**
 * SharedIndex DO — global singleton (`idFromName("global")`).
 *
 * Owns cross-user state: user allowlist/registry, host allowlist,
 * models cache, and (Phase 2) session shares/permissions.
 */
export class SharedIndex extends DurableObject<Env> {
  private readonly db: SqlHelper;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new SqlHelper(ctx.storage.sql);
    ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema();
      this.seedAdmin();
    });
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
        // `gateway` query param filters the list for the active gateway.
        // "opencode" → only providers the opencode gateway can actually route.
        // "ai-gateway" → upstream unified API models + Workers AI @cf/ models.
        // (omitted) → unfiltered (legacy callers).
        const gateway = url.searchParams.get("gateway");
        const models = await this.getModels();
        const filteredBase = gateway === "opencode"
          ? models.filter((m) => isRoutableByOpencodeGateway(m.id))
          : models;
        const ids = new Set(filteredBase.map((m) => m.id));
        // Workers AI models only appear when ai-gateway is the target (or no filter).
        const extras = gateway === "opencode"
          ? []
          : WORKERS_AI_MODELS.filter((m) => !ids.has(m.id));
        return Response.json({ models: [...filteredBase, ...extras] });
      }

      // ─── Session shares ───

      if (request.method === "POST" && url.pathname === "/shares") {
        if (!this.env.COOKIE_SECRET) {
          // Without a server-side secret, share-token hashes are forgeable
          // (audit finding H8). Refuse to mint shares rather than fall back
          // to a hard-coded literal.
          return Response.json({ error: "Sharing not configured (COOKIE_SECRET unset)" }, { status: 500 });
        }
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
        if (!this.env.COOKIE_SECRET) {
          // Same hard-fail rule as share creation — without the secret,
          // verify can't recompute the stored hash safely. (audit finding H8)
          return Response.json({ valid: false, error: "Sharing not configured" }, { status: 500 });
        }
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

      if (request.method === "DELETE" && url.pathname.match(/^\/sessions\/([^/]+)\/cleanup$/)) {
        const sessionId = decodeURIComponent(url.pathname.split("/")[2]);
        this.db.exec("DELETE FROM session_shares WHERE session_id = ?", sessionId);
        this.db.exec("DELETE FROM session_permissions WHERE session_id = ?", sessionId);
        return Response.json({ cleaned: true }, { headers: { "content-type": "application/json" } });
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

      if (request.method === "GET" && url.pathname === "/account-permissions/check") {
        const grantee = url.searchParams.get("grantee") ?? "";
        if (!grantee) return Response.json({ error: "grantee required" }, { status: 400 });
        const result = this.checkAccountCreatePermission(grantee);
        return Response.json(result);
      }

      if (request.method === "GET" && url.pathname === "/account-permissions") {
        const owner = url.searchParams.get("owner") ?? "";
        if (!owner) return Response.json({ error: "owner required" }, { status: 400 });
        return Response.json({ permissions: this.listAccountPermissions(owner) });
      }

      // ─── Client error reporting ───

      if (request.method === "POST" && url.pathname === "/errors") {
        const body = (await request.json()) as {
          message: string;
          source?: string;
          lineno?: number;
          colno?: number;
          stack?: string;
          userAgent?: string;
          email?: string;
          url?: string;
        };
        if (!body.message) return Response.json({ error: "message required" }, { status: 400 });

        // Rate limit: 1000 total errors per hour across the whole instance.
        // The previous email-based key was spoofable via `body.email` —
        // an attacker could burn down a victim's quota and silence their
        // legitimate error reports. The Worker layer already applies a
        // per-IP cap (errorLimiter, 30/hr/IP) so the only remaining job
        // here is a global ceiling that protects R2 / SQLite. Errors
        // older than 7 days are auto-pruned below. (audit follow-up F5)
        const oneHourAgo = nowEpoch() - 3600;
        const countRow = this.db.one(
          "SELECT COUNT(*) AS c FROM client_errors WHERE created_at > ?",
          oneHourAgo,
        );
        if (Number(countRow?.c ?? 0) >= 1000) {
          return Response.json({ error: "Rate limit exceeded (global)" }, { status: 429 });
        }

        // Auto-prune errors older than 7 days
        const sevenDaysAgo = nowEpoch() - 7 * 24 * 3600;
        this.db.exec("DELETE FROM client_errors WHERE created_at < ?", sevenDaysAgo);

        const id = crypto.randomUUID();
        this.db.exec(
          "INSERT INTO client_errors (id, message, source, lineno, colno, stack, user_agent, email, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          id,
          body.message,
          body.source ?? null,
          body.lineno ?? 0,
          body.colno ?? 0,
          body.stack ?? null,
          body.userAgent ?? null,
          body.email ?? null,
          body.url ?? null,
          nowEpoch(),
        );
        return Response.json({ id }, { status: 201 });
      }

      if (request.method === "GET" && url.pathname === "/errors") {
        const hours = Number(url.searchParams.get("hours") ?? 24);
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
        const emailFilter = url.searchParams.get("email");
        const since = nowEpoch() - hours * 3600;

        let query = "SELECT id, message, source, lineno, colno, stack, user_agent, email, url, created_at FROM client_errors WHERE created_at > ?";
        const bindings: unknown[] = [since];
        if (emailFilter) {
          query += " AND email = ?";
          bindings.push(emailFilter);
        }
        query += " ORDER BY created_at DESC LIMIT ?";
        bindings.push(limit);

        const errors = this.db.all(query, ...bindings).map((row) => ({
          id: String(row.id),
          message: String(row.message),
          source: row.source === null ? null : String(row.source),
          lineno: Number(row.lineno),
          colno: Number(row.colno),
          stack: row.stack === null ? null : String(row.stack),
          userAgent: row.user_agent === null ? null : String(row.user_agent),
          email: row.email === null ? null : String(row.email),
          url: row.url === null ? null : String(row.url),
          createdAt: epochToIso(row.created_at),
        }));

        const totalRow = this.db.one(
          "SELECT COUNT(*) AS c FROM client_errors WHERE created_at > ?",
          since,
        );
        return Response.json({ errors, total: Number(totalRow?.c ?? 0) });
      }

      if (request.method === "GET" && url.pathname === "/errors/summary") {
        const since = nowEpoch() - 24 * 3600;
        const groups = this.db
          .all(
            "SELECT message, COUNT(*) AS count, MAX(created_at) AS last_seen, source FROM client_errors WHERE created_at > ? GROUP BY message ORDER BY count DESC",
            since,
          )
          .map((row) => ({
            message: String(row.message),
            count: Number(row.count),
            lastSeen: epochToIso(row.last_seen),
            source: row.source === null ? null : String(row.source),
          }));
        return Response.json({ groups });
      }

      if (request.method === "DELETE" && url.pathname === "/errors") {
        this.db.exec("DELETE FROM client_errors");
        return Response.json({ cleared: true });
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

      // ─── MCP token index (global lookup for user-scoped dodo_* tokens) ───

      if (request.method === "POST" && url.pathname === "/mcp-token-index") {
        const body = (await request.json()) as { token: string; email: string };
        if (!body.token || !body.email) {
          return Response.json({ error: "token and email required" }, { status: 400 });
        }
        this.db.exec(
          "INSERT OR REPLACE INTO mcp_token_index (token, email, created_at) VALUES (?, ?, ?)",
          body.token,
          body.email.trim().toLowerCase(),
          nowEpoch(),
        );
        return Response.json({ ok: true });
      }

      if (request.method === "GET" && url.pathname.startsWith("/mcp-token-index/")) {
        const token = decodeURIComponent(url.pathname.slice("/mcp-token-index/".length));
        if (!token) return Response.json({ email: null });
        const row = this.db.one("SELECT email FROM mcp_token_index WHERE token = ?", token);
        return Response.json({ email: row ? String(row.email) : null });
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/mcp-token-index/")) {
        const token = decodeURIComponent(url.pathname.slice("/mcp-token-index/".length));
        this.db.exec("DELETE FROM mcp_token_index WHERE token = ?", token);
        return Response.json({ ok: true });
      }

      // Bulk delete for a user (called when tokens are revoked in UserControl
      // and when a user is removed from the allowlist).
      if (request.method === "DELETE" && url.pathname.startsWith("/mcp-token-index-by-email/")) {
        const email = decodeURIComponent(url.pathname.slice("/mcp-token-index-by-email/".length)).trim().toLowerCase();
        this.db.exec("DELETE FROM mcp_token_index WHERE email = ?", email);
        return Response.json({ ok: true });
      }

      // ─── Seed session registry (global, admin-owned) ───
      //
      // Maps {repoId, baseBranch} → an admin-owned session that has the repo
      // already cloned. Subsequent runs across all users fork that session
      // instead of cloning fresh. Admin-only, manual-cleanup-only — the
      // registry never auto-evicts.

      if (request.method === "GET" && url.pathname === "/seeds") {
        return Response.json({ seeds: this.listSeeds() });
      }

      // Get-or-create: idempotent. Returns the existing seed if one already
      // exists for {repoId, baseBranch}, otherwise inserts a new row.
      if (request.method === "POST" && url.pathname === "/seeds") {
        const body = z.object({
          repoId: z.string().min(1),
          baseBranch: z.string().min(1),
          sessionId: z.string().min(1),
          ownerEmail: z.string().email(),
          repoUrl: z.string().min(1),
          repoDir: z.string().min(1),
        }).strict().parse(await request.json());

        const existing = this.getSeed(body.repoId, body.baseBranch);
        if (existing) return Response.json({ seed: existing, created: false });

        const now = nowEpoch();
        this.db.exec(
          `INSERT INTO seed_sessions (repo_id, base_branch, session_id, owner_email, repo_url, repo_dir, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          body.repoId,
          body.baseBranch,
          body.sessionId,
          body.ownerEmail,
          body.repoUrl,
          body.repoDir,
          now,
          now,
        );
        return Response.json({ seed: this.getSeed(body.repoId, body.baseBranch), created: true }, { status: 201 });
      }

      if (request.method === "GET" && url.pathname.match(/^\/seeds\/[^/]+\/[^/]+$/)) {
        const parts = url.pathname.split("/");
        const repoId = decodeURIComponent(parts[2]);
        const baseBranch = decodeURIComponent(parts[3]);
        const seed = this.getSeed(repoId, baseBranch);
        if (!seed) return Response.json({ error: "Seed not found" }, { status: 404 });
        return Response.json({ seed });
      }

      if (request.method === "DELETE" && url.pathname.match(/^\/seeds\/[^/]+\/[^/]+$/)) {
        const parts = url.pathname.split("/");
        const repoId = decodeURIComponent(parts[2]);
        const baseBranch = decodeURIComponent(parts[3]);
        const before = this.getSeed(repoId, baseBranch);
        this.db.exec("DELETE FROM seed_sessions WHERE repo_id = ? AND base_branch = ?", repoId, baseBranch);
        return Response.json({ deleted: true, repoId, baseBranch, seed: before });
      }

      // Bump updated_at — used after a refresh (git pull) so the admin UI
      // shows when the seed was last verified current.
      if (request.method === "POST" && url.pathname.match(/^\/seeds\/[^/]+\/[^/]+\/touch$/)) {
        const parts = url.pathname.split("/");
        const repoId = decodeURIComponent(parts[2]);
        const baseBranch = decodeURIComponent(parts[3]);
        this.db.exec(
          "UPDATE seed_sessions SET updated_at = ? WHERE repo_id = ? AND base_branch = ?",
          nowEpoch(),
          repoId,
          baseBranch,
        );
        return Response.json({ touched: true, seed: this.getSeed(repoId, baseBranch) });
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

    // Client error reporting table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS client_errors (
        id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        source TEXT,
        lineno INTEGER,
        colno INTEGER,
        stack TEXT,
        user_agent TEXT,
        email TEXT,
        url TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_errors_created ON client_errors(created_at)");

    // Global token → email pointer for user-scoped MCP tokens. The full
    // token record (with label, timestamps) lives in the user's UserControl
    // DO; this table only exists so /mcp can resolve a bearer token to an
    // email without knowing which user to ask. Wiped per-user when tokens
    // are revoked or the user is deleted.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_token_index (
        token TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_mcp_token_index_email ON mcp_token_index(email)");

    // Global seed-session registry. Maps a known repo + base branch to an
    // admin-owned session that already has the repo cloned. Other users
    // fork that session instead of cloning from scratch, saving tokens and
    // wall time. Manual-cleanup-only — never auto-evicted.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seed_sessions (
        repo_id TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        session_id TEXT NOT NULL,
        owner_email TEXT NOT NULL,
        repo_url TEXT NOT NULL,
        repo_dir TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (repo_id, base_branch)
      )
    `);

    // Phase 6: browser_enabled column (migration-safe)
    this.migrateAddBrowserEnabled();
  }

  // ─── Seed session registry ───

  private getSeed(repoId: string, baseBranch: string): SeedRecord | null {
    const row = this.db.one(
      "SELECT repo_id, base_branch, session_id, owner_email, repo_url, repo_dir, created_at, updated_at FROM seed_sessions WHERE repo_id = ? AND base_branch = ?",
      repoId,
      baseBranch,
    );
    return row ? this.mapSeedRow(row) : null;
  }

  private listSeeds(): SeedRecord[] {
    return this.db
      .all("SELECT repo_id, base_branch, session_id, owner_email, repo_url, repo_dir, created_at, updated_at FROM seed_sessions ORDER BY repo_id ASC, base_branch ASC")
      .map((row) => this.mapSeedRow(row));
  }

  private mapSeedRow(row: SqlRow): SeedRecord {
    return {
      repoId: String(row.repo_id),
      baseBranch: String(row.base_branch),
      sessionId: String(row.session_id),
      ownerEmail: String(row.owner_email),
      repoUrl: String(row.repo_url),
      repoDir: String(row.repo_dir),
      createdAt: epochToIso(row.created_at),
      updatedAt: epochToIso(row.updated_at),
    };
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
    const adminEmail = resolveAdminEmail(this.env);
    if (!adminEmail) return; // No admin configured — skip seeding
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
          const displayName = slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
          try {
            const tomlRes = await fetch(
              `https://raw.githubusercontent.com/anomalyco/models.dev/dev/providers/opencode/models/${encodeURIComponent(f.name)}`,
              { headers: { "User-Agent": "dodo-agent" } },
            );
            if (!tomlRes.ok) return { id: slug, name: displayName, costInput: null, costOutput: null, contextWindow: null };
            const toml = await tomlRes.text();
            // Derive model ID from the provider npm package in the TOML
            const providerNpm = toml.match(/\[provider\][\s\S]*?npm\s*=\s*"@ai-sdk\/([^"]+)"/)?.[1];
            const providerPrefix = providerNpm ?? "anthropic"; // fallback for legacy files
            const id = `${providerPrefix}/${slug}`;
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
            return { id: slug, name: displayName, costInput: null, costOutput: null, contextWindow: null };
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
      return FALLBACK_MODELS;
    }
  }

  private async enrichModelCosts(modelIds: string[]): Promise<void> {
    await Promise.all(
      modelIds.map(async (id) => {
        try {
          // Extract slug from "provider/slug" format
          const slug = id.includes("/") ? id.split("/").slice(1).join("/") : id;
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
    const tokenHash = await hashShareToken(token, this.env.COOKIE_SECRET);
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
    const tokenHash = await hashShareToken(token, this.env.COOKIE_SECRET);
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

  private checkAccountCreatePermission(granteeEmail: string): { hasCreate: boolean; accountOwner: string | null } {
    const row = this.db.one(
      "SELECT account_owner FROM account_permissions WHERE grantee_email = ? AND permission = 'create' AND revoked_at IS NULL",
      granteeEmail,
    );
    if (!row) return { hasCreate: false, accountOwner: null };
    return { hasCreate: true, accountOwner: String(row.account_owner) };
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
