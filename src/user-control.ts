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
import { advanceStep, getInitialState, type OnboardingState } from "./onboarding";
import { epochToIso, nowEpoch, SqlHelper, type SqlRow } from "./sql-helpers";
import type { AppConfig, Env, FailureSnapshotRecord, MemoryEntry, SessionIndexRecord, UpdateConfigRequest, WorkerRunRecord, WorkerRunStatus } from "./types";

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

const workerRunCreateSchema = z.object({
  sessionId: z.string().min(1),
  parentSessionId: z.string().min(1).nullable().optional(),
  repoId: z.string().min(1),
  repoUrl: z.string().url(),
  repoDir: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1).default("main"),
  strategy: z.enum(["deterministic", "agent"]),
  title: z.string().min(1),
  commitMessage: z.string().min(1).nullable().optional(),
  expectedFiles: z.array(z.string()).default([]),
  status: z.enum(["session_created", "repo_ready", "branch_created", "edit_applied", "commit_created", "prompt_running", "push_verified", "done", "failed"]).default("session_created"),
}).strict();

const workerRunUpdateSchema = z.object({
  status: z.enum(["session_created", "repo_ready", "branch_created", "edit_applied", "commit_created", "prompt_running", "push_verified", "done", "failed"]).optional(),
  lastError: z.string().nullable().optional(),
  failureSnapshotId: z.string().nullable().optional(),
  verification: z.record(z.string(), z.unknown()).nullable().optional(),
}).strict();

