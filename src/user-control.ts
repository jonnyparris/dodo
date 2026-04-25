import { DurableObject } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { parseCronExpression } from "cron-schedule";
import { RateLimiter } from "./rate-limit";
import { SourceSessionMissingError } from "./sessions";
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
  PBKDF2_DEFAULT_ITERATIONS,
  PBKDF2_LEGACY_ITERATIONS,
} from "./crypto";
import { HttpMcpGatekeeper, type McpGatekeeperConfig } from "./mcp-gatekeeper";
import { log } from "./logger";
import { advanceStep, getInitialState, type OnboardingState } from "./onboarding";
import { sendRunNotification } from "./notify";
import { epochToIso, nowEpoch, SqlHelper, type SqlRow } from "./sql-helpers";
import type {
  AppConfig,
  Env,
  FailureSnapshotRecord,
  MemoryEntry,
  ScheduledSessionRecord,
  ScheduledSessionSource,
  ScheduledSessionType,
  SessionIndexRecord,
  UpdateConfigRequest,
  WorkerRunRecord,
  WorkerRunStatus,
} from "./types";

// ─── Scheduled-session constants ───
/** After this many consecutive failures a schedule is stalled (manual retry required). */
const MAX_FAILURES = 5;
/** Minimum gap between fires — applies to `interval` and `cron` schedules. */
const MIN_INTERVAL_SECONDS = 300;
/** Hard upper bound on `delayed` schedules (90 days). */
const MAX_DELAY_SECONDS = 90 * 86400;
/** Maximum concurrent scheduled-session rows per user. */
const MAX_SCHEDULES_PER_USER = 50;

// ─── Idle-session cleanup constants ───
/** Sessions with no prompts that have been idle longer than this get soft-deleted. */
const IDLE_SESSION_TTL_SECONDS = 600; // 10 minutes
/** How often the DO alarm re-runs the idle sweep. */
const IDLE_SWEEP_INTERVAL_SECONDS = 300; // 5 minutes
/** Max sessions examined per sweep — bounds cross-DO fan-out. */
const IDLE_SWEEP_BATCH_SIZE = 25;

const updateConfigSchema = z
  .object({
    activeGateway: z.enum(["opencode", "ai-gateway"]).optional(),
    aiGatewayBaseURL: z.string().url().optional(),
    gitAuthorEmail: z.string().email().optional(),
    gitAuthorName: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    opencodeBaseURL: z.string().url().optional(),
    /** User preamble for the system prompt. Pass empty string to clear. */
    systemPromptPrefix: z.string().max(4_000).optional(),
    /** Default model for the `explore` subagent. Pass empty string to clear and fall back to heuristic. */
    exploreModel: z.string().max(200).optional(),
    /** Default model for the `task` subagent. Pass empty string to clear and fall back to heuristic. */
    taskModel: z.string().max(200).optional(),
    /** Explore-subagent dispatch mode. Pass empty string to clear (→ "inprocess"). */
    exploreMode: z.enum(["inprocess", "facet"]).optional(),
    /** Task-subagent dispatch mode. Pass empty string to clear (→ "inprocess"). */
    taskMode: z.enum(["inprocess", "facet"]).optional(),
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
    auth_type: z.enum(["oauth", "static_headers"]).default("static_headers"),
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

const mcpConfigUpdateSchema = z
  .object({
    name: z.string().min(1).optional(),
    type: z.enum(["http", "service-binding"]).optional(),
    auth_type: z.enum(["oauth", "static_headers"]).optional(),
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const workerRunStatusEnum = z.enum([
  "session_created",
  "repo_ready",
  "branch_created",
  "edit_applied",
  "commit_created",
  "prompt_running",
  "push_verified",
  "checks_running",
  "checks_passed",
  "done",
  "failed",
]);

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
  status: workerRunStatusEnum.default("session_created"),
  verifyWorkflow: z.string().min(1).nullable().optional(),
}).strict();

const workerRunUpdateSchema = z.object({
  status: workerRunStatusEnum.optional(),
  lastError: z.string().nullable().optional(),
  failureSnapshotId: z.string().nullable().optional(),
  prUrl: z.string().nullable().optional(),
  verification: z.record(z.string(), z.unknown()).nullable().optional(),
  verifyWorkflowRunId: z.string().nullable().optional(),
  verifyWorkflowHtmlUrl: z.string().nullable().optional(),
}).strict();

const failureSnapshotCreateSchema = z.object({
  runId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
}).strict();

// Scheduled-session schema. The request body combines a schedule descriptor
// (delayed | scheduled | cron | interval) with a session-source descriptor
// (fresh | fork). We can't use z.discriminatedUnion on both at once, so
// validate the schedule shape and then validate `source` separately.
const scheduleShapeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("delayed"),
    delayInSeconds: z.number().int().positive().max(MAX_DELAY_SECONDS),
  }),
  z.object({
    type: z.literal("scheduled"),
    // Range bound is enforced in createScheduledSession (needs current time)
    date: z.string().datetime(),
  }),
  z.object({
    type: z.literal("cron"),
    cron: z.string().min(1),
  }),
  z.object({
    type: z.literal("interval"),
    intervalSeconds: z.number().int().min(MIN_INTERVAL_SECONDS),
  }),
]);

const sourceShapeSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("fresh"),
    title: z.string().max(200).optional(),
  }),
  z.object({
    source: z.literal("fork"),
    sourceSessionId: z.string().min(1),
    title: z.string().max(200).optional(),
  }),
]);

const scheduledSessionBaseSchema = z.object({
  description: z.string().min(1).max(500),
  prompt: z.string().min(1).max(100_000),
  createdBy: z.string().email(),
});

/**
 * Validate a subagent mode value read from storage. Keeps readConfig
 * tolerant of poisoned or legacy rows — unknown values fall through
 * to "inprocess", the safe default that preserves pre-facet behaviour.
 */
function toAgentMode(value: string | undefined): "inprocess" | "facet" {
  return value === "facet" ? "facet" : "inprocess";
}

/**
 * UserControl DO — one per user (`idFromName(email)`).
 *
 * Owns per-user state: sessions, config, memory, tasks,
 * key envelope (envelope encryption), encrypted secrets,
 * MCP configs, and fork snapshots.
 */