const failureSnapshotCreateSchema = z.object({
  runId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
}).strict();

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

    // Internal secret endpoint — the DO ID is the identity proof.
    // If x-owner-email is provided, validate it matches. Otherwise, use the
    // stored owner email (enables DO-to-DO calls that only have the DO ID).
    if (url.pathname.startsWith("/internal/secret/")) {
      const stored = this.getOwnerEmail();
      if (headerEmail && stored && stored !== headerEmail) {
        return Response.json({ error: "Owner email mismatch" }, { status: 403 });
      }
      if (!headerEmail && !stored) {
        return Response.json({ error: "Owner email not established" }, { status: 403 });
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

      if (request.method === "DELETE" && url.pathname.match(/^\/sessions\/[^/]+$/) && !url.pathname.includes("/mcp-overrides") && !url.pathname.includes("/soft-delete") && !url.pathname.includes("/restore")) {
        const sessionId = url.pathname.split("/").at(-1) ?? "";
        this.db.exec("DELETE FROM sessions WHERE id = ?", sessionId);
        return Response.json({ deleted: true, sessionId });
      }

      // Soft-delete: mark session as deleted with a TTL for recovery
      if (request.method === "POST" && url.pathname.match(/^\/sessions\/[^/]+\/soft-delete$/)) {
        const sessionId = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
        const row = this.db.one("SELECT id FROM sessions WHERE id = ?", sessionId);
        if (!row) return Response.json({ error: `Session '${sessionId}' not found` }, { status: 404 });
        const deleteExpiry = nowEpoch() + 300; // 5 minutes
        this.db.exec("UPDATE sessions SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?", deleteExpiry, nowEpoch(), sessionId);
        return Response.json({ deleted: true, sessionId, recoverable: true, recoverableUntil: epochToIso(deleteExpiry) });
      }

      // Restore a soft-deleted session
      if (request.method === "POST" && url.pathname.match(/^\/sessions\/[^/]+\/restore$/)) {
        const sessionId = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
        const row = this.db.one("SELECT id, status, deleted_at FROM sessions WHERE id = ?", sessionId);
        if (!row) return Response.json({ error: `Session '${sessionId}' not found. It may have been permanently deleted.` }, { status: 404 });
        if (String(row.status) !== "deleted") return Response.json({ error: `Session '${sessionId}' is not deleted.` }, { status: 400 });
        const expiry = Number(row.deleted_at ?? 0);
        if (expiry > 0 && nowEpoch() > expiry) {
          // Past recovery window — permanently delete
          this.db.exec("DELETE FROM sessions WHERE id = ?", sessionId);
          return Response.json({ error: `Recovery window expired. Session '${sessionId}' has been permanently deleted.` }, { status: 410 });
        }
        this.db.exec("UPDATE sessions SET status = 'idle', deleted_at = NULL, updated_at = ? WHERE id = ?", nowEpoch(), sessionId);
        return Response.json(this.getSession(sessionId));
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

      if (request.method === "GET" && url.pathname.match(/^\/tasks\/[^/]+\/check$/)) {
        const id = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
        const row = this.db.one("SELECT id FROM tasks WHERE id = ?", id);
        if (!row) return Response.json({ error: "Task not found" }, { status: 404 });
        return Response.json({ found: true });
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/tasks/")) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        const row = this.db.one("SELECT id FROM tasks WHERE id = ?", id);
        if (!row) return Response.json({ error: `Task '${id}' not found. Run list tasks to see available tasks.` }, { status: 404 });
        this.db.exec("DELETE FROM tasks WHERE id = ?", id);
        return Response.json({ deleted: true, id });
      }

      // ─── Worker runs / orchestration state ───

      if (request.method === "GET" && url.pathname === "/worker-runs") {
        const sessionId = url.searchParams.get("sessionId") ?? undefined;
        return Response.json({ runs: this.listWorkerRuns(sessionId) });
      }

      if (request.method === "POST" && url.pathname === "/worker-runs") {
        const body = workerRunCreateSchema.parse(await request.json());
        return Response.json(this.createWorkerRun(body), { status: 201 });
      }

      if (request.method === "GET" && url.pathname.match(/^\/worker-runs\/[^/]+$/)) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        return Response.json(this.getWorkerRun(id));
      }

      if (request.method === "PUT" && url.pathname.match(/^\/worker-runs\/[^/]+$/)) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        const body = workerRunUpdateSchema.parse(await request.json());
        return Response.json(this.updateWorkerRun(id, body));
      }

      if (request.method === "POST" && url.pathname === "/failure-snapshots") {
        const body = failureSnapshotCreateSchema.parse(await request.json());
        return Response.json(this.createFailureSnapshot(body.runId, body.payload), { status: 201 });
      }

      if (request.method === "GET" && url.pathname.match(/^\/failure-snapshots\/[^/]+$/)) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        return Response.json(this.getFailureSnapshot(id));
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
        return Response.json({ configs: this.listMcpConfigsSafe() });
      }

      if (request.method === "POST" && url.pathname === "/mcp-configs") {
        const body = mcpConfigCreateSchema.parse(await request.json());
        const ownerEmail = request.headers.get("x-owner-email") ?? "";
        const config = await this.createMcpConfigEncrypted(body, ownerEmail);
        return Response.json(config, { status: 201 });
      }

      if (request.method === "PUT" && url.pathname.match(/^\/mcp-configs\/[^/]+$/) && !url.pathname.includes("/test")) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        const body = mcpConfigUpdateSchema.parse(await request.json());
        const ownerEmail = request.headers.get("x-owner-email") ?? "";
        const config = await this.updateMcpConfigEncrypted(id, body, ownerEmail);
        return Response.json(config);
      }

      if (request.method === "DELETE" && url.pathname.match(/^\/mcp-configs\/[^/]+$/)) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        this.deleteMcpConfigSecrets(id);
        this.db.exec("DELETE FROM mcp_configs WHERE id = ?", id);
        return Response.json({ deleted: true, id });
      }

      if (request.method === "POST" && url.pathname.match(/^\/mcp-configs\/[^/]+\/test$/)) {
        const id = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
        const row = this.db.one("SELECT id, name, type, url, headers_json, enabled FROM mcp_configs WHERE id = ?", id);
        if (!row) return Response.json({ error: `MCP config ${id} not found` }, { status: 404 });
        const ownerEmail = request.headers.get("x-owner-email") ?? "";
        const config = await this.resolveMcpConfigHeaders(this.mapMcpConfigRow(row), ownerEmail);
        const gatekeeper = new HttpMcpGatekeeper(config);
        const result = await gatekeeper.testConnection();
        return Response.json(result);
      }

      // ─── Session MCP Overrides ───

      if (request.method === "GET" && url.pathname.match(/^\/sessions\/[^/]+\/mcp-overrides$/)) {
        const sessionId = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
        return Response.json({ overrides: this.listMcpOverrides(sessionId) });
      }

      if (request.method === "POST" && url.pathname.match(/^\/sessions\/[^/]+\/mcp-overrides$/)) {
        const sessionId = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
        const body = z.object({
          mcpConfigId: z.string().min(1),
          enabled: z.boolean(),
        }).parse(await request.json());
        this.setMcpOverride(sessionId, body.mcpConfigId, body.enabled);
        return Response.json({ sessionId, mcpConfigId: body.mcpConfigId, enabled: body.enabled }, { status: 201 });
      }

      if (request.method === "DELETE" && url.pathname.match(/^\/sessions\/[^/]+\/mcp-overrides\/[^/]+$/)) {
        const parts = url.pathname.split("/");
        const mcpConfigId = decodeURIComponent(parts.at(-1) ?? "");
        const sessionId = decodeURIComponent(parts.at(-3) ?? "");
        this.db.exec("DELETE FROM session_mcp_overrides WHERE session_id = ? AND mcp_config_id = ?", sessionId, mcpConfigId);
        return Response.json({ deleted: true, sessionId, mcpConfigId });
      }

      if (request.method === "GET" && url.pathname.match(/^\/sessions\/[^/]+\/effective-mcp-configs$/)) {
        const sessionId = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
        return Response.json({ configs: this.getEffectiveMcpConfigs(sessionId) });
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

      if (request.method === "POST" && url.pathname === "/passkey/rotate-server-key") {
        const body = z.object({ passkey: z.string().min(1) }).parse(await request.json());
        const ownerEmail = request.headers.get("x-owner-email") ?? "";
        await this.rotateServerKey(body.passkey, ownerEmail);
        return Response.json({ rotated: true });
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
        const ownerEmail = request.headers.get("x-owner-email") || this.getOwnerEmail() || "";
        const value = await this.getSecret(key, ownerEmail);
        if (value === null) return Response.json({ error: "Secret not found" }, { status: 404 });
        return Response.json({ value });
      }

      // ─── Onboarding ───

      if (request.method === "GET" && url.pathname === "/onboarding") {
        return Response.json(this.getOnboardingState());
      }

      if (request.method === "POST" && url.pathname === "/onboarding/advance") {
        const body = z.object({
          step: z.string().min(1),
          skip: z.boolean().optional(),
          data: z.record(z.string(), z.unknown()).optional(),
        }).parse(await request.json());
        const hasKeyEnvelope = !!this.db.one("SELECT id FROM key_envelope WHERE id = 'default'");
        const current = this.getOnboardingState();
        const next = advanceStep(current, body.step as OnboardingState["currentStep"], body.skip ?? false, hasKeyEnvelope);
        this.saveOnboardingState(next);
        return Response.json(next);
      }

      if (request.method === "POST" && url.pathname === "/onboarding/reset") {
        const initial = getInitialState();
        this.saveOnboardingState(initial);
        return Response.json(initial);
      }

      if (request.method === "GET" && url.pathname === "/onboarding/status") {
        const state = this.getOnboardingState();
        return Response.json({ completed: state.currentStep === "complete", step: state.currentStep });
      }

      // ─── Browser Rendering Config ───

      if (request.method === "GET" && url.pathname === "/browser-config") {
        const cfAccountId = this.readUserConfigKey("cf_account_id");
        const hasApiToken = !!this.db.one("SELECT key FROM encrypted_secrets WHERE key = 'mcp:browser-rendering:Authorization'");
        const mcpConfig = this.db.one("SELECT id, enabled FROM mcp_configs WHERE id = 'browser-rendering'");
        return Response.json({
          cfAccountId: cfAccountId ?? null,
          hasApiToken,
          mcpConfigured: !!mcpConfig,
          mcpEnabled: mcpConfig ? Boolean(Number(mcpConfig.enabled)) : false,
        });
      }

      if (request.method === "PUT" && url.pathname === "/browser-config") {
        const body = z.object({
          cfAccountId: z.string().min(1),
          cfApiToken: z.string().min(1),
          labMode: z.boolean().default(false),
        }).parse(await request.json());
        const ownerEmail = request.headers.get("x-owner-email") ?? "";

        // Store account ID in user_config
        const now = nowEpoch();
        this.db.exec(
          "INSERT INTO user_config (key, value, updated_at) VALUES ('cf_account_id', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
          body.cfAccountId, now,
        );

        // Auto-create or update the browser-rendering MCP config
        // headers_json must list the header names so connectMcpServers resolves them from encrypted_secrets
        const mcpUrl = "https://browser.mcp.cloudflare.com/mcp";
        const headerKeys = JSON.stringify(["Authorization", "cf-account-id"]);
        const existing = this.db.one("SELECT id FROM mcp_configs WHERE id = 'browser-rendering'");
        if (existing) {
          this.db.exec(
            "UPDATE mcp_configs SET url = ?, headers_json = ?, enabled = 1, updated_at = ? WHERE id = 'browser-rendering'",
            mcpUrl, headerKeys, now,
          );
        } else {
          this.db.exec(
            "INSERT INTO mcp_configs (id, name, type, url, headers_json, enabled, created_at, updated_at) VALUES ('browser-rendering', 'Browser Rendering', 'http', ?, ?, 1, ?, ?)",
            mcpUrl, headerKeys, now, now,
          );
        }

        // Store the auth header as an encrypted MCP secret
        await this.setSecret("mcp:browser-rendering:Authorization", `Bearer ${body.cfApiToken}`, ownerEmail);

        // Store account ID header for the MCP server
        await this.setSecret("mcp:browser-rendering:cf-account-id", body.cfAccountId, ownerEmail);

        return Response.json({ configured: true });
      }

      if (request.method === "DELETE" && url.pathname === "/browser-config") {
        const now = nowEpoch();
        // Remove MCP config
        this.db.exec("DELETE FROM mcp_configs WHERE id = 'browser-rendering'");
        // Remove secrets
        this.db.exec("DELETE FROM encrypted_secrets WHERE key IN ('mcp:browser-rendering:Authorization', 'mcp:browser-rendering:cf-account-id')");
        // Remove config key
        this.db.exec("DELETE FROM user_config WHERE key = 'cf_account_id'");
        return Response.json({ deleted: true });
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
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      )
    `);

    // Add deleted_at column if missing (migration for existing DBs)
    try {
      this.db.exec("ALTER TABLE sessions ADD COLUMN deleted_at INTEGER");
    } catch { /* column already exists */ }

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
      CREATE TABLE IF NOT EXISTS worker_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_session_id TEXT,
        repo_id TEXT NOT NULL,
        repo_url TEXT NOT NULL,
        repo_dir TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        strategy TEXT NOT NULL,
        title TEXT NOT NULL,
        commit_message TEXT,
        expected_files_json TEXT NOT NULL DEFAULT '[]',
        verification_json TEXT,
        last_error TEXT,
        failure_snapshot_id TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS failure_snapshots (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_mcp_overrides (
        session_id TEXT NOT NULL,
        mcp_config_id TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        PRIMARY KEY (session_id, mcp_config_id)
      )
    `);

    // TTL cleanup: remove fork snapshots older than 1 hour
    const oneHourAgo = nowEpoch() - 3600;
    this.db.exec("DELETE FROM fork_snapshots WHERE created_at < ?", oneHourAgo);
    // Keep failure snapshots for 7 days
    this.db.exec("DELETE FROM failure_snapshots WHERE created_at < ?", nowEpoch() - 604800);
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

  private readUserConfigKey(key: string): string | null {
    const row = this.db.one("SELECT value FROM user_config WHERE key = ?", key);
    return row ? String(row.value) : null;
  }

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
    // Purge expired soft-deleted sessions
    this.db.exec("DELETE FROM sessions WHERE status = 'deleted' AND deleted_at IS NOT NULL AND deleted_at < ?", nowEpoch());
    // Exclude soft-deleted sessions from listing
    return this.db.all("SELECT id, title, status, owner_email, created_by, created_at, updated_at FROM sessions WHERE status != 'deleted' ORDER BY updated_at DESC")
      .map((row) => this.mapSessionRow(row));
  }

  private getSession(id: string): SessionIndexRecord {
    const row = this.db.one("SELECT id, title, status, owner_email, created_by, created_at, updated_at FROM sessions WHERE id = ?", id);
    if (!row) throw new Error(`Session ${id} not found`);
    return this.mapSessionRow(row);
  }

  private mapSessionRow(row: SqlRow): SessionIndexRecord {
    const rawTitle = row.title === null ? null : String(row.title);
    return {
      createdAt: epochToIso(row.created_at),
      id: String(row.id),
      ownerEmail: String(row.owner_email),
      createdBy: String(row.created_by),
      status: String(row.status),
      title: rawTitle,
      updatedAt: epochToIso(row.updated_at),
    };
  }

  // ─── Worker runs / failure snapshots ───

  private createWorkerRun(input: z.infer<typeof workerRunCreateSchema>): WorkerRunRecord {
    const id = crypto.randomUUID();
    const now = nowEpoch();
    this.db.exec(
      `INSERT INTO worker_runs (
        id, session_id, parent_session_id, repo_id, repo_url, repo_dir, branch, base_branch,
        strategy, title, commit_message, expected_files_json, verification_json, last_error,
        failure_snapshot_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.sessionId,
      input.parentSessionId ?? null,
      input.repoId,
      input.repoUrl,
      input.repoDir,
      input.branch,
      input.baseBranch,
      input.strategy,
      input.title,
      input.commitMessage ?? null,
      JSON.stringify(input.expectedFiles),
      null,
      null,
      null,
      input.status,
      now,
      now,
    );
    return this.getWorkerRun(id);
  }

  private updateWorkerRun(id: string, patch: z.infer<typeof workerRunUpdateSchema>): WorkerRunRecord {
    const current = this.getWorkerRun(id);
    this.db.exec(
      `UPDATE worker_runs
       SET status = ?,
           last_error = ?,
           failure_snapshot_id = ?,
           verification_json = ?,
           updated_at = ?
       WHERE id = ?`,
      patch.status ?? current.status,
      patch.lastError === undefined ? current.lastError : patch.lastError,
      patch.failureSnapshotId === undefined ? current.failureSnapshotId : patch.failureSnapshotId,
      patch.verification === undefined
        ? (current.verification === null ? null : JSON.stringify(current.verification))
        : (patch.verification === null ? null : JSON.stringify(patch.verification)),
      nowEpoch(),
      id,
    );
    return this.getWorkerRun(id);
  }

  private listWorkerRuns(sessionId?: string): WorkerRunRecord[] {
    const rows = sessionId
      ? this.db.all("SELECT * FROM worker_runs WHERE session_id = ? OR parent_session_id = ? ORDER BY created_at DESC", sessionId, sessionId)
      : this.db.all("SELECT * FROM worker_runs ORDER BY created_at DESC");
    return rows.map((row) => this.mapWorkerRunRow(row));
  }

  private getWorkerRun(id: string): WorkerRunRecord {
    const row = this.db.one("SELECT * FROM worker_runs WHERE id = ?", id);
    if (!row) throw new Error(`Worker run ${id} not found`);
    return this.mapWorkerRunRow(row);
  }

  private mapWorkerRunRow(row: SqlRow): WorkerRunRecord {
    return {
      baseBranch: String(row.base_branch),
      branch: String(row.branch),
      commitMessage: row.commit_message === null ? null : String(row.commit_message),
      createdAt: epochToIso(row.created_at),
      expectedFiles: JSON.parse(String(row.expected_files_json ?? "[]")) as string[],
      failureSnapshotId: row.failure_snapshot_id === null ? null : String(row.failure_snapshot_id),
      id: String(row.id),
      lastError: row.last_error === null ? null : String(row.last_error),
      parentSessionId: row.parent_session_id === null ? null : String(row.parent_session_id),
      repoDir: String(row.repo_dir),
      repoId: String(row.repo_id),
      repoUrl: String(row.repo_url),
      sessionId: String(row.session_id),
      status: String(row.status) as WorkerRunStatus,
      strategy: String(row.strategy) as WorkerRunRecord["strategy"],
      title: String(row.title),
      updatedAt: epochToIso(row.updated_at),
      verification: row.verification_json === null ? null : JSON.parse(String(row.verification_json)) as Record<string, unknown>,
    };
  }

  private createFailureSnapshot(runId: string, payload: Record<string, unknown>): FailureSnapshotRecord {
    const id = crypto.randomUUID();
    const now = nowEpoch();
    this.db.exec(
      "INSERT INTO failure_snapshots (id, run_id, payload, created_at) VALUES (?, ?, ?, ?)",
      id,
      runId,
      JSON.stringify(payload),
      now,
    );
    return this.getFailureSnapshot(id);
  }

  private getFailureSnapshot(id: string): FailureSnapshotRecord {
    const row = this.db.one("SELECT id, run_id, payload, created_at FROM failure_snapshots WHERE id = ?", id);
    if (!row) throw new Error(`Failure snapshot ${id} not found`);
    return {
      createdAt: epochToIso(row.created_at),
      id: String(row.id),
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
      runId: String(row.run_id),
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
      "SELECT id, title, content, tags_json, created_at, updated_at FROM memory_entries WHERE lower(title) LIKE ? ESCAPE '\\' OR lower(content) LIKE ? ESCAPE '\\' OR lower(tags_json) LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 25",
      pattern,
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

  /**
   * Create an MCP config, storing headers as encrypted secrets.
   * The mcp_configs table stores only header key names (not values).
   */
  private async createMcpConfigEncrypted(input: { name: string; type: string; url?: string; headers?: Record<string, string>; enabled: boolean }, ownerEmail: string): Promise<McpGatekeeperConfig & { headerKeys?: string[] }> {
    const id = crypto.randomUUID();
    const now = nowEpoch();
    const headerKeys = input.headers ? Object.keys(input.headers) : [];

    this.db.exec(
      "INSERT INTO mcp_configs (id, name, type, url, headers_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id, input.name, input.type, input.url ?? null, headerKeys.length > 0 ? JSON.stringify(headerKeys) : null, input.enabled ? 1 : 0, now, now,
    );

    // Store each header value as an encrypted secret
    if (input.headers && ownerEmail && this.hasKeyEnvelope()) {
      for (const [headerName, headerValue] of Object.entries(input.headers)) {
        await this.setSecret(`mcp:${id}:${headerName}`, headerValue, ownerEmail);
      }
    }

    const config = this.getMcpConfigSafe(id);
    return { ...config, headerKeys };
  }

  /**
   * Update an MCP config, replacing encrypted header secrets if new headers provided.
   */
  private async updateMcpConfigEncrypted(id: string, patch: { name?: string; type?: string; url?: string; headers?: Record<string, string>; enabled?: boolean }, ownerEmail: string): Promise<McpGatekeeperConfig & { headerKeys?: string[] }> {
    const current = this.getMcpConfigSafe(id);
    const now = nowEpoch();

    let headerKeys: string[];
    if (patch.headers) {
      // Delete old header secrets
      this.deleteMcpConfigSecrets(id);
      headerKeys = Object.keys(patch.headers);
      // Store new header secrets
      if (ownerEmail && this.hasKeyEnvelope()) {
        for (const [headerName, headerValue] of Object.entries(patch.headers)) {
          await this.setSecret(`mcp:${id}:${headerName}`, headerValue, ownerEmail);
        }
      }
    } else {
      headerKeys = current.headerKeys ?? [];
    }

    this.db.exec(
      "UPDATE mcp_configs SET name = ?, type = ?, url = ?, headers_json = ?, enabled = ?, updated_at = ? WHERE id = ?",
      patch.name ?? current.name,
      patch.type ?? current.type,
      patch.url ?? current.url ?? null,
      headerKeys.length > 0 ? JSON.stringify(headerKeys) : null,
      (patch.enabled !== undefined ? patch.enabled : current.enabled) ? 1 : 0,
      now,
      id,
    );

    const updated = this.getMcpConfigSafe(id);
    return { ...updated, headerKeys };
  }

  /** Delete all encrypted secrets associated with an MCP config. */
  private deleteMcpConfigSecrets(configId: string): void {
    const rows = this.db.all("SELECT key FROM encrypted_secrets WHERE key LIKE ?", `mcp:${configId}:%`);
    for (const row of rows) {
      this.db.exec("DELETE FROM encrypted_secrets WHERE key = ?", String(row.key));
    }
  }

  /** Resolve encrypted headers for actual MCP connection. */
  private async resolveMcpConfigHeaders(config: McpGatekeeperConfig, ownerEmail: string): Promise<McpGatekeeperConfig> {
    if (!config.headerKeys || config.headerKeys.length === 0) return config;
    if (!ownerEmail || !this.hasKeyEnvelope()) return config;

    const headers: Record<string, string> = {};
    for (const headerName of config.headerKeys) {
      const value = await this.getSecret(`mcp:${config.id}:${headerName}`, ownerEmail);
      if (value !== null) {
        headers[headerName] = value;
      }
    }

    return { ...config, headers: Object.keys(headers).length > 0 ? headers : undefined };
  }

  private getMcpConfigSafe(id: string): McpGatekeeperConfig & { headerKeys?: string[] } {
    const row = this.db.one("SELECT id, name, type, url, headers_json, enabled FROM mcp_configs WHERE id = ?", id);
    if (!row) throw new Error(`MCP config ${id} not found`);
    return this.mapMcpConfigRowSafe(row);
  }

  /**
   * List MCP configs for display. Returns header key names but not values.
   */
  private listMcpConfigsSafe(): Array<McpGatekeeperConfig & { headerKeys?: string[] }> {
    return this.db.all("SELECT id, name, type, url, headers_json, enabled FROM mcp_configs ORDER BY name ASC")
      .map((row) => this.mapMcpConfigRowSafe(row));
  }

  private hasKeyEnvelope(): boolean {
    return !!this.db.one("SELECT id FROM key_envelope WHERE id = 'default'");
  }

  /**
   * Map a row to safe config (headers_json now stores key names array, not values).
   */
  private mapMcpConfigRowSafe(row: SqlRow): McpGatekeeperConfig & { headerKeys?: string[] } {
    const headersJsonStr = row.headers_json ? String(row.headers_json) : null;
    let headerKeys: string[] | undefined;

    if (headersJsonStr) {
      try {
        const parsed = JSON.parse(headersJsonStr);
        if (Array.isArray(parsed)) {
          // New format: array of key names
          headerKeys = parsed as string[];
        } else if (typeof parsed === "object" && parsed !== null) {
          // Legacy format: object with key-value pairs (pre-encryption migration)
          headerKeys = Object.keys(parsed);
        }
      } catch { /* invalid JSON */ }
    }

    return {
      id: String(row.id),
      name: String(row.name),
      type: String(row.type) as "http" | "service-binding",
      url: row.url === null ? undefined : String(row.url),
      headers: undefined, // Never expose header values in listing
      headerKeys,
      enabled: Number(row.enabled) === 1,
    };
  }

  /** Legacy mapper used only for internal test endpoint resolution. */
  private mapMcpConfigRow(row: SqlRow): McpGatekeeperConfig & { headerKeys?: string[] } {
    const headersJsonStr = row.headers_json ? String(row.headers_json) : null;
    let headerKeys: string[] | undefined;

    if (headersJsonStr) {
      try {
        const parsed = JSON.parse(headersJsonStr);
        if (Array.isArray(parsed)) {
          headerKeys = parsed as string[];
        } else if (typeof parsed === "object" && parsed !== null) {
          headerKeys = Object.keys(parsed);
        }
      } catch { /* invalid JSON */ }
    }

    return {
      id: String(row.id),
      name: String(row.name),
      type: String(row.type) as "http" | "service-binding",
      url: row.url === null ? undefined : String(row.url),
      headers: undefined,
      headerKeys,
      enabled: Number(row.enabled) === 1,
    };
  }

  // ─── Session MCP Overrides ───

  private listMcpOverrides(sessionId: string): Array<{ sessionId: string; mcpConfigId: string; enabled: boolean }> {
    return this.db.all(
      "SELECT session_id, mcp_config_id, enabled FROM session_mcp_overrides WHERE session_id = ? ORDER BY mcp_config_id ASC",
      sessionId,
    ).map((row) => ({
      sessionId: String(row.session_id),
      mcpConfigId: String(row.mcp_config_id),
      enabled: Number(row.enabled) === 1,
    }));
  }

  private setMcpOverride(sessionId: string, mcpConfigId: string, enabled: boolean): void {
    this.db.exec(
      `INSERT INTO session_mcp_overrides (session_id, mcp_config_id, enabled)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id, mcp_config_id) DO UPDATE SET enabled = excluded.enabled`,
      sessionId,
      mcpConfigId,
      enabled ? 1 : 0,
    );
  }

  private getEffectiveMcpConfigs(sessionId: string): Array<McpGatekeeperConfig & { overridden: boolean }> {
    const configs = this.listMcpConfigsSafe();
    const overrides = this.listMcpOverrides(sessionId);
    const overrideMap = new Map(overrides.map((o) => [o.mcpConfigId, o.enabled]));

    return configs.map((config) => {
      const hasOverride = overrideMap.has(config.id);
      const effectiveEnabled = hasOverride ? overrideMap.get(config.id)! : config.enabled;
      return { ...config, enabled: effectiveEnabled, overridden: hasOverride };
    });
  }

  // ─── Onboarding ───

  private getOnboardingState(): OnboardingState {
    const row = this.db.one("SELECT value FROM user_config WHERE key = 'onboarding_state'");
    if (!row) {
      const initial = getInitialState();
      this.saveOnboardingState(initial);
      return initial;
    }
    return JSON.parse(String(row.value)) as OnboardingState;
  }

  private saveOnboardingState(state: OnboardingState): void {
    const now = nowEpoch();
    this.db.exec(
      "INSERT INTO user_config (key, value, updated_at) VALUES ('onboarding_state', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      JSON.stringify(state),
      now,
    );
  }

  // ─── Status ───

  private getStatus(): { version: string; commit: string; sessionCount: number; hasPasskey: boolean } {
    const sessionCount = Number(this.db.one("SELECT COUNT(*) AS count FROM sessions")?.count ?? 0);
    const hasPasskey = !!this.db.one("SELECT id FROM key_envelope WHERE id = 'default'");
    return {
      version: this.env.DODO_VERSION ?? "dev",
      commit: this.env.DODO_COMMIT ?? "",
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

  /**
   * Rotate the server-side wrapping key after SECRETS_MASTER_KEY changes.
   *
   * The old server key no longer works, so the user must provide their passkey
   * to bootstrap: passkey → DEK → re-wrap with new server key.
   */
  private async rotateServerKey(passkey: string, ownerEmail: string): Promise<void> {
    const masterKeyHex = this.env.SECRETS_MASTER_KEY;
    if (!masterKeyHex) throw new Error("Server encryption not configured");
    if (!ownerEmail) throw new Error("Owner email required for server key rotation");

    // Unwrap DEK using the user's passkey (old server key is unusable)
    const dek = await this.unwrapDEKWithPasskey(passkey);
    try {
      // Derive new SDK from the current (new) SECRETS_MASTER_KEY
      const newSdk = await deriveSDK(masterKeyHex, ownerEmail);
      const newWrappedServer = await wrapDEK(dek, newSdk);
      this.db.exec(
        "UPDATE key_envelope SET wrapped_dek_server = ?, rotated_at = ? WHERE id = 'default'",
        newWrappedServer,
        nowEpoch(),
      );
    } finally {
      dek.fill(0);
    }
  }
}