export class UserControl extends DurableObject<Env> {
  private readonly db: SqlHelper;
  /** SSE clients for user-level events (session list changes, etc.) */
  private readonly sseClients = new Map<WritableStreamDefaultWriter<Uint8Array>, Promise<void>>();
  /**
   * Rate limiter for scheduled-session fires.
   *
   * Semantics (documented honestly — audit finding #19/#27):
   * - This is SEPARATE from the interactive `promptLimiter` in src/index.ts.
   *   A user can consume their 60/hr interactive budget AND fire up to
   *   60 scheduled sessions per hour on top. The effective upper bound
   *   on prompts originating from a single user is ~120/hr.
   * - The window is in-memory on this DO instance. When the DO hibernates
   *   (~10 min idle) and rehydrates, the window resets to zero. This is
   *   best-effort abuse prevention, not a hard quota.
   *
   * If future abuse requires a true shared / durable budget, migrate this
   * to SharedIndex with an atomic DO counter. Not worth the complexity
   * until we see the abuse pattern in practice.
   */
  private readonly scheduledFireLimiter = new RateLimiter();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new SqlHelper(ctx.storage.sql);
    ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema();
      await this.seedDefaults();
      // Arm the alarm on DO activation so existing idle sessions get
      // swept even if no new work arrives. Cheap no-op when there are
      // no idle sessions and no pending schedules.
      await this.rearmAlarm();
    });
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
      // ─── User-level SSE ───

      if (request.method === "GET" && url.pathname === "/events") {
        return this.openUserEventStream(request);
      }

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
        const session = this.registerSession(body.id, body.title ?? null, body.ownerEmail, body.createdBy);
        this.emitUserEvent({ type: "sessions_changed", reason: "created", sessionId: body.id });
        return Response.json(session, { status: 201 });
      }

      if (request.method === "PATCH" && url.pathname.startsWith("/sessions/")) {
        const sessionId = url.pathname.split("/").at(-1) ?? "";
        const body = z.object({ status: z.string().optional(), title: z.string().nullable().optional() }).strict().parse(await request.json());
        const session = this.touchSession(sessionId, body);
        this.emitUserEvent({ type: "sessions_changed", reason: "updated", sessionId });
        return Response.json(session);
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
        this.emitUserEvent({ type: "sessions_changed", reason: "deleted", sessionId });
        return Response.json({ deleted: true, sessionId });
      }

      // Soft-delete: mark session as deleted with a TTL for recovery
      if (request.method === "POST" && url.pathname.match(/^\/sessions\/[^/]+\/soft-delete$/)) {
        const sessionId = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
        const row = this.db.one("SELECT id FROM sessions WHERE id = ?", sessionId);
        if (!row) return Response.json({ error: `Session '${sessionId}' not found` }, { status: 404 });
        const deleteExpiry = nowEpoch() + 300; // 5 minutes
        this.db.exec("UPDATE sessions SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?", deleteExpiry, nowEpoch(), sessionId);
        this.emitUserEvent({ type: "sessions_changed", reason: "deleted", sessionId });
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
        this.emitUserEvent({ type: "sessions_changed", reason: "restored", sessionId });
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

      if (request.method === "POST" && url.pathname === "/user-mcp-tokens") {
        const { email, label } = await request.json() as { email: string; label?: string };
        const result = await this.createUserMcpToken(email, label);
        return Response.json(result);
      }
      if (request.method === "GET" && url.pathname.startsWith("/user-mcp-tokens/lookup/")) {
        const token = decodeURIComponent(url.pathname.slice("/user-mcp-tokens/lookup/".length));
        const result = this.lookupUserMcpToken(token);
        return Response.json(result);
      }
      if (request.method === "GET" && url.pathname === "/user-mcp-tokens") {
        const email = request.headers.get("x-owner-email") ?? "";
        return Response.json(this.listUserMcpTokens(email));
      }
      if (request.method === "DELETE" && url.pathname.match(/^\/user-mcp-tokens\/[^/]+$/)) {
        const token = decodeURIComponent(url.pathname.slice("/user-mcp-tokens/".length));
        const email = request.headers.get("x-owner-email") ?? "";
        const ok = await this.deleteUserMcpToken(email, token);
        return Response.json({ ok });
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

      if (request.method === "GET" && url.pathname === "/approved-mcps") {
        return Response.json(this.listApprovedMcps());
      }
      if (request.method === "POST" && url.pathname === "/approved-mcps") {
        const body = await request.json() as Parameters<UserControl["createApprovedMcp"]>[0];
        this.createApprovedMcp(body);
        return Response.json({ ok: true });
      }
      if (request.method === "PUT" && url.pathname.match(/^\/approved-mcps\/[^/]+$/)) {
        const mcpUrl = decodeURIComponent(url.pathname.slice("/approved-mcps/".length));
        const body = await request.json() as Parameters<UserControl["updateApprovedMcp"]>[1];
        const ok = this.updateApprovedMcp(mcpUrl, body);
        return Response.json({ ok });
      }
      if (request.method === "DELETE" && url.pathname.match(/^\/approved-mcps\/[^/]+$/)) {
        const mcpUrl = decodeURIComponent(url.pathname.slice("/approved-mcps/".length));
        const ok = this.softDeleteApprovedMcp(mcpUrl);
        return Response.json({ ok });
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

      // ─── Scheduled sessions ───

      if (request.method === "GET" && url.pathname === "/scheduled-sessions") {
        return Response.json({ scheduledSessions: this.listScheduledSessions() });
      }

      if (request.method === "POST" && url.pathname === "/scheduled-sessions") {
        const raw = await request.json();
        const base = scheduledSessionBaseSchema.parse(raw);
        const schedule = scheduleShapeSchema.parse(raw);
        const sourceInput = sourceShapeSchema.parse(raw);
        return Response.json(
          this.createScheduledSession(base, schedule, sourceInput),
          { status: 201 },
        );
      }

      if (request.method === "GET" && url.pathname.match(/^\/scheduled-sessions\/[^/]+$/)) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        const row = this.readScheduledSessionRow(id);
        if (!row) return Response.json({ error: `Scheduled session '${id}' not found` }, { status: 404 });
        return Response.json(this.mapScheduledSessionRow(row));
      }

      if (request.method === "DELETE" && url.pathname.match(/^\/scheduled-sessions\/[^/]+$/)) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        const row = this.readScheduledSessionRow(id);
        if (!row) return Response.json({ error: `Scheduled session '${id}' not found` }, { status: 404 });
        this.db.exec("DELETE FROM scheduled_sessions WHERE id = ?", id);
        await this.rearmScheduledSessionAlarm();
        return Response.json({ deleted: true, id });
      }

      if (request.method === "POST" && url.pathname.match(/^\/scheduled-sessions\/[^/]+\/retry$/)) {
        const id = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
        const row = this.readScheduledSessionRow(id);
        if (!row) return Response.json({ error: `Scheduled session '${id}' not found` }, { status: 404 });
        const nextRun = this.computeNextRun(row);
        this.db.exec(
          "UPDATE scheduled_sessions SET failure_count = 0, stalled_at = NULL, last_error = NULL, next_run_epoch = ? WHERE id = ?",
          nextRun,
          id,
        );
        await this.rearmScheduledSessionAlarm();
        const refreshed = this.readScheduledSessionRow(id);
        return Response.json(refreshed ? this.mapScheduledSessionRow(refreshed) : { retried: true, id });
      }

      // ─── Status ───

      if (request.method === "GET" && url.pathname === "/status") {
        return Response.json(this.getStatus());
      }

      // ─── Key Envelope / Passkey ───

      if (request.method === "POST" && url.pathname === "/passkey/init") {
        // Minimum 12 chars. Combined with the bumped PBKDF2 iteration count
        // (audit finding M2), this raises the offline cracking cost on a
        // leaked envelope from "minutes on a GPU" to "infeasible at modest
        // budget". 4-char passkeys offered essentially no security.
        // (audit finding M3)
        const body = z.object({ passkey: z.string().min(12) }).parse(await request.json());
        const ownerEmail = request.headers.get("x-owner-email") ?? "";
        await this.initKeyEnvelope(body.passkey, ownerEmail);
        return Response.json({ initialized: true });
      }

      if (request.method === "POST" && url.pathname === "/passkey/change") {
        const body = z.object({ currentPasskey: z.string().min(1), newPasskey: z.string().min(12) }).parse(await request.json());
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
            "UPDATE mcp_configs SET url = ?, auth_type = 'static_headers', headers_json = ?, enabled = 1, updated_at = ? WHERE id = 'browser-rendering'",
            mcpUrl, headerKeys, now,
          );
        } else {
          this.db.exec(
            "INSERT INTO mcp_configs (id, name, type, auth_type, url, headers_json, enabled, created_at, updated_at) VALUES ('browser-rendering', 'Browser Rendering', 'http', 'static_headers', ?, ?, 1, ?, ?)",
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

    // One-shot purge of literal "undefined"/"null" strings caused by an
    // older bug that called `String(undefined)` on optional fields. Cheap
    // SQL even when the table is large; readConfig still defensively
    // treats those as blank if anything slips through. (audit finding L5)
    this.db.exec("DELETE FROM user_config WHERE value IN ('undefined', 'null')");

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
        rotated_at INTEGER,
        pbkdf2_iterations INTEGER
      )
    `);
    // Additive migration for existing envelopes — SQLite ignores the column
    // if it already exists. (audit finding M2)
    try {
      this.db.exec("ALTER TABLE key_envelope ADD COLUMN pbkdf2_iterations INTEGER");
    } catch {
      // Column already exists, fine.
    }

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
        pr_url TEXT,
        verify_workflow TEXT,
        verify_workflow_run_id TEXT,
        verify_workflow_html_url TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    try {
      this.db.exec("ALTER TABLE worker_runs ADD COLUMN pr_url TEXT");
    } catch {
      // Column already exists.
    }

    for (const ddl of [
      "ALTER TABLE worker_runs ADD COLUMN verify_workflow TEXT",
      "ALTER TABLE worker_runs ADD COLUMN verify_workflow_run_id TEXT",
      "ALTER TABLE worker_runs ADD COLUMN verify_workflow_html_url TEXT",
    ]) {
      try { this.db.exec(ddl); } catch { /* column already exists */ }
    }

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
        auth_type TEXT NOT NULL DEFAULT 'static_headers',
        url TEXT,
        headers_json TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    try {
      this.db.exec("ALTER TABLE mcp_configs ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'static_headers'");
    } catch {
      // Column already exists.
    }
    this.db.exec("UPDATE mcp_configs SET auth_type = 'static_headers' WHERE auth_type IS NULL OR auth_type = ''");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approved_mcps (
        mcp_url TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT,
        setup_guide TEXT,
        known_hosts TEXT,
        auth_type TEXT NOT NULL DEFAULT 'static_headers',
        status TEXT NOT NULL DEFAULT 'enabled',
        is_deleted INTEGER NOT NULL DEFAULT 0,
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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_sessions (
        id                TEXT PRIMARY KEY,
        description       TEXT NOT NULL,
        prompt            TEXT NOT NULL,
        schedule_type     TEXT NOT NULL,
        delay_seconds     INTEGER,
        target_epoch      INTEGER,
        cron_expression   TEXT,
        interval_seconds  INTEGER,
        source_type       TEXT NOT NULL,
        source_session_id TEXT,
        session_title     TEXT,
        next_run_epoch    INTEGER,
        last_run_epoch    INTEGER,
        last_session_id   TEXT,
        run_count         INTEGER NOT NULL DEFAULT 0,
        failure_count     INTEGER NOT NULL DEFAULT 0,
        stalled_at        INTEGER,
        last_error        TEXT,
        created_at        INTEGER NOT NULL,
        created_by        TEXT NOT NULL
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_scheduled_sessions_next_run ON scheduled_sessions(next_run_epoch) WHERE next_run_epoch IS NOT NULL",
    );

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_mcp_tokens (
        token TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        label TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        synced_to_index INTEGER NOT NULL DEFAULT 1
      )
    `);
    // Additive migration for existing tables (audit finding M15)
    try {
      this.db.exec("ALTER TABLE user_mcp_tokens ADD COLUMN synced_to_index INTEGER NOT NULL DEFAULT 1");
    } catch { /* column already exists */ }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_user_mcp_tokens_email ON user_mcp_tokens (email)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_user_mcp_tokens_synced ON user_mcp_tokens (synced_to_index) WHERE synced_to_index = 0");

    // TTL cleanup: remove fork snapshots older than 1 hour
    const oneHourAgo = nowEpoch() - 3600;
    this.db.exec("DELETE FROM fork_snapshots WHERE created_at < ?", oneHourAgo);
    // Keep failure snapshots for 7 days
    this.db.exec("DELETE FROM failure_snapshots WHERE created_at < ?", nowEpoch() - 604800);
  }

  private async seedDefaults(): Promise<void> {
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

    const existingCount = this.db.one("SELECT COUNT(*) AS n FROM approved_mcps WHERE is_deleted = 0");
    if (Number(existingCount?.n ?? 0) === 0) {
      const { getDeployMcpCatalog } = await import("./mcp-catalog");
      const seedNow = Date.now();
      for (const entry of getDeployMcpCatalog(this.env)) {
        this.db.exec(
          `INSERT INTO approved_mcps (mcp_url, id, display_name, description, setup_guide, known_hosts, auth_type, status, is_deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'enabled', 0, ?, ?)`,
          entry.url,
          entry.id,
          entry.name,
          entry.description ?? null,
          entry.setupGuide ?? null,
          JSON.stringify(entry.knownHosts ?? []),
          entry.auth_type ?? "static_headers",
          seedNow,
          seedNow,
        );
      }
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
    // Recover from rows poisoned by the pre-fix updateConfig that called
    // `String(undefined)` — treat the literal strings "undefined" and
    // "null" as "not set" for every field. This lets existing deployments
    // recover without a manual DB fix.
    const isBlank = (v: string | undefined): boolean =>
      v === undefined || v === "" || v === "undefined" || v === "null";
    const get = (key: string): string | undefined =>
      isBlank(values[key]) ? undefined : values[key];
    return {
      activeGateway: get("activeGateway") === "ai-gateway" ? "ai-gateway" : "opencode",
      aiGatewayBaseURL: get("aiGatewayBaseURL") ?? this.env.AI_GATEWAY_BASE_URL,
      gitAuthorEmail: get("gitAuthorEmail") ?? this.env.GIT_AUTHOR_EMAIL ?? "dodo@example.com",
      gitAuthorName: get("gitAuthorName") ?? this.env.GIT_AUTHOR_NAME ?? "Dodo",
      model: get("model") ?? this.env.DEFAULT_MODEL,
      opencodeBaseURL: get("opencodeBaseURL") ?? this.env.OPENCODE_BASE_URL,
      systemPromptPrefix: get("systemPromptPrefix"),
      // Fall back to the env defaults, then undefined (heuristic path).
      // DEFAULT_EXPLORE_MODEL ships as Kimi K2.6 in wrangler.jsonc —
      // investigate/search work is the subagent's primary use case, and
      // Kimi is the best-value fit per the 2026-04-24 model comparison.
      exploreModel: get("exploreModel") ?? this.env.DEFAULT_EXPLORE_MODEL,
      taskModel: get("taskModel") ?? this.env.DEFAULT_TASK_MODEL,
      // Schema (UpdateConfigRequest) enforces the enum on write, but we
      // re-validate on read so a poisoned row (e.g. from a pre-schema
      // deployment or a direct SQL edit) still resolves to a valid mode
      // rather than crashing downstream. Unknown values default to
      // "inprocess" — the safe, behaviour-preserving choice.
      exploreMode: toAgentMode(get("exploreMode")),
      taskMode: toAgentMode(get("taskMode")),
    };
  }

  private updateConfig(input: UpdateConfigRequest): AppConfig {
    const current = this.readConfig();
    const nextConfig = { ...current, ...input };

    // Auto-swap model when the user changes gateway and the current model
    // isn't routable by the new gateway. Prevents the "Bad Request on first prompt"
    // failure mode reported in jonnyparris/dodo#30.
    const gatewayChanged = input.activeGateway && input.activeGateway !== current.activeGateway;
    const modelExplicit = Object.prototype.hasOwnProperty.call(input, "model");
    if (gatewayChanged && !modelExplicit) {
      if (input.activeGateway === "ai-gateway" && !nextConfig.model.startsWith("@cf/")) {
        nextConfig.model = this.env.AI_GATEWAY_DEFAULT_MODEL ?? "@cf/moonshotai/kimi-k2.6";
      } else if (input.activeGateway === "opencode" && nextConfig.model.startsWith("@cf/")) {
        nextConfig.model = this.env.DEFAULT_MODEL;
      }
    }

    const now = nowEpoch();
    for (const [key, value] of Object.entries(nextConfig)) {
      // Drop undefined/null keys entirely — never persist `String(undefined)`
      // or `String(null)` because readConfig() would treat those literal
      // strings as set values. This matters for AppConfig fields that are
      // `| undefined` in the type (e.g. systemPromptPrefix): every config
      // update would otherwise poison the key with the string "undefined".
      if (value === undefined || value === null) {
        this.db.exec("DELETE FROM user_config WHERE key = ?", key);
        continue;
      }
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
    // A fresh idle session is eligible for the idle-sweep in ~10min.
    // Fire-and-forget — rearmAlarm only touches DO storage, which is
    // serialised by the input gate.
    void this.rearmAlarm();
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
        failure_snapshot_id, pr_url, verify_workflow, verify_workflow_run_id, verify_workflow_html_url,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      null,
      input.verifyWorkflow ?? null,
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
    const previousStatus = current.status;
    this.db.exec(
      `UPDATE worker_runs
       SET status = ?,
           last_error = ?,
           failure_snapshot_id = ?,
           pr_url = ?,
           verification_json = ?,
           verify_workflow_run_id = ?,
           verify_workflow_html_url = ?,
           updated_at = ?
       WHERE id = ?`,
      patch.status ?? current.status,
      patch.lastError === undefined ? current.lastError : patch.lastError,
      patch.failureSnapshotId === undefined ? current.failureSnapshotId : patch.failureSnapshotId,
      patch.prUrl === undefined ? current.prUrl : patch.prUrl,
      patch.verification === undefined
        ? (current.verification === null ? null : JSON.stringify(current.verification))
        : (patch.verification === null ? null : JSON.stringify(patch.verification)),
      patch.verifyWorkflowRunId === undefined ? (current.verifyWorkflowRunId ?? null) : patch.verifyWorkflowRunId,
      patch.verifyWorkflowHtmlUrl === undefined ? (current.verifyWorkflowHtmlUrl ?? null) : patch.verifyWorkflowHtmlUrl,
      nowEpoch(),
      id,
    );
    const run = this.getWorkerRun(id);
    sendRunNotification(this.env, this.ctx, run, previousStatus, this.getOwnerEmail() ?? undefined);
    return run;
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
      prUrl: row.pr_url === null ? null : String(row.pr_url),
      repoDir: String(row.repo_dir),
      repoId: String(row.repo_id),
      repoUrl: String(row.repo_url),
      sessionId: String(row.session_id),
      status: String(row.status) as WorkerRunStatus,
      strategy: String(row.strategy) as WorkerRunRecord["strategy"],
      title: String(row.title),
      updatedAt: epochToIso(row.updated_at),
      verification: row.verification_json === null ? null : JSON.parse(String(row.verification_json)) as Record<string, unknown>,
      verifyWorkflow: row.verify_workflow == null ? null : String(row.verify_workflow),
      verifyWorkflowHtmlUrl: row.verify_workflow_html_url == null ? null : String(row.verify_workflow_html_url),
      verifyWorkflowRunId: row.verify_workflow_run_id == null ? null : String(row.verify_workflow_run_id),
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
  private async createMcpConfigEncrypted(input: { name: string; type: string; auth_type: "oauth" | "static_headers"; url?: string; headers?: Record<string, string>; enabled: boolean }, ownerEmail: string): Promise<McpGatekeeperConfig & { headerKeys?: string[] }> {
    const id = crypto.randomUUID();
    const now = nowEpoch();
    const headerKeys = input.headers ? Object.keys(input.headers) : [];

    this.db.exec(
      "INSERT INTO mcp_configs (id, name, type, auth_type, url, headers_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, input.name, input.type, input.auth_type, input.url ?? null, headerKeys.length > 0 ? JSON.stringify(headerKeys) : null, input.enabled ? 1 : 0, now, now,
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
  private async updateMcpConfigEncrypted(id: string, patch: { name?: string; type?: string; auth_type?: "oauth" | "static_headers"; url?: string; headers?: Record<string, string>; enabled?: boolean }, ownerEmail: string): Promise<McpGatekeeperConfig & { headerKeys?: string[] }> {
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
      "UPDATE mcp_configs SET name = ?, type = ?, auth_type = ?, url = ?, headers_json = ?, enabled = ?, updated_at = ? WHERE id = ?",
      patch.name ?? current.name,
      patch.type ?? current.type,
      patch.auth_type ?? current.auth_type,
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
    const row = this.db.one("SELECT id, name, type, auth_type, url, headers_json, enabled FROM mcp_configs WHERE id = ?", id);
    if (!row) throw new Error(`MCP config ${id} not found`);
    return this.mapMcpConfigRowSafe(row);
  }

  /**
   * List MCP configs for display. Returns header key names but not values.
   */
  private listMcpConfigsSafe(): Array<McpGatekeeperConfig & { headerKeys?: string[] }> {
    return this.db.all("SELECT id, name, type, auth_type, url, headers_json, enabled FROM mcp_configs ORDER BY name ASC")
      .map((row) => this.mapMcpConfigRowSafe(row));
  }

  public async createUserMcpToken(email: string, label?: string): Promise<{ token: string; created_at: number }> {
    const token = `dodo_${crypto.randomUUID().replace(/-/g, "")}`;
    const normalisedEmail = email.trim().toLowerCase();
    const now = Date.now();
    // Insert with synced_to_index=0 first; flip to 1 only after the
    // SharedIndex write succeeds. Background reconciliation
    // (`reconcileUnsyncedMcpTokens`) replays unsynced rows. (audit finding M15)
    this.db.exec(
      "INSERT INTO user_mcp_tokens (token, email, label, created_at, last_used_at, synced_to_index) VALUES (?, ?, ?, ?, NULL, 0)",
      token, normalisedEmail, label ?? null, now,
    );
    try {
      const sharedIndex = this.env.SHARED_INDEX.get(this.env.SHARED_INDEX.idFromName("global"));
      const res = await sharedIndex.fetch("https://shared-index/mcp-token-index", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, email: normalisedEmail }),
      });
      if (res.ok) {
        this.db.exec("UPDATE user_mcp_tokens SET synced_to_index = 1 WHERE token = ?", token);
      } else {
        log("warn", "user-control: SharedIndex token sync returned non-OK", { status: res.status, token: token.slice(0, 12) });
      }
    } catch (err) {
      log("warn", "user-control: failed to sync token to SharedIndex (will retry)", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return { token, created_at: now };
  }

  /**
   * Re-attempt SharedIndex writes for any tokens that failed to sync at
   * creation time. Safe to call repeatedly — idempotent on the SharedIndex
   * side and a no-op when there's nothing to reconcile. (audit finding M15)
   */
  private async reconcileUnsyncedMcpTokens(): Promise<void> {
    const rows = this.db.all("SELECT token, email FROM user_mcp_tokens WHERE synced_to_index = 0 LIMIT 50");
    if (rows.length === 0) return;
    const sharedIndex = this.env.SHARED_INDEX.get(this.env.SHARED_INDEX.idFromName("global"));
    for (const row of rows) {
      const token = String(row.token);
      const email = String(row.email);
      try {
        const res = await sharedIndex.fetch("https://shared-index/mcp-token-index", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, email }),
        });
        if (res.ok) {
          this.db.exec("UPDATE user_mcp_tokens SET synced_to_index = 1 WHERE token = ?", token);
        }
      } catch {
        // Try again next sweep.
      }
    }
  }

  public lookupUserMcpToken(token: string): { email: string; label: string | null; created_at: number } | null {
    const row = this.db.one("SELECT email, label, created_at FROM user_mcp_tokens WHERE token = ?", token);
    if (!row) return null;
    this.db.exec("UPDATE user_mcp_tokens SET last_used_at = ? WHERE token = ?", Date.now(), token);
    return {
      email: String(row.email),
      label: row.label as string | null,
      created_at: Number(row.created_at),
    };
  }

  public listUserMcpTokens(email: string): Array<{ token_prefix: string; label: string | null; created_at: number; last_used_at: number | null }> {
    const rows = this.db.all(
      "SELECT token, label, created_at, last_used_at FROM user_mcp_tokens WHERE email = ? ORDER BY created_at DESC",
      email.trim().toLowerCase(),
    );
    return rows.map((r) => ({
      token_prefix: String(r.token).slice(0, 12) + "…",
      label: r.label as string | null,
      created_at: Number(r.created_at),
      last_used_at: r.last_used_at === null ? null : Number(r.last_used_at),
    }));
  }

  public async deleteUserMcpToken(email: string, token: string): Promise<boolean> {
    const existing = this.db.one("SELECT email FROM user_mcp_tokens WHERE token = ?", token);
    if (!existing) return false;
    const normalisedEmail = email.trim().toLowerCase();
    if (String(existing.email).trim().toLowerCase() !== normalisedEmail) return false;
    this.db.exec("DELETE FROM user_mcp_tokens WHERE token = ?", token);
    // Remove the pointer from the global index too
    try {
      const sharedIndex = this.env.SHARED_INDEX.get(this.env.SHARED_INDEX.idFromName("global"));
      await sharedIndex.fetch(`https://shared-index/mcp-token-index/${encodeURIComponent(token)}`, { method: "DELETE" });
    } catch (err) {
      console.warn("[user-control] Failed to delete token from SharedIndex:", err);
    }
    return true;
  }

  public listApprovedMcps(): Array<{
    mcp_url: string;
    id: string;
    display_name: string;
    description: string | null;
    setup_guide: string | null;
    known_hosts: string[];
    auth_type: "oauth" | "static_headers";
    status: "enabled" | "disabled";
  }> {
    const rows = this.db.all(
      "SELECT mcp_url, id, display_name, description, setup_guide, known_hosts, auth_type, status FROM approved_mcps WHERE is_deleted = 0 ORDER BY display_name ASC",
    );
    return rows.map((r) => ({
      mcp_url: String(r.mcp_url),
      id: String(r.id),
      display_name: String(r.display_name),
      description: r.description as string | null,
      setup_guide: r.setup_guide as string | null,
      known_hosts: JSON.parse(String(r.known_hosts ?? "[]")),
      auth_type: r.auth_type as "oauth" | "static_headers",
      status: r.status as "enabled" | "disabled",
    }));
  }

  public createApprovedMcp(entry: {
    mcp_url: string;
    id: string;
    display_name: string;
    description?: string;
    setup_guide?: string;
    known_hosts?: string[];
    auth_type?: "oauth" | "static_headers";
    status?: "enabled" | "disabled";
  }): void {
    const now = Date.now();
    const existing = this.db.one("SELECT mcp_url, is_deleted FROM approved_mcps WHERE mcp_url = ?", entry.mcp_url);
    if (existing) {
      this.db.exec(
        `UPDATE approved_mcps
         SET id = ?, display_name = ?, description = ?, setup_guide = ?, known_hosts = ?, auth_type = ?, status = ?, is_deleted = 0, updated_at = ?
         WHERE mcp_url = ?`,
        entry.id,
        entry.display_name,
        entry.description ?? null,
        entry.setup_guide ?? null,
        JSON.stringify(entry.known_hosts ?? []),
        entry.auth_type ?? "static_headers",
        entry.status ?? "enabled",
        now,
        entry.mcp_url,
      );
      return;
    }
    this.db.exec(
      `INSERT INTO approved_mcps (mcp_url, id, display_name, description, setup_guide, known_hosts, auth_type, status, is_deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      entry.mcp_url,
      entry.id,
      entry.display_name,
      entry.description ?? null,
      entry.setup_guide ?? null,
      JSON.stringify(entry.known_hosts ?? []),
      entry.auth_type ?? "static_headers",
      entry.status ?? "enabled",
      now,
      now,
    );
  }

  public updateApprovedMcp(mcp_url: string, updates: { display_name?: string; description?: string; setup_guide?: string; status?: "enabled" | "disabled" }): boolean {
    const existing = this.db.one("SELECT mcp_url FROM approved_mcps WHERE mcp_url = ? AND is_deleted = 0", mcp_url);
    if (!existing) return false;
    const setClauses: string[] = [];
    const values: unknown[] = [];
    if (updates.display_name !== undefined) { setClauses.push("display_name = ?"); values.push(updates.display_name); }
    if (updates.description !== undefined) { setClauses.push("description = ?"); values.push(updates.description); }
    if (updates.setup_guide !== undefined) { setClauses.push("setup_guide = ?"); values.push(updates.setup_guide); }
    if (updates.status !== undefined) { setClauses.push("status = ?"); values.push(updates.status); }
    if (setClauses.length === 0) return true;
    setClauses.push("updated_at = ?");
    values.push(Date.now());
    values.push(mcp_url);
    this.db.exec(`UPDATE approved_mcps SET ${setClauses.join(", ")} WHERE mcp_url = ?`, ...values);
    return true;
  }

  public softDeleteApprovedMcp(mcp_url: string): boolean {
    const existing = this.db.one("SELECT mcp_url FROM approved_mcps WHERE mcp_url = ? AND is_deleted = 0", mcp_url);
    if (!existing) return false;
    this.db.exec("UPDATE approved_mcps SET is_deleted = 1, updated_at = ? WHERE mcp_url = ?", Date.now(), mcp_url);
    return true;
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
      auth_type: row.auth_type === "oauth" ? "oauth" : "static_headers",
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
      auth_type: row.auth_type === "oauth" ? "oauth" : "static_headers",
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
    // New envelopes use the modern iteration count. Legacy rows keep their
    // original count via the pbkdf2_iterations column (NULL → legacy).
    // (audit finding M2)
    const pdk = await derivePDK(passkey, salt, PBKDF2_DEFAULT_ITERATIONS);
    const sdk = await deriveSDK(masterKeyHex, ownerEmail);
    const wrappedPasskey = await wrapDEK(dek, pdk);
    const wrappedServer = await wrapDEK(dek, sdk);

    this.db.exec(
      "INSERT INTO key_envelope (id, pbkdf2_salt, wrapped_dek_passkey, wrapped_dek_server, created_at, pbkdf2_iterations) VALUES ('default', ?, ?, ?, ?, ?)",
      bytesToBase64(salt),
      wrappedPasskey,
      wrappedServer,
      nowEpoch(),
      PBKDF2_DEFAULT_ITERATIONS,
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
    const envelope = this.db.one("SELECT pbkdf2_salt, wrapped_dek_passkey, pbkdf2_iterations FROM key_envelope WHERE id = 'default'");
    if (!envelope) throw new Error("No key envelope.");
    const salt = base64ToBytes(String(envelope.pbkdf2_salt));
    // Legacy envelopes (pre-M2) have a NULL iteration count and were derived
    // with the old 100k value. Use that to unwrap, then opportunistically
    // re-wrap at the modern count below in unwrapAndUpgradePasskey.
    const iterations = envelope.pbkdf2_iterations === null || envelope.pbkdf2_iterations === undefined
      ? PBKDF2_LEGACY_ITERATIONS
      : Number(envelope.pbkdf2_iterations);
    const pdk = await derivePDK(passkey, salt, iterations);
    const dek = await unwrapDEK(String(envelope.wrapped_dek_passkey), pdk);

    // Opportunistic upgrade: if the envelope was minted before the iteration
    // bump, re-wrap with the new count and persist. This makes the user's
    // *next* unlock pay the new (higher) cost without forcing a manual
    // change-passkey flow. Skip on failure — better to leave the legacy
    // wrap in place than to break the user's onboarding.
    if (iterations < PBKDF2_DEFAULT_ITERATIONS) {
      try {
        const newSalt = generateSalt();
        const newPdk = await derivePDK(passkey, newSalt, PBKDF2_DEFAULT_ITERATIONS);
        const newWrapped = await wrapDEK(dek, newPdk);
        this.db.exec(
          "UPDATE key_envelope SET pbkdf2_salt = ?, wrapped_dek_passkey = ?, pbkdf2_iterations = ?, rotated_at = ? WHERE id = 'default'",
          bytesToBase64(newSalt),
          newWrapped,
          PBKDF2_DEFAULT_ITERATIONS,
          nowEpoch(),
        );
      } catch (err) {
        log("warn", "PBKDF2 envelope upgrade failed (will retry on next unlock)", { err: err instanceof Error ? err.message : String(err) });
      }
    }

    return dek;
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

  private async changePasskey(currentPasskey: string, newPasskey: string, _ownerEmail: string): Promise<void> {
    // Verify current passkey works
    const dek = await this.unwrapDEKWithPasskey(currentPasskey);
    try {
      // Generate new salt and PDK using the current default iteration count.
      const newSalt = generateSalt();
      const newPdk = await derivePDK(newPasskey, newSalt, PBKDF2_DEFAULT_ITERATIONS);
      const newWrappedPasskey = await wrapDEK(dek, newPdk);
      this.db.exec(
        "UPDATE key_envelope SET pbkdf2_salt = ?, wrapped_dek_passkey = ?, pbkdf2_iterations = ?, rotated_at = ? WHERE id = 'default'",
        bytesToBase64(newSalt),
        newWrappedPasskey,
        PBKDF2_DEFAULT_ITERATIONS,
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

  // ─── Scheduled sessions ───

  private createScheduledSession(
    base: z.infer<typeof scheduledSessionBaseSchema>,
    schedule: z.infer<typeof scheduleShapeSchema>,
    sourceInput: z.infer<typeof sourceShapeSchema>,
  ): ScheduledSessionRecord {
    // Enforce the per-user cap
    const existing = Number(this.db.one("SELECT COUNT(*) AS count FROM scheduled_sessions")?.count ?? 0);
    if (existing >= MAX_SCHEDULES_PER_USER) {
      throw new Error(`You have reached the maximum of ${MAX_SCHEDULES_PER_USER} scheduled sessions. Delete some to add more.`);
    }

    // Compute schedule fields + next run
    const id = crypto.randomUUID();
    const now = nowEpoch();
    let delaySeconds: number | null = null;
    let targetEpoch: number | null = null;
    let cronExpression: string | null = null;
    let intervalSeconds: number | null = null;
    let nextRunEpoch: number;

    if (schedule.type === "delayed") {
      delaySeconds = schedule.delayInSeconds;
      nextRunEpoch = now + schedule.delayInSeconds;
    } else if (schedule.type === "scheduled") {
      const parsed = Math.floor(Date.parse(schedule.date) / 1000);
      if (!Number.isFinite(parsed) || parsed <= now) {
        throw new Error("scheduled date must be in the future");
      }
      if (parsed - now > MAX_DELAY_SECONDS) {
        throw new Error(`scheduled date must be within ${MAX_DELAY_SECONDS / 86400} days`);
      }
      targetEpoch = parsed;
      nextRunEpoch = parsed;
    } else if (schedule.type === "cron") {
      // Validate expression + minimum-gap (next three matches must all be
      // at least MIN_INTERVAL_SECONDS apart). Reject sub-5-minute cron
      // schedules to bound cost.
      let cron: ReturnType<typeof parseCronExpression>;
      try {
        cron = parseCronExpression(schedule.cron);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Invalid cron expression '${schedule.cron}': ${msg}`);
      }
      const fireTimes: number[] = [];
      let cursor = new Date();
      for (let i = 0; i < 3; i++) {
        const next = cron.getNextDate(cursor);
        fireTimes.push(Math.floor(next.getTime() / 1000));
        cursor = next;
      }
      for (let i = 1; i < fireTimes.length; i++) {
        if (fireTimes[i] - fireTimes[i - 1] < MIN_INTERVAL_SECONDS) {
          throw new Error(`cron schedule fires too frequently; minimum gap is ${MIN_INTERVAL_SECONDS} seconds`);
        }
      }
      cronExpression = schedule.cron;
      nextRunEpoch = fireTimes[0];
    } else {
      // interval
      intervalSeconds = schedule.intervalSeconds;
      nextRunEpoch = now + schedule.intervalSeconds;
    }

    const sessionTitle = sourceInput.title ?? null;
    const sourceSessionId = sourceInput.source === "fork" ? sourceInput.sourceSessionId : null;

    this.db.exec(
      `INSERT INTO scheduled_sessions (
        id, description, prompt, schedule_type,
        delay_seconds, target_epoch, cron_expression, interval_seconds,
        source_type, source_session_id, session_title,
        next_run_epoch, last_run_epoch, last_session_id,
        run_count, failure_count, stalled_at, last_error,
        created_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, NULL, NULL, ?, ?)`,
      id,
      base.description,
      base.prompt,
      schedule.type,
      delaySeconds,
      targetEpoch,
      cronExpression,
      intervalSeconds,
      sourceInput.source,
      sourceSessionId,
      sessionTitle,
      nextRunEpoch,
      now,
      base.createdBy,
    );

    // Re-arm the DO alarm to the earliest pending fire.
    // rearmScheduledSessionAlarm is async only because it may call
    // ctx.storage.setAlarm/deleteAlarm; we don't await it here because create
    // runs inside a request handler — but fire-and-forget is safe because
    // alarms are serialized with input gates.
    void this.rearmScheduledSessionAlarm();

    const row = this.readScheduledSessionRow(id);
    if (!row) throw new Error("Failed to read back inserted scheduled session");
    return this.mapScheduledSessionRow(row);
  }

  private listScheduledSessions(): ScheduledSessionRecord[] {
    return this.db.all(
      "SELECT * FROM scheduled_sessions ORDER BY created_at DESC",
    ).map((row) => this.mapScheduledSessionRow(row));
  }

  private readScheduledSessionRow(id: string): SqlRow | null {
    const row = this.db.one("SELECT * FROM scheduled_sessions WHERE id = ?", id);
    return row ?? null;
  }

  private mapScheduledSessionRow(row: SqlRow): ScheduledSessionRecord {
    const toIso = (epoch: unknown): string | null => {
      if (epoch === null || epoch === undefined) return null;
      const n = Number(epoch);
      if (!Number.isFinite(n) || n <= 0) return null;
      return new Date(n * 1000).toISOString();
    };
    return {
      id: String(row.id),
      description: String(row.description),
      prompt: String(row.prompt),
      scheduleType: String(row.schedule_type) as ScheduledSessionType,
      delaySeconds: row.delay_seconds === null ? null : Number(row.delay_seconds),
      targetEpoch: row.target_epoch === null ? null : Number(row.target_epoch),
      cronExpression: row.cron_expression === null ? null : String(row.cron_expression),
      intervalSeconds: row.interval_seconds === null ? null : Number(row.interval_seconds),
      sourceType: String(row.source_type) as ScheduledSessionSource,
      sourceSessionId: row.source_session_id === null ? null : String(row.source_session_id),
      title: row.session_title === null ? null : String(row.session_title),
      nextRunAt: toIso(row.next_run_epoch),
      lastRunAt: toIso(row.last_run_epoch),
      lastSessionId: row.last_session_id === null ? null : String(row.last_session_id),
      runCount: Number(row.run_count ?? 0),
      failureCount: Number(row.failure_count ?? 0),
      stalledAt: toIso(row.stalled_at),
      lastError: row.last_error === null ? null : String(row.last_error),
      createdAt: epochToIso(row.created_at),
      createdBy: String(row.created_by),
    };
  }

  /**
   * Compute the next fire time for a row. For `delayed`/`scheduled` this is
   * a one-shot that completes after firing, so this is only called from the
   * retry path — we use (now + delaySeconds) and (targetEpoch) respectively
   * as "best guess" resurrection times.
   */
  private computeNextRun(row: SqlRow): number {
    const now = nowEpoch();
    const type = String(row.schedule_type) as ScheduledSessionType;
    if (type === "delayed") {
      return now + Number(row.delay_seconds ?? 0);
    }
    if (type === "scheduled") {
      const target = Number(row.target_epoch ?? now);
      return target > now ? target : now + 1;
    }
    if (type === "cron") {
      const cronExpr = String(row.cron_expression ?? "");
      try {
        return Math.floor(parseCronExpression(cronExpr).getNextDate().getTime() / 1000);
      } catch {
        return now + MIN_INTERVAL_SECONDS;
      }
    }
    // interval
    return now + Number(row.interval_seconds ?? MIN_INTERVAL_SECONDS);
  }

  /**
   * Set the DO alarm to fire at the earliest pending work:
   *   - next scheduled-session fire (min next_run_epoch)
   *   - next idle-session sweep (if any idle sessions exist)
   * Clears the alarm when neither bucket has pending work.
   */
  private async rearmAlarm(): Promise<void> {
    const candidates: number[] = [];

    const nextSched = this.db.one(
      "SELECT MIN(next_run_epoch) AS t FROM scheduled_sessions WHERE next_run_epoch IS NOT NULL",
    );
    if (nextSched?.t != null) {
      candidates.push(Number(nextSched.t) * 1000);
    }

    // Only keep the idle sweep armed while there are idle sessions to
    // watch. Empty userbases shouldn't pay for periodic wake-ups.
    const idle = this.db.one(
      "SELECT 1 AS has FROM sessions WHERE status = 'idle' LIMIT 1",
    );
    if (idle?.has != null) {
      candidates.push(Date.now() + IDLE_SWEEP_INTERVAL_SECONDS * 1000);
    }

    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    this.ctx.storage.setAlarm(Math.min(...candidates));
  }

  /**
   * Back-compat shim — older call sites used `rearmScheduledSessionAlarm`
   * before the alarm grew an idle-sweep leg. The two are now equivalent.
   */
  private async rearmScheduledSessionAlarm(): Promise<void> {
    await this.rearmAlarm();
  }

  /**
   * Alarm handler. Serves two buckets of work:
   *   1. Scheduled-session fires (overdue rows in scheduled_sessions).
   *   2. Idle-session sweep — soft-deletes sessions with no prompts that
   *      have been idle for more than IDLE_SESSION_TTL_SECONDS.
   *
   * The DO input gate serialises alarm() with fetch handlers, so a
   * concurrent DELETE can't interleave between rows. The per-iteration
   * row re-read guards against an earlier iteration in THIS same alarm
   * having mutated the row (e.g. a dependency row deleted mid-batch).
   */
  async alarm(): Promise<void> {
    const ALARM_BATCH_SIZE = 10;
    const now = nowEpoch();
    const dueIds = this.db
      .all(
        "SELECT id FROM scheduled_sessions WHERE next_run_epoch IS NOT NULL AND next_run_epoch <= ? ORDER BY next_run_epoch LIMIT ?",
        now,
        ALARM_BATCH_SIZE,
      )
      .map((row) => String(row.id));

    // alarm() already holds the DO input gate, so fetch handlers can't
    // interleave between rows. Re-read the row each iteration to guard
    // against an alarm-internal mutation (e.g. a previous iteration that
    // deleted a dependency row).
    for (const rowId of dueIds) {
      const row = this.readScheduledSessionRow(rowId);
      if (!row) continue;
      if (row.stalled_at !== null && row.stalled_at !== undefined) continue;
      if (row.next_run_epoch === null || Number(row.next_run_epoch) > nowEpoch()) continue;
      await this.fireSchedule(row);
    }

    // Re-arm: if more rows are overdue beyond the batch, fire again in ~1s.
    const remainingOverdue = this.db.one(
      "SELECT MIN(next_run_epoch) AS t FROM scheduled_sessions WHERE next_run_epoch IS NOT NULL AND next_run_epoch <= ?",
      nowEpoch(),
    );
    if (remainingOverdue?.t != null) {
      this.ctx.storage.setAlarm(Date.now() + 1000);
      return;
    }

    // Idle-session sweep runs on every alarm fire once the scheduled
    // bucket is drained. Cheap when there's nothing idle (SQL-only) and
    // bounded by IDLE_SWEEP_BATCH_SIZE when there is.
    await this.sweepIdleSessions();

    // Replay any MCP token writes that didn't make it to SharedIndex on
    // their original create call (audit finding M15). Idempotent on the
    // index side; bounded LIMIT keeps wake-ups cheap.
    await this.reconcileUnsyncedMcpTokens();

    await this.rearmAlarm();
  }

  /**
   * Soft-delete sessions that have been idle for at least
   * IDLE_SESSION_TTL_SECONDS *and* never received a prompt. The "no
   * prompts" check requires a per-session cross-DO call to the
   * CodingAgent, so we bound the batch size to keep wake-ups cheap.
   *
   * The sweep intentionally skips sessions already in the `deleted`
   * bucket (those are purged on listSessions) and anything in `running`
   * (an in-flight prompt bumps status beyond `idle`).
   */
  private async sweepIdleSessions(): Promise<void> {
    const cutoff = nowEpoch() - IDLE_SESSION_TTL_SECONDS;
    const candidates = this.db.all(
      "SELECT id FROM sessions WHERE status = 'idle' AND updated_at < ? ORDER BY updated_at ASC LIMIT ?",
      cutoff,
      IDLE_SWEEP_BATCH_SIZE,
    );

    for (const row of candidates) {
      const sessionId = String(row.id);
      let promptCount: number;
      try {
        promptCount = await this.countSessionPrompts(sessionId);
      } catch (err) {
        // If the CodingAgent DO is unreachable, leave the session alone —
        // better to retry next sweep than to delete blindly.
        log("warn", "idle-sweep: failed to count prompts", {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (promptCount > 0) continue;

      // Reuse the same soft-delete primitive as the manual DELETE path
      // so the 5-min recovery window behaves identically.
      const deleteExpiry = nowEpoch() + 300;
      this.db.exec(
        "UPDATE sessions SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?",
        deleteExpiry,
        nowEpoch(),
        sessionId,
      );
      this.emitUserEvent({ type: "sessions_changed", reason: "deleted", sessionId });
      log("info", "idle-sweep: soft-deleted empty idle session", { sessionId });
    }
  }

  /**
   * Ask a session's CodingAgent DO how many prompts it holds. Uses the
   * lightweight /prompts/count endpoint — a GET of /prompts would
   * serialise the whole list, which can be 100s of rows.
   */
  private async countSessionPrompts(sessionId: string): Promise<number> {
    const agent = await getAgentByName(this.env.CODING_AGENT as never, sessionId);
    const res = await agent.fetch(
      new Request("https://coding-agent/prompts/count", { method: "GET" }),
    );
    if (!res.ok) {
      throw new Error(`prompt count fetch failed: ${res.status}`);
    }
    const body = (await res.json()) as { count?: number };
    return Number(body.count ?? 0);
  }

  /**
   * Fire a single scheduled-session row.
   *
   * Creates the session (fresh or fork), dispatches the prompt to the new
   * CodingAgent, and updates the row with run stats. On failure, bumps
   * failure_count; after MAX_FAILURES the row is marked stalled.
   */
  private async fireSchedule(row: SqlRow): Promise<void> {
    const id = String(row.id);
    const scheduleType = String(row.schedule_type) as ScheduledSessionType;
    const sourceType = String(row.source_type) as ScheduledSessionSource;
    const ownerEmail = this.getOwnerEmail();

    if (!ownerEmail) {
      // Can't fire without an owner email to attribute the session to.
      // Mark stalled so the user notices — probably onboarding hasn't
      // completed yet.
      this.db.exec(
        "UPDATE scheduled_sessions SET failure_count = failure_count + 1, last_error = ?, stalled_at = ?, next_run_epoch = NULL WHERE id = ?",
        "owner_email not established",
        nowEpoch(),
        id,
      );
      this.emitUserEvent({ type: "scheduled_session_fired", id, ok: false, error: "owner_email not established" });
      return;
    }

    // Rate-limit check. 60 fires per owner per hour — matches the interactive
    // limit *shape* but is a separate in-memory budget (see scheduledFireLimiter
    // field comment). Effective cap is 120/hr combined: interactive + scheduled.
    const rl = this.scheduledFireLimiter.check(`prompt:${ownerEmail}`, 60, 60 * 60 * 1000);
    if (!rl.allowed) {
      // Bump failure_count on rate-limit so an entire batch hitting the
      // limit eventually stalls (and a human gets paged) instead of the DO
      // alarm ping-ponging on the same row every few seconds.
      // (audit finding M9)
      const retryAfter = rl.retryAfter ?? 60;
      // Add a small jitter so siblings on the same DO don't all retry on
      // the same tick once the window opens.
      const jitter = Math.floor(Math.random() * 30);
      const nextRun = nowEpoch() + retryAfter + jitter;
      this.db.exec(
        "UPDATE scheduled_sessions SET next_run_epoch = ?, last_error = ?, failure_count = failure_count + 1 WHERE id = ?",
        nextRun,
        "rate_limited",
        id,
      );
      this.emitUserEvent({ type: "scheduled_session_fired", id, ok: false, error: "rate_limited" });
      return;
    }

    const title = row.session_title === null || row.session_title === undefined
      ? null
      : String(row.session_title);

    try {
      // 1. Create the session
      let newSessionId: string;
      if (sourceType === "fresh") {
        newSessionId = this.registerScheduledFreshSession(ownerEmail, title);
      } else {
        const sourceSessionId = row.source_session_id === null ? null : String(row.source_session_id);
        if (!sourceSessionId) throw new Error("fork schedule has no source_session_id");
        newSessionId = await this.forkScheduledSession(ownerEmail, sourceSessionId, title);
      }

      // 2. Dispatch the prompt using the owner's CURRENT config
      //    (not the config at create time — matches interactive prompt
      //    behaviour).
      const config = this.readConfig();
      const prompt = String(row.prompt);
      // Audit trail: prefer the schedule's `created_by` so we can trace
      // which human configured the schedule, even after re-shares or
      // permission revocations. Falls back to the owner. (audit finding M4)
      const createdBy = row.created_by === null || row.created_by === undefined
        ? ownerEmail
        : String(row.created_by);
      const agent = await getAgentByName(this.env.CODING_AGENT as never, newSessionId);
      const dispatchRes = await agent.fetch(
        new Request("https://coding-agent/prompt", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-dodo-session-id": newSessionId,
            "x-dodo-ai-base-url": config.aiGatewayBaseURL,
            "x-dodo-gateway": config.activeGateway,
            "x-dodo-model": config.model,
            "x-dodo-opencode-base-url": config.opencodeBaseURL,
            // Mark the source explicitly so logs can distinguish scheduled
            // fires from interactive prompts. The createdBy field is the
            // real human; "scheduled-session" is the trigger label.
            "x-author-email": `scheduled-session:${createdBy}`,
            "x-owner-email": ownerEmail,
          },
          body: JSON.stringify({ content: prompt }),
        }),
      );

      if (!dispatchRes.ok) {
        const body = await dispatchRes.text();
        throw new Error(`prompt dispatch failed (${dispatchRes.status}): ${body.slice(0, 200)}`);
      }

      // 3. Success: update stats + compute next run (or delete if one-shot)
      this.onScheduleSuccess(id, newSessionId, scheduleType, row);
      this.emitUserEvent({ type: "scheduled_session_fired", id, ok: true, lastSessionId: newSessionId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isSourceMissing = error instanceof SourceSessionMissingError;
      this.onScheduleFailure(id, isSourceMissing ? "source_session_missing" : message);
      this.emitUserEvent({ type: "scheduled_session_fired", id, ok: false, error: message });
    }
  }

  /** Register a fresh session row directly in this DO's session table.
   *  Avoids DO-to-self round-tripping which would deadlock under the
   *  alarm's input gate. */
  private registerScheduledFreshSession(ownerEmail: string, title: string | null): string {
    const sessionId = crypto.randomUUID();
    const now = nowEpoch();
    this.db.exec(
      "INSERT INTO sessions (id, title, status, owner_email, created_by, created_at, updated_at) VALUES (?, ?, 'idle', ?, ?, ?, ?)",
      sessionId,
      title,
      ownerEmail,
      "scheduled-session",
      now,
      now,
    );
    this.emitUserEvent({ type: "sessions_changed", reason: "created", sessionId });
    return sessionId;
  }

  /** Fork an existing session into a new one, driven from inside the DO.
   *  Uses local fork_snapshots storage (same as the external helper) but
   *  avoids calling back into this DO via the stub (which would deadlock). */
  private async forkScheduledSession(
    ownerEmail: string,
    sourceSessionId: string,
    title: string | null,
  ): Promise<string> {
    // Verify the source session exists in THIS DO. Scheduled sessions can
    // only fork from sessions owned by the same user — the create-time
    // permission check already ensured the caller had write on the source.
    const sourceRow = this.db.one("SELECT id FROM sessions WHERE id = ?", sourceSessionId);
    if (!sourceRow) {
      throw new SourceSessionMissingError(sourceSessionId);
    }

    // Snapshot the source agent.
    const sourceAgent = await getAgentByName(this.env.CODING_AGENT as never, sourceSessionId);
    const snapshotRes = await sourceAgent.fetch(
      new Request("https://coding-agent/snapshot", { method: "GET" }),
    );
    if (!snapshotRes.ok) {
      throw new Error(`snapshot of source session failed (${snapshotRes.status})`);
    }
    const snapshotPayload = await snapshotRes.text();

    // Store snapshot in local fork_snapshots table.
    const snapshotId = crypto.randomUUID();
    this.db.exec(
      "INSERT INTO fork_snapshots (id, payload, created_at) VALUES (?, ?, ?)",
      snapshotId,
      snapshotPayload,
      nowEpoch(),
    );

    // Register the new session.
    const sessionId = this.registerScheduledFreshSession(ownerEmail, title);

    // Ask the target agent to import the snapshot.
    let importOk = false;
    try {
      const targetAgent = await getAgentByName(this.env.CODING_AGENT as never, sessionId);
      const importRes = await targetAgent.fetch(
        new Request(
          `https://coding-agent/snapshot/import?snapshotId=${encodeURIComponent(snapshotId)}`,
          {
            method: "POST",
            headers: {
              "x-dodo-session-id": sessionId,
              "x-owner-email": ownerEmail,
            },
          },
        ),
      );
      if (!importRes.ok) {
        const body = await importRes.text();
        throw new Error(`snapshot import failed (${importRes.status}): ${body.slice(0, 200)}`);
      }
      importOk = true;
    } finally {
      // Always clean up the snapshot row.
      this.db.exec("DELETE FROM fork_snapshots WHERE id = ?", snapshotId);
    }

    if (!importOk) throw new Error("fork import did not complete");
    return sessionId;
  }

  private onScheduleSuccess(
    id: string,
    newSessionId: string,
    scheduleType: ScheduledSessionType,
    row: SqlRow,
  ): void {
    const now = nowEpoch();
    if (scheduleType === "delayed" || scheduleType === "scheduled") {
      // One-shot complete — delete the row entirely.
      this.db.exec("DELETE FROM scheduled_sessions WHERE id = ?", id);
      return;
    }

    // Recurring — compute next fire time.
    let nextRun: number;
    if (scheduleType === "cron") {
      const cronExpr = String(row.cron_expression ?? "");
      try {
        nextRun = Math.floor(parseCronExpression(cronExpr).getNextDate().getTime() / 1000);
      } catch {
        nextRun = now + MIN_INTERVAL_SECONDS;
      }
    } else {
      // interval
      nextRun = now + Number(row.interval_seconds ?? MIN_INTERVAL_SECONDS);
    }

    this.db.exec(
      `UPDATE scheduled_sessions
         SET last_run_epoch = ?,
             last_session_id = ?,
             run_count = run_count + 1,
             failure_count = 0,
             last_error = NULL,
             stalled_at = NULL,
             next_run_epoch = ?
       WHERE id = ?`,
      now,
      newSessionId,
      nextRun,
      id,
    );
  }

  private onScheduleFailure(id: string, errorMessage: string): void {
    const now = nowEpoch();
    const row = this.readScheduledSessionRow(id);
    if (!row) return;

    const failureCount = Number(row.failure_count ?? 0) + 1;

    if (failureCount >= MAX_FAILURES) {
      // Stall — next_run_epoch NULL so alarm() skips it until manual retry.
      this.db.exec(
        "UPDATE scheduled_sessions SET failure_count = ?, last_error = ?, stalled_at = ?, next_run_epoch = NULL WHERE id = ?",
        failureCount,
        errorMessage.slice(0, 500),
        now,
        id,
      );
      return;
    }

    // Exponential backoff: 60s, 120s, 240s, 480s, capped at 3600s.
    const backoff = Math.min(60 * 2 ** failureCount, 3600);
    this.db.exec(
      "UPDATE scheduled_sessions SET failure_count = ?, last_error = ?, next_run_epoch = ? WHERE id = ?",
      failureCount,
      errorMessage.slice(0, 500),
      now + backoff,
      id,
    );
  }

  // ─── User-level SSE ───

  private openUserEventStream(request: Request): Response {
    const stream = new TransformStream<Uint8Array>();
    const writer = stream.writable.getWriter();
    this.sseClients.set(writer, Promise.resolve());

    // Send initial ready event with session count
    void this.writeUserEvent(writer, { type: "ready", sessionCount: this.listSessions().length });

    request.signal.addEventListener(
      "abort",
      () => {
        this.sseClients.delete(writer);
        try { void writer.close(); } catch { /* stream may already be closed */ }
      },
      { once: true },
    );

    return new Response(stream.readable, {
      headers: {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      },
    });
  }

  private async writeUserEvent(writer: WritableStreamDefaultWriter<Uint8Array>, event: Record<string, unknown>): Promise<void> {
    const eventType = String(event.type ?? "message");
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`;
    await writer.write(new TextEncoder().encode(payload));
  }

  private emitUserEvent(event: Record<string, unknown>): void {
    for (const [writer, pending] of [...this.sseClients]) {
      const next = pending
        .then(() => this.writeUserEvent(writer, event))
        .catch(() => {
          this.sseClients.delete(writer);
        });
      this.sseClients.set(writer, next);
    }
  }
}
