import { Workspace, createWorkspaceStateBackend } from "@cloudflare/shell";
import { type Connection, type ConnectionContext, type WSMessage } from "agents";
import type { LanguageModel, ToolSet } from "ai";
import { z } from "zod";
import { buildProvider, buildToolsForThink } from "./agentic";
import { getUserControlStub } from "./auth";
import { sendNotification } from "./notify";
import { runSandboxedCode } from "./executor";
import { createWorkspaceGit, defaultAuthor, resolveRemoteToken } from "./git";
import { PresenceTracker } from "./presence";
import { AgentConnectionTransport } from "./rpc-transport";
import { epochToIso, nowEpoch, SqlHelper } from "./sql-helpers";
import {
  Think,
  type DodoConfig,
  type FiberCompleteContext,
  type FiberRecoveryContext,
  type MessageMetadata,
  type StreamCallback,
  type UIMessage,

  uiMessageToChatRecord,
  chatRecordToUIMessage,
} from "./think-adapter";
import type { SnapshotV2 } from "./think-adapter";
import type { AppConfig, ChatMessageRecord, CronJobRecord, Env, PromptRecord, SessionEvent, SessionSnapshot, SessionState, WorkspaceEntry } from "./types";

const sendMessageSchema = z.object({ content: z.string().trim().min(1) }).strict();
const executeCodeSchema = z.object({ code: z.string().trim().min(1) }).strict();
const gitCommitSchema = z.object({ dir: z.string().optional(), message: z.string().trim().min(1) }).strict();
const gitCloneSchema = z.object({ branch: z.string().optional(), depth: z.number().int().nonnegative().optional(), dir: z.string().optional(), singleBranch: z.boolean().optional(), url: z.string().url() }).strict();
const gitDirSchema = z.object({ dir: z.string().optional(), filepath: z.string().optional() }).strict();
const gitBranchSchema = z.object({ delete: z.string().optional(), dir: z.string().optional(), list: z.boolean().optional(), name: z.string().optional() }).strict();
const gitCheckoutSchema = z.object({ branch: z.string().optional(), dir: z.string().optional(), force: z.boolean().optional(), ref: z.string().optional() }).strict();
const gitRemoteSchema = z.object({ add: z.object({ name: z.string().min(1), url: z.string().url() }).optional(), dir: z.string().optional(), list: z.boolean().optional(), remove: z.string().optional() }).strict();
const cronCreateSchema = z.discriminatedUnion("type", [
  z.object({ description: z.string().min(1), prompt: z.string().min(1), type: z.literal("delayed"), delayInSeconds: z.number().int().positive() }).strict(),
  z.object({ description: z.string().min(1), prompt: z.string().min(1), type: z.literal("scheduled"), date: z.string().datetime() }).strict(),
  z.object({ description: z.string().min(1), prompt: z.string().min(1), type: z.literal("cron"), cron: z.string().min(1) }).strict(),
  z.object({ description: z.string().min(1), prompt: z.string().min(1), type: z.literal("interval"), intervalSeconds: z.number().int().positive() }).strict(),
]);
const replaceFileSchema = z.object({ replacement: z.string(), search: z.string().min(1) }).strict();
const searchFilesSchema = z.object({ pattern: z.string().min(1), query: z.string().default("") }).strict();
const writeFileSchema = z.object({ content: z.string(), mimeType: z.string().optional() }).strict();

/**
 * Sanitize workspace filesystem timestamps.
 * Container filesystems can report epoch-zero or overflow timestamps that
 * serialize to dates thousands of years in the future. Return null for those
 * instead of corrupted ISO strings.
 */
function sanitizeTimestamp(epochSeconds: number): string | null {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return null;
  // Reject dates beyond year 2100 — almost certainly a filesystem bug
  if (epochSeconds > 4_102_444_800) return null;
  return new Date(epochSeconds * 1000).toISOString();
}

const SYSTEM_PROMPT = [
  "You are Dodo, an autonomous coding agent running on Cloudflare Workers.",
  "You help users build, modify, and understand software projects inside a sandboxed workspace.",
  "",
  "## Tone and style",
  "",
  "Be concise and direct. Prefer concrete actions over long explanations.",
  "Use GitHub-flavored markdown for formatting.",
  "Only use emojis if the user explicitly requests them.",
  "Never create files unless necessary to achieve the goal — prefer editing existing files.",
  "",
  "## Doing tasks",
  "",
  "When the user asks you to build or modify code:",
  "",
  "1. **Read before writing.** Always read a file before editing it. Understand existing code before suggesting changes.",
  "2. **Plan multi-step work.** For non-trivial tasks, outline your approach before diving in. State what you'll do, then do it.",
  "3. **Stay focused.** Only make changes that are directly requested or clearly necessary. Don't refactor surrounding code, add comments to unchanged lines, or introduce abstractions for one-time operations.",
  "4. **Delete unused code.** If something is no longer needed, remove it completely. No commented-out code, no `_unused` renames.",
  "5. **Be security-conscious.** Don't introduce command injection, XSS, SQL injection, or other common vulnerabilities. Never commit secrets or credentials.",
  "",
  "## Workspace tools",
  "",
  "You have workspace tools for file operations:",
  "- **read_file** — read a file's contents",
  "- **write_file** — create or overwrite a file",
  "- **search_files** — search by glob pattern and content query",
  "- **replace_in_file** — find and replace within a file",
  "",
  "Use these tools for all file operations. Prefer `replace_in_file` for targeted edits over rewriting entire files.",
  "",
  "## Code execution",
  "",
  "The **codemode** tool runs JavaScript in a sandboxed Worker with access to the workspace filesystem and git.",
  "Use it for:",
  "- Running build scripts, tests, or one-off computations",
  "- Calling external APIs via fetch() (GitHub and GitLab have auth injected automatically)",
  "- Complex file transformations that are easier to express in code",
  "",
  "The sandbox has a 30-second timeout and no access to the network except explicitly allowed hosts.",
  "",
  "## Git",
  "",
  "You have git tools: git_clone, git_status, git_add, git_commit, git_push, git_pull,",
  "git_branch, git_checkout, git_diff, git_log.",
  "Authentication for GitHub and GitLab is automatic — you do NOT need tokens.",
  "",
  "### Git safety rules",
  "",
  "- Always run git_status before committing to understand what will be staged.",
  "- Stage specific files rather than using '.' when possible, to avoid committing unintended changes.",
  "- Write clear, concise commit messages that explain *why*, not just *what*.",
  "- Never force-push unless the user explicitly asks.",
  "- Check git_log to match the repository's commit message style.",
  "",
  "## Working with errors",
  "",
  "When something fails:",
  "1. State what failed and why.",
  "2. Fix it or suggest a fix.",
  "3. Move on. Don't apologize repeatedly or over-explain.",
  "",
  "## Limits",
  "",
  "- You have a maximum of 10 tool-call steps per prompt. Plan efficiently.",
  "- The workspace is ephemeral per session. Clone repos if you need their contents.",
  "- You cannot install system packages or run shell commands directly — use codemode for computation.",
].join("\n");

/** Build a LanguageModel from DodoConfig (Think per-session config). */
function buildProviderFromConfig(config: DodoConfig, env: Env): LanguageModel {
  const appConfig: AppConfig = {
    activeGateway: config.activeGateway,
    aiGatewayBaseURL: config.aiGatewayBaseURL,
    gitAuthorEmail: env.GIT_AUTHOR_EMAIL ?? "dodo@example.com",
    gitAuthorName: env.GIT_AUTHOR_NAME ?? "Dodo",
    model: config.model,
    opencodeBaseURL: config.opencodeBaseURL,
  };
  return buildProvider(appConfig, env).chatModel(config.model);
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error("Path is required");
  }

  const raw = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const segments = raw.split("/").filter(Boolean);
  const resolved: string[] = [];

  for (const segment of segments) {
    if (segment === "..") {
      throw new Error("Parent path traversal is not allowed");
    }
    if (segment !== ".") {
      resolved.push(segment);
    }
  }

  return `/${resolved.join("/")}`;
}

export class CodingAgent extends Think<Env, DodoConfig> {
  initialState: SessionState = {
    activePromptId: null,
    activeStreamCount: 0,
    createdAt: "",
    messageCount: 0,
    sessionId: "",
    status: "idle",
    totalTokenInput: 0,
    totalTokenOutput: 0,
    updatedAt: "",
  };

  /** Enable durable fiber recovery for async prompts. */
  override fibers = true;

  private readonly clients = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private readonly db: SqlHelper;
  private readonly presence = new PresenceTracker();
  readonly stateBackend;
  private readonly transports = new Map<string, AgentConnectionTransport>();
  readonly workspace: Workspace;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new SqlHelper(ctx.storage.sql);
    this.initializeSchema();
    this.workspace = new Workspace({
      name: () => this.sessionId() || "session-pending",
      r2: env.WORKSPACE_BUCKET,
      sql: ctx.storage.sql,
    });
    this.stateBackend = createWorkspaceStateBackend(this.workspace);
  }

  // ─── Think overrides ───

  override getModel(): LanguageModel {
    const config = this.getConfig();
    if (!config) {
      throw new Error("getModel(): no Think config — session not configured yet");
    }
    return buildProviderFromConfig(config, this.env);
  }

  override getSystemPrompt(): string {
    return SYSTEM_PROMPT;
  }

  override getTools(): ToolSet {
    const appConfig = this.getAppConfigFromThink();
    return buildToolsForThink(this.env, this.workspace, appConfig, {
      ownerEmail: this.readMetadata("owner_email") ?? undefined,
      stateBackend: this.stateBackend,
    });
  }

  /** Build an AppConfig from Think's per-session config, falling back to env defaults. */
  private getAppConfigFromThink(): AppConfig {
    const config = this.getConfig();
    if (config) {
      return {
        activeGateway: config.activeGateway,
        aiGatewayBaseURL: config.aiGatewayBaseURL,
        gitAuthorEmail: this.env.GIT_AUTHOR_EMAIL ?? "dodo@example.com",
        gitAuthorName: this.env.GIT_AUTHOR_NAME ?? "Dodo",
        model: config.model,
        opencodeBaseURL: config.opencodeBaseURL,
      };
    }
    return {
      activeGateway: "opencode",
      aiGatewayBaseURL: this.env.AI_GATEWAY_BASE_URL,
      gitAuthorEmail: this.env.GIT_AUTHOR_EMAIL ?? "dodo@example.com",
      gitAuthorName: this.env.GIT_AUTHOR_NAME ?? "Dodo",
      model: this.env.DEFAULT_MODEL,
      opencodeBaseURL: this.env.OPENCODE_BASE_URL,
    };
  }

  override getMaxSteps(): number {
    return 10;
  }

  override getWorkspace(): Workspace {
    return this.workspace;
  }

  override onStart(): void {
    // Initialize Think: creates SessionManager, loads existing sessions,
    // sets up protocol handlers, checks fibers if enabled.
    super.onStart();

    // Suppress Think's WebSocket chat protocol.
    // super.onStart() wraps onMessage via _setupProtocolHandlers() to intercept
    // cf_agent_chat_* messages. We re-wrap onMessage to skip those protocol
    // messages entirely, routing everything through Dodo's own handlers.
    const thinkWrappedOnMessage = this.onMessage.bind(this);
    this.onMessage = async (connection: Connection, message: WSMessage) => {
      if (typeof message === "string") {
        try {
          const data = JSON.parse(message);
          // Block Think's chat protocol messages
          if (data.type === "cf_agent_use_chat_request" ||
              data.type === "cf_agent_chat_clear" ||
              data.type === "cf_agent_chat_request_cancel") {
            return;
          }
        } catch {
          // Not JSON — let it through
        }
      }
      return thinkWrappedOnMessage(connection, message);
    };

    // Enforce single Think session per Dodo DO
    this.ensureSingleThinkSession();

    // Dodo's existing init logic
    const details = this.readSessionDetails();
    this.setState({
      ...(this.state as SessionState),
      ...details,
      activeStreamCount: this.clients.size,
      messageCount: this.messageCount(),
    } as never);
  }

  /**
   * Ensure exactly one Think session exists per Dodo DO.
   * Called from onStart() after super.onStart() initializes SessionManager.
   */
  private ensureSingleThinkSession(): void {
    const existing = this.sessions.list();
    if (existing.length === 0) {
      // No session yet — create one. super.onStart() may have already
      // created one if there were existing sessions, but not if the DO is fresh.
      if (!this.getCurrentSessionId()) {
        this.createSession("default");
      }
    } else if (existing.length > 1) {
      // Multiple sessions — use most recent, delete extras
      console.warn(`CodingAgent: found ${existing.length} Think sessions, expected 1. Using most recent.`);
      const sorted = [...existing].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      // Switch to the most recent
      this.switchSession(sorted[0].id);
      for (let i = 1; i < sorted.length; i++) {
        this.sessions.delete(sorted[i].id);
      }
    }
    // If exactly 1 exists, super.onStart() already loaded it
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/ws") {
        // Non-WebSocket request to the WS endpoint
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }

      if (request.method === "GET" && url.pathname === "/") {
        return Response.json(this.readSessionDetails());
      }

      if (request.method === "DELETE" && url.pathname === "/") {
        const ownerEmail = request.headers.get("x-owner-email");
        if (ownerEmail && !this.readMetadata("owner_email")) {
          this.writeMetadata("owner_email", ownerEmail);
        }
        const sid = this.sessionId();
        await this.syncSessionIndex({ status: "deleted" });
        await this.destroyStorage();
        return Response.json({ deleted: true, sessionId: sid });
      }

      if (request.method === "GET" && url.pathname === "/messages") {
        return Response.json({ messages: this.listMessages() });
      }

      if (request.method === "GET" && url.pathname === "/prompts") {
        return Response.json({ prompts: this.listPrompts() });
      }

      if (request.method === "GET" && url.pathname === "/cron") {
        return Response.json({ jobs: this.listCronJobs() });
      }

      if (request.method === "POST" && url.pathname === "/cron") {
        return await this.handleCreateCron(request);
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/cron/")) {
        return await this.handleDeleteCron(url.pathname.split("/").at(-1) ?? "");
      }

      if (request.method === "GET" && url.pathname === "/snapshot") {
        return Response.json(await this.exportSnapshot());
      }

      if (request.method === "POST" && (url.pathname === "/snapshot" || url.pathname === "/snapshot/import")) {
        return await this.handleImportSnapshot(request);
      }

      if (request.method === "GET" && url.pathname === "/events") {
        return await this.openEventStream(request);
      }

      if (request.method === "GET" && url.pathname === "/browser") {
        const enabled = this.readMetadata("browser_enabled") === "true";
        const sid = this.sessionId() || request.headers.get("x-dodo-session-id") || "";
        return Response.json({ browserEnabled: enabled, sessionId: sid });
      }

      if (request.method === "PUT" && url.pathname === "/browser") {
        const body = (await request.json()) as { enabled?: boolean };
        const enabled = Boolean(body.enabled);
        this.writeMetadata("browser_enabled", String(enabled));
        const sid = this.sessionId() || request.headers.get("x-dodo-session-id") || "";
        return Response.json({ browserEnabled: enabled, sessionId: sid });
      }

      if (request.method === "GET" && url.pathname === "/files") {
        return await this.handleListFiles(url);
      }

      if (request.method === "GET" && url.pathname === "/file") {
        return await this.handleReadFile(url);
      }

      if (request.method === "PUT" && url.pathname === "/file") {
        return await this.handleWriteFile(request, url);
      }

      if (request.method === "PATCH" && url.pathname === "/file") {
        return await this.handleReplaceInFile(request, url);
      }

      if (request.method === "DELETE" && url.pathname === "/file") {
        return await this.handleDeleteFile(url);
      }

      if (request.method === "POST" && url.pathname === "/search") {
        return await this.handleSearchFiles(request);
      }

      if (request.method === "POST" && url.pathname === "/execute") {
        return await this.handleExecute(request);
      }

      if (request.method === "GET" && url.pathname === "/git/status") {
        return await this.handleGitStatus(url);
      }

      if (request.method === "GET" && url.pathname === "/git/log") {
        return await this.handleGitLog(url);
      }

      if (request.method === "GET" && url.pathname === "/git/diff") {
        return await this.handleGitDiff(url);
      }

      if (request.method === "POST" && url.pathname === "/git/init") {
        return await this.handleGitInit(request);
      }

      if (request.method === "POST" && url.pathname === "/git/clone") {
        return await this.handleGitClone(request);
      }

      if (request.method === "POST" && url.pathname === "/git/add") {
        return await this.handleGitAdd(request);
      }

      if (request.method === "POST" && url.pathname === "/git/commit") {
        return await this.handleGitCommit(request);
      }

      if (request.method === "POST" && url.pathname === "/git/branch") {
        return await this.handleGitBranch(request);
      }

      if (request.method === "POST" && url.pathname === "/git/checkout") {
        return await this.handleGitCheckout(request);
      }

      if (request.method === "POST" && url.pathname === "/git/pull") {
        return await this.handleGitPull(request);
      }

      if (request.method === "POST" && url.pathname === "/git/push") {
        return await this.handleGitPush(request);
      }

      if (request.method === "POST" && url.pathname === "/git/remote") {
        return await this.handleGitRemote(request);
      }

      // ─── Approval Queue ───

      if (request.method === "GET" && url.pathname === "/approvals") {
        return Response.json({ approvals: this.listApprovals() });
      }

      if (request.method === "POST" && url.pathname.match(/^\/approvals\/[^/]+\/approve$/)) {
        const approvalId = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
        const resolvedBy = request.headers.get("x-author-email") ?? request.headers.get("x-owner-email") ?? undefined;
        return Response.json(this.resolveApproval(approvalId, "approved", resolvedBy));
      }

      if (request.method === "POST" && url.pathname.match(/^\/approvals\/[^/]+\/reject$/)) {
        const approvalId = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
        const resolvedBy = request.headers.get("x-author-email") ?? request.headers.get("x-owner-email") ?? undefined;
        return Response.json(this.resolveApproval(approvalId, "rejected", resolvedBy));
      }

      if (request.method === "POST" && url.pathname === "/message") {
        return await this.handleMessage(request);
      }

      if (request.method === "POST" && url.pathname === "/prompt") {
        return await this.handlePrompt(request);
      }

      if (request.method === "POST" && url.pathname === "/abort") {
        return await this.handleAbort();
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected request failure";
      return Response.json({ error: message }, { status: 400 });
    }
  }

  // ─── WebSocket lifecycle (Agent SDK / partyserver) ───

  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const url = new URL(ctx.request.url);
    const email = url.searchParams.get("email") ?? "anonymous";
    const displayName = url.searchParams.get("displayName") ?? email;
    const permission = url.searchParams.get("permission") ?? "readwrite";
    const lastMessageCountParam = url.searchParams.get("lastMessageCount");

    // Cap'n Web RPC protocol — store transport for message routing
    if (url.searchParams.get("protocol") === "capnweb") {
      const transport = new AgentConnectionTransport(connection);
      this.transports.set(connection.id, transport);
      // Future: create RpcSession with transport and wire to DodoPublicApi
      // For now, the transport is stored so onMessage can route to it.
      return;
    }

    this.presence.join(connection.id, {
      connectedAt: Date.now(),
      displayName,
      email,
      permission,
    });

    // Determine which messages to send in the ready payload.
    // If the client provides lastMessageCount (reconnection), only send
    // messages they haven't seen yet. Otherwise send the last 50.
    const allMessages = this.listMessages();
    let messages: ChatMessageRecord[];
    if (lastMessageCountParam !== null) {
      const lastCount = Math.max(0, parseInt(lastMessageCountParam, 10) || 0);
      messages = allMessages.slice(lastCount);
    } else {
      messages = allMessages.slice(-50);
    }

    const readyPayload = JSON.stringify({
      type: "ready",
      state: this.readSessionDetails(),
      presence: this.presence.getAll(),
      messages,
      totalMessages: allMessages.length,
    });
    connection.send(readyPayload);

    // Broadcast updated presence to all WebSocket clients
    this.broadcastPresence();
  }

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    if (typeof message !== "string") return;

    // Route Cap'n Web RPC messages to the stored transport
    const transport = this.transports.get(connection.id);
    if (transport) {
      transport.deliver(message);
      return;
    }

    this.presence.updateActivity(connection.id);

    let parsed: { type: string; [key: string]: unknown };
    try {
      parsed = JSON.parse(message);
    } catch {
      connection.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
      return;
    }

    // Enforce permission: readonly clients cannot perform write actions
    const writeActions = new Set(["prompt", "message", "abort", "cron-create", "cron-delete", "approval-approve", "approval-reject"]);
    if (writeActions.has(parsed.type)) {
      const permission = this.getConnectionPermission(connection);
      if (permission === "readonly") {
        return; // silently drop — readonly clients cannot perform write actions
      }
    }

    switch (parsed.type) {
      case "ping":
        connection.send(JSON.stringify({ type: "pong" }));
        break;

      case "typing": {
        const isTyping = Boolean(parsed.isTyping);
        this.presence.setTyping(connection.id, isTyping);
        const entry = this.presence.get(connection.id);
        if (entry) {
          this.broadcastToWebSockets(JSON.stringify({
            type: "typing",
            email: entry.email,
            isTyping,
          }), connection.id);
        }
        break;
      }

      case "prompt": {
        const content = typeof parsed.content === "string" ? parsed.content.trim() : "";
        if (!content) {
          connection.send(JSON.stringify({ type: "error", error: "Empty prompt content" }));
          return;
        }
        // Delegate to the existing prompt mechanism via internal request
        const entry = this.presence.get(connection.id);
        const promptId = crypto.randomUUID();
        const sessionId = this.sessionId();
        if (!sessionId) {
          connection.send(JSON.stringify({ type: "error", error: "Session not initialized" }));
          return;
        }

        if (this.readMetadata("active_prompt_id")) {
          connection.send(JSON.stringify({ type: "error", error: "A prompt is already running" }));
          return;
        }

        await this.readAppConfig(); // Ensure Think config is populated
        const title = this.readMetadata("title") ?? (content.length > 72 ? content.slice(0, 72) + "…" : content);

        this.writeMetadata("title", title);
        this.writeMetadata("active_prompt_id", promptId);
        this.writeMetadata("status", "running");
        this.insertPrompt(promptId, content, "queued", entry?.email);
        await this.syncSessionIndex({ status: "running", title });
        this.emitEvent({ data: this.readSessionDetails(), type: "state" });

        connection.send(JSON.stringify({ type: "prompt_queued", promptId }));
        // Fiber-backed async prompt
        const fId = this.spawnFiber("runFiberPrompt", {
          promptId,
          content,
          authorEmail: entry?.email,
          title,
        }, { maxRetries: 3 });
        this.setPromptFiberId(promptId, fId);
        break;
      }

      case "abort": {
        const promptId = this.readMetadata("active_prompt_id");
        if (!promptId) {
          connection.send(JSON.stringify({ type: "error", error: "No active prompt" }));
          return;
        }
        // Cancel via fiber
        const fiberId = this.readPromptFiberId(promptId);
        if (fiberId) {
          this.cancelFiber(fiberId);
        }
        await this.finishPrompt(promptId, { error: "Prompt aborted", status: "aborted" });
        connection.send(JSON.stringify({ type: "aborted", promptId }));
        break;
      }

      default:
        connection.send(JSON.stringify({ type: "error", error: `Unknown message type: ${parsed.type}` }));
    }
  }

  async onClose(connection: Connection): Promise<void> {
    // Clean up Cap'n Web transport if present
    const transport = this.transports.get(connection.id);
    if (transport) {
      transport.close();
      this.transports.delete(connection.id);
    }

    const hadEntry = this.presence.has(connection.id);
    this.presence.leave(connection.id);
    if (hadEntry) {
      this.broadcastPresence();
    }
  }

  async onError(connectionOrError: Connection | unknown, error?: unknown): Promise<void> {
    // Handle the Connection overload
    if (connectionOrError && typeof connectionOrError === "object" && "id" in connectionOrError) {
      const connection = connectionOrError as Connection;
      // Clean up Cap'n Web transport if present
      const transport = this.transports.get(connection.id);
      if (transport) {
        transport.abort(error);
        this.transports.delete(connection.id);
      }
      this.presence.leave(connection.id);
      this.broadcastPresence();
    }
  }

  /** Broadcast a JSON message to all connected WebSocket clients (excluding one). */
  private broadcastToWebSockets(message: string, excludeId?: string): void {
    for (const conn of this.getConnections()) {
      if (excludeId && conn.id === excludeId) continue;
      try {
        conn.send(message);
      } catch {
        // connection may have closed
      }
    }
  }

  /** Get the permission level for a WebSocket connection. */
  private getConnectionPermission(connection: Connection): string {
    const entry = this.presence.get(connection.id);
    return entry?.permission ?? "readonly";
  }

  /** Broadcast current presence list to all WebSocket clients. */
  private broadcastPresence(): void {
    const payload = JSON.stringify({
      type: "presence",
      users: this.presence.getAll(),
    });
    this.broadcastToWebSockets(payload);
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Sidecar metadata for Think messages — Dodo-specific fields
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_metadata (
        message_id TEXT PRIMARY KEY,
        author_email TEXT,
        model TEXT,
        provider TEXT,
        token_input INTEGER NOT NULL DEFAULT 0,
        token_output INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        result_message_id TEXT,
        fiber_id TEXT,
        author_email TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        schedule_id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        prompt TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approval_queue (
        id TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        tool_args TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        requested_at INTEGER NOT NULL,
        resolved_at INTEGER,
        resolved_by TEXT
      )
    `);

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_prompts_created ON prompts(created_at)");
  }

  private async handleListFiles(url: URL): Promise<Response> {
    const path = normalizePath(url.searchParams.get("path") ?? "/");
    const entries = await this.workspace.readDir(path);
    return Response.json({ entries: entries.map((entry) => this.mapWorkspaceEntry(entry)) });
  }

  private async handleReadFile(url: URL): Promise<Response> {
    const path = normalizePath(url.searchParams.get("path") ?? "");
    const content = await this.workspace.readFile(path);
    if (content === null) {
      return Response.json({ error: `File not found: ${path}` }, { status: 404 });
    }

    return Response.json({ content, path });
  }

  private async handleWriteFile(request: Request, url: URL): Promise<Response> {
    const path = normalizePath(url.searchParams.get("path") ?? "");
    const body = writeFileSchema.parse(await request.json());
    await this.workspace.writeFile(path, body.content, body.mimeType);
    const content = await this.workspace.readFile(path);
    this.emitEvent({ data: { path, type: "write" }, type: "file" });
    return Response.json({ content, path, written: true });
  }

  private async handleReplaceInFile(request: Request, url: URL): Promise<Response> {
    const path = normalizePath(url.searchParams.get("path") ?? "");
    const body = replaceFileSchema.parse(await request.json());
    const result = await this.stateBackend.replaceInFile(path, body.search, body.replacement);
    this.emitEvent({ data: { path, type: "edit" }, type: "file" });
    return Response.json({ path, result });
  }

  private async handleDeleteFile(url: URL): Promise<Response> {
    const path = normalizePath(url.searchParams.get("path") ?? "");
    if (path === "/") {
      return Response.json({ error: "Cannot delete workspace root" }, { status: 400 });
    }
    await this.workspace.rm(path, { force: true, recursive: true });
    this.emitEvent({ data: { path, type: "delete" }, type: "file" });
    return Response.json({ deleted: true, path });
  }

  private async handleSearchFiles(request: Request): Promise<Response> {
    const body = searchFilesSchema.parse(await request.json());
    const result = await this.stateBackend.searchFiles(body.pattern, body.query);
    return Response.json({ matches: result });
  }

  private async handleExecute(request: Request): Promise<Response> {
    const body = executeCodeSchema.parse(await request.json());
    this.ensureMetadata(this.requireSessionId(request), request.headers.get("x-owner-email"));

    const execution = await runSandboxedCode({
      code: body.code,
      env: this.env,
      workspace: this.workspace,
    });

    this.emitEvent({ data: execution, type: "execution" });
    return Response.json(execution, { status: execution.error ? 400 : 200 });
  }

  private async handleGitInit(request: Request): Promise<Response> {
    const body = gitDirSchema.parse(await request.json());
    const git = createWorkspaceGit(this.workspace);
    const result = await git.init({ defaultBranch: "main", dir: body.dir ? normalizePath(body.dir) : undefined });
    return Response.json(result);
  }

  private async handleGitClone(request: Request): Promise<Response> {
    const body = gitCloneSchema.parse(await request.json());
    const git = createWorkspaceGit(this.workspace);
    const dir = body.dir ? normalizePath(body.dir) : undefined;
    const ownerEmail = request.headers.get("x-owner-email") ?? this.readMetadata("owner_email") ?? undefined;
    const token = await resolveRemoteToken({ dir, env: this.env, git, url: body.url, ownerEmail });
    // depth 0 = full history (pass undefined to isomorphic-git), undefined = shallow default of 1
    const cloneDepth = body.depth === 0 ? undefined : (body.depth ?? 1);
    const result = await git.clone({
      branch: body.branch,
      depth: cloneDepth,
      dir,
      singleBranch: body.singleBranch ?? true,
      token,
      url: body.url,
    });
    return Response.json(result);
  }

  private async handleGitAdd(request: Request): Promise<Response> {
    const body = z.object({ dir: z.string().optional(), filepath: z.string().min(1) }).strict().parse(await request.json());
    const git = createWorkspaceGit(this.workspace);
    try {
      return Response.json(await git.add({ dir: body.dir ? normalizePath(body.dir) : undefined, filepath: body.filepath }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("Could not find HEAD") || msg.includes("NotFoundError") || msg.includes("Could not find .git")) {
        return Response.json({ error: "No git repository found. Run git_init to create one, or git_clone to clone an existing repo." }, { status: 400 });
      }
      return Response.json({ error: msg }, { status: 400 });
    }
  }

  private async handleGitCommit(request: Request): Promise<Response> {
    const body = gitCommitSchema.parse(await request.json());
    const ownerEmail = request.headers.get("x-owner-email");
    if (ownerEmail && !this.readMetadata("owner_email")) {
      this.writeMetadata("owner_email", ownerEmail);
    }
    const git = createWorkspaceGit(this.workspace);
    try {
      const config = await this.readAppConfig();
      const result = await git.commit({ author: defaultAuthor(config), dir: body.dir ? normalizePath(body.dir) : undefined, message: body.message });
      return Response.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Translate common git errors into actionable messages
      if (msg.includes("startsWith") || msg.includes("Could not find HEAD") || msg.includes("NotFoundError")) {
        // Check if git is initialized
        try {
          await git.log({ depth: 1, dir: body.dir ? normalizePath(body.dir) : undefined });
        } catch {
          return Response.json({ error: "No git repository found. Run git_init to create one, or git_clone to clone an existing repo." }, { status: 400 });
        }
        return Response.json({ error: "Nothing to commit. Stage files with git_add before committing." }, { status: 400 });
      }
      return Response.json({ error: msg }, { status: 400 });
    }
  }

  private async handleGitStatus(url: URL): Promise<Response> {
    const git = createWorkspaceGit(this.workspace);
    const dir = url.searchParams.get("dir");
    try {
      const entries = await git.status({ dir: dir ? normalizePath(dir) : undefined });
      return Response.json({ entries });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("Could not find HEAD") || msg.includes("NotFoundError")) {
        return Response.json({ error: "No git repository found. Run git_init to create one, or git_clone to clone an existing repo." }, { status: 400 });
      }
      return Response.json({ error: msg }, { status: 400 });
    }
  }

  private async handleGitLog(url: URL): Promise<Response> {
    const git = createWorkspaceGit(this.workspace);
    const dir = url.searchParams.get("dir");
    const depth = url.searchParams.get("depth");
    try {
      const entries = await git.log({ depth: depth ? Number(depth) : undefined, dir: dir ? normalizePath(dir) : undefined });
      return Response.json({ entries });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("Could not find HEAD") || msg.includes("NotFoundError")) {
        return Response.json({ error: "No git history found. Run git_init to create a repository, or git_clone to clone an existing one." }, { status: 400 });
      }
      return Response.json({ error: msg }, { status: 400 });
    }
  }

  private async handleGitDiff(url: URL): Promise<Response> {
    const git = createWorkspaceGit(this.workspace);
    const dir = url.searchParams.get("dir");
    try {
      const entries = await git.diff({ dir: dir ? normalizePath(dir) : undefined });
      return Response.json({ entries });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("Could not find HEAD") || msg.includes("NotFoundError")) {
        return Response.json({ error: "No git repository found. Run git_init to create one, or git_clone to clone an existing repo." }, { status: 400 });
      }
      return Response.json({ error: msg }, { status: 400 });
    }
  }

  private async handleGitBranch(request: Request): Promise<Response> {
    const body = gitBranchSchema.parse(await request.json());
    const git = createWorkspaceGit(this.workspace);
    return Response.json(await git.branch({ delete: body.delete, dir: body.dir ? normalizePath(body.dir) : undefined, list: body.list, name: body.name }));
  }

  private async handleGitCheckout(request: Request): Promise<Response> {
    const body = gitCheckoutSchema.parse(await request.json());
    const git = createWorkspaceGit(this.workspace);
    return Response.json(
      await git.checkout({ branch: body.branch, dir: body.dir ? normalizePath(body.dir) : undefined, force: body.force, ref: body.ref }),
    );
  }

  private async handleGitPull(request: Request): Promise<Response> {
    const body = z.object({ dir: z.string().optional(), ref: z.string().optional(), remote: z.string().optional() }).strict().parse(await request.json());
    const git = createWorkspaceGit(this.workspace);
    const dir = body.dir ? normalizePath(body.dir) : undefined;
    const ownerEmail = request.headers.get("x-owner-email") ?? this.readMetadata("owner_email") ?? undefined;
    const token = await resolveRemoteToken({ dir, env: this.env, git, remote: body.remote, ownerEmail });
    const config = await this.readAppConfig();
    return Response.json(await git.pull({ author: defaultAuthor(config), dir, ref: body.ref, remote: body.remote, token }));
  }

  private async handleGitPush(request: Request): Promise<Response> {
    const body = z.object({ dir: z.string().optional(), force: z.boolean().optional(), ref: z.string().optional(), remote: z.string().optional() }).strict().parse(await request.json());
    const git = createWorkspaceGit(this.workspace);
    const dir = body.dir ? normalizePath(body.dir) : undefined;
    const ownerEmail = request.headers.get("x-owner-email") ?? this.readMetadata("owner_email") ?? undefined;
    try {
      const token = await resolveRemoteToken({ dir, env: this.env, git, remote: body.remote, ownerEmail });
      return Response.json(await git.push({ dir, force: body.force, ref: body.ref, remote: body.remote, token }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("Could not find HEAD") || msg.includes("NotFoundError")) {
        return Response.json({ error: "No git repository found. Run git_init to create one, or git_clone to clone an existing repo." }, { status: 400 });
      }
      if (msg.includes("remote") || msg.includes("getRemoteInfo")) {
        return Response.json({ error: "No remote configured. Run git_clone to work with a remote repository, or add a remote with git_remote." }, { status: 400 });
      }
      return Response.json({ error: msg }, { status: 400 });
    }
  }

  private async handleGitRemote(request: Request): Promise<Response> {
    const body = gitRemoteSchema.parse(await request.json());
    const git = createWorkspaceGit(this.workspace);
    const dir = body.dir ? normalizePath(body.dir) : undefined;
    return Response.json(
      await git.remote({ add: body.add, dir, list: body.list, remove: body.remove }),
    );
  }

  private async handleCreateCron(request: Request): Promise<Response> {
    const body = cronCreateSchema.parse(await request.json());
    let scheduled;
    if (body.type === "delayed") {
      scheduled = await this.schedule(body.delayInSeconds, "runCronPrompt", { description: body.description, prompt: body.prompt });
    } else if (body.type === "scheduled") {
      scheduled = await this.schedule(new Date(body.date), "runCronPrompt", { description: body.description, prompt: body.prompt });
    } else if (body.type === "cron") {
      scheduled = await this.schedule(body.cron, "runCronPrompt", { description: body.description, prompt: body.prompt });
    } else {
      scheduled = await this.scheduleEvery(body.intervalSeconds, "runCronPrompt", { description: body.description, prompt: body.prompt });
    }

    this.db.exec(
      "INSERT INTO cron_jobs (schedule_id, description, prompt, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(schedule_id) DO UPDATE SET description = excluded.description, prompt = excluded.prompt",
      scheduled.id,
      body.description,
      body.prompt,
      nowEpoch(),
    );

    return Response.json(this.toCronJobRecord(scheduled, body.description, body.prompt), { status: 201 });
  }

  private async handleDeleteCron(scheduleId: string): Promise<Response> {
    const id = decodeURIComponent(scheduleId);
    await this.cancelSchedule(id);
    this.db.exec("DELETE FROM cron_jobs WHERE schedule_id = ?", id);
    return Response.json({ deleted: true, id });
  }

  async runCronPrompt(payload: { description: string; prompt: string }): Promise<void> {
    if (this.readMetadata("active_prompt_id")) {
      return;
    }

    const title = this.readMetadata("title") ?? payload.description;
    const promptId = crypto.randomUUID();
    this.writeMetadata("active_prompt_id", promptId);
    this.writeMetadata("status", "running");
    this.insertPrompt(promptId, payload.prompt, "queued", "cron");

    // Ensure Think config for cron path
    await this.readAppConfig(); // This populates Think config as a side effect
    const fiberId = this.spawnFiber("runFiberPrompt", {
      promptId,
      content: payload.prompt,
      authorEmail: "cron",
      title,
    }, { maxRetries: 3 });
    this.setPromptFiberId(promptId, fiberId);
  }

  private listCronJobs(): CronJobRecord[] {
    return this.db.all("SELECT schedule_id, description, prompt, created_at FROM cron_jobs ORDER BY created_at DESC").map((row) => {
      const schedule = this.getSchedule<{ description: string; prompt: string }>(String(row.schedule_id));
      return this.toCronJobRecord(schedule, String(row.description), String(row.prompt), Number(row.created_at));
    });
  }

  private toCronJobRecord(
    schedule: ReturnType<CodingAgent["getSchedule"]>,
    description: string,
    prompt: string,
    createdAt = nowEpoch(),
  ): CronJobRecord {
    return {
      callback: schedule?.callback ?? "runCronPrompt",
      createdAt: epochToIso(createdAt),
      description,
      id: schedule?.id ?? "missing",
      nextRunAt: schedule ? epochToIso(schedule.time) : null,
      payload: prompt,
      scheduleType: schedule?.type ?? "scheduled",
    };
  }

  private async exportSnapshot(): Promise<SessionSnapshot | SnapshotV2> {
    const paths = await this.workspace._getAllPaths();
    const files: Array<{ content: string; path: string }> = [];

    for (const path of paths) {
      const stat = await this.workspace.stat(path);
      if (!stat || stat.type !== "file") {
        continue;
      }
      const content = await this.workspace.readFile(path);
      if (content !== null) {
        files.push({ content, path });
      }
    }

    // V2 snapshot: Think messages + sidecar metadata
    const thinkSessionId = this.getCurrentSessionId();
    const history = thinkSessionId ? this.sessions.getHistory(thinkSessionId) : [];
    return {
      version: 2,
      title: this.readMetadata("title"),
      files,
      messages: history.map((msg) => {
        const meta = this.readMessageMetadata(msg.id);
        return {
          uiMessage: msg,
          metadata: {
            authorEmail: meta?.authorEmail,
            model: meta?.model,
            provider: meta?.provider,
            tokenInput: meta?.tokenInput ?? 0,
            tokenOutput: meta?.tokenOutput ?? 0,
          },
        };
      }),
    } satisfies SnapshotV2;
  }

  private async handleImportSnapshot(request: Request): Promise<Response> {
    const ownerEmail = request.headers.get("x-owner-email");
    this.ensureMetadata(this.requireSessionId(request), ownerEmail);
    const url = new URL(request.url);
    let snapshotInput: unknown;
    const snapshotId = url.searchParams.get("snapshotId");
    if (snapshotId) {
      if (!ownerEmail) {
        throw new Error("Session has no owner_email. Run migration (POST /api/admin/migrate) to fix legacy sessions.");
      }
      const stub = getUserControlStub(this.env, ownerEmail);
      const response = await stub.fetch(`https://user-control/fork-snapshots/${encodeURIComponent(snapshotId)}`);
      snapshotInput = await response.json();
    } else {
      snapshotInput = await request.json();
    }

    const raw = snapshotInput as Record<string, unknown>;
    const version = typeof raw.version === "number" ? raw.version : 1;

    if (version === 2) {
      // V2 import: UIMessages + sidecar metadata → Think session
      const v2 = snapshotInput as SnapshotV2;
      if (v2.title) this.writeMetadata("title", v2.title);
      for (const file of v2.files) {
        await this.workspace.writeFile(normalizePath(file.path), file.content);
      }
      const thinkSessionId = this.getCurrentSessionId();
      if (thinkSessionId) {
        for (const entry of v2.messages) {
          this.sessions.append(thinkSessionId, entry.uiMessage);
          this.insertMessageMetadata({
            messageId: entry.uiMessage.id,
            authorEmail: entry.metadata.authorEmail,
            model: entry.metadata.model,
            provider: entry.metadata.provider,
            tokenInput: entry.metadata.tokenInput,
            tokenOutput: entry.metadata.tokenOutput,
          });
        }
        this.messages = this.sessions.getHistory(thinkSessionId);
      }

      return Response.json({ imported: true, version: 2, messages: v2.messages.length, files: v2.files.length });
    }

    // V1 import: flat ChatMessageRecord[] → Think session
    const snapshot = z.object({ files: z.array(z.object({ content: z.string(), path: z.string().min(1) })), messages: z.array(z.object({ content: z.string(), createdAt: z.string(), id: z.string(), model: z.string().nullable(), provider: z.string().nullable(), role: z.enum(["assistant", "system", "tool", "user"]) })), title: z.string().nullable() }).parse(snapshotInput) as SessionSnapshot;

    if (snapshot.title) {
      this.writeMetadata("title", snapshot.title);
    }

    for (const file of snapshot.files) {
      await this.workspace.writeFile(normalizePath(file.path), file.content);
    }

    // Import into Think session
    const thinkSessionId = this.getCurrentSessionId();
    if (thinkSessionId) {
      for (const message of snapshot.messages) {
        const uiMsg = chatRecordToUIMessage(message);
        this.sessions.append(thinkSessionId, uiMsg);
        this.insertMessageMetadata({
          messageId: uiMsg.id,
          authorEmail: message.authorEmail,
          model: message.model,
          provider: message.provider,
          tokenInput: message.tokenInput,
          tokenOutput: message.tokenOutput,
        });
      }
      this.messages = this.sessions.getHistory(thinkSessionId);
    }

    return Response.json({ imported: true, messages: snapshot.messages.length, files: snapshot.files.length });
  }

  private async handleMessage(request: Request): Promise<Response> {
    const input = sendMessageSchema.parse(await request.json());
    const sessionId = this.requireSessionId(request);
    const authorEmail = request.headers.get("x-author-email");
    const ownerEmail = request.headers.get("x-owner-email");
    this.ensureMetadata(sessionId, ownerEmail);

    const title = this.readMetadata("title") ?? (input.content.length > 72 ? input.content.slice(0, 72) + "…" : input.content);
    this.writeMetadata("title", title);
    this.writeMetadata("status", "running");
    await this.syncSessionIndex({ status: "running", title });

    this.ensureThinkConfig(request);
    try {
      const result = await this.runThinkChat(input.content, { authorEmail: authorEmail ?? undefined });

      const config = this.getConfig();
      const assistantRecord = uiMessageToChatRecord(
        { id: result.assistantMessageId, role: "assistant", parts: [{ type: "text", text: result.text }] },
        { messageId: result.assistantMessageId, model: config?.model ?? null, provider: config?.activeGateway ?? null, tokenInput: result.tokenInput, tokenOutput: result.tokenOutput, authorEmail: null, createdAt: nowEpoch() },
      );

      this.writeMetadata("status", "idle");
      await this.syncSessionIndex({ status: "idle", title });
      this.emitEvent({ data: assistantRecord, type: "message" });
      this.emitEvent({ data: this.readSessionDetails(), type: "state" });
      sendNotification(this.env, this.ctx, { title: `Dodo: ${title}`, body: result.text.slice(0, 200), tags: "white_check_mark,robot", ownerEmail: this.readMetadata("owner_email") ?? undefined });

      return Response.json({ gateway: config?.activeGateway ?? "opencode", message: assistantRecord, sessionId, steps: 0, toolCalls: [] });
    } catch (error) {
      this.writeMetadata("status", "idle");
      await this.syncSessionIndex({ status: "idle", title });
      const message = error instanceof Error ? error.message : "Unknown LLM failure";
      this.emitEvent({ data: { message }, type: "error_message" });
      this.emitEvent({ data: this.readSessionDetails(), type: "state" });
      sendNotification(this.env, this.ctx, { title: `Dodo: ${title} (failed)`, body: message, tags: "x,robot", priority: "high", ownerEmail: this.readMetadata("owner_email") ?? undefined });
      return Response.json({ error: message, sessionId }, { status: 502 });
    }
  }

  private async handlePrompt(request: Request): Promise<Response> {
    const input = sendMessageSchema.parse(await request.json());
    const sessionId = this.requireSessionId(request);
    const authorEmail = request.headers.get("x-author-email");
    const ownerEmail = request.headers.get("x-owner-email");
    this.ensureMetadata(sessionId, ownerEmail);

    if (this.readMetadata("active_prompt_id")) {
      return Response.json({ error: "A prompt is already running" }, { status: 409 });
    }

    this.ensureThinkConfig(request);

    const promptId = crypto.randomUUID();
    const title = this.readMetadata("title") ?? (input.content.length > 72 ? input.content.slice(0, 72) + "…" : input.content);

    this.writeMetadata("title", title);
    this.writeMetadata("active_prompt_id", promptId);
    this.writeMetadata("status", "running");
    this.insertPrompt(promptId, input.content, "queued", authorEmail);
    await this.syncSessionIndex({ status: "running", title });

    this.emitEvent({ data: this.readSessionDetails(), type: "state" });

    // Fiber-backed async prompt
    const fiberId = this.spawnFiber("runFiberPrompt", {
      promptId,
      content: input.content,
      authorEmail: authorEmail ?? undefined,
      title,
    }, { maxRetries: 3 });
    this.setPromptFiberId(promptId, fiberId);

    return Response.json({ promptId, status: "queued" }, { status: 202 });
  }

  private async handleAbort(): Promise<Response> {
    const promptId = this.readMetadata("active_prompt_id");
    if (!promptId) {
      return Response.json({ error: "No active prompt" }, { status: 409 });
    }

    // Cancel via fiber
    const fiberId = this.readPromptFiberId(promptId);
    if (fiberId) {
      this.cancelFiber(fiberId);
    }
    await this.finishPrompt(promptId, { error: "Prompt aborted", status: "aborted" });

    return Response.json({ aborted: true, promptId });
  }

  // runAsyncPrompt removed — all async prompts now use fiber-backed runFiberPrompt

  private async finishPrompt(
    promptId: string,
    patch: { error?: string; resultMessageId?: string; status: PromptRecord["status"] },
  ): Promise<void> {
    this.updatePrompt(promptId, patch);
    this.deleteMetadata("active_prompt_id");
    this.writeMetadata("status", "idle");
  }

  // ─── Fiber-aware prompt execution ───

  /**
   * Fiber-aware async prompt. Uses stashFiber() checkpoints so that
   * if the DO is evicted mid-chat, recovery replays from the top and
   * skips already-completed work.
   */
  async runFiberPrompt(payload: { promptId: string; content: string; authorEmail?: string; title: string }): Promise<void> {
    const { promptId, content, authorEmail, title } = payload;

    // Check fiber snapshot — if chat already completed, skip to finalization
    const fiberId = this.readPromptFiberId(promptId);
    if (fiberId) {
      const fiber = this.getFiber(fiberId);
      const snapshot = fiber?.snapshot as { chatCompleted?: boolean; assistantMessageId?: string; text?: string } | null;
      if (snapshot?.chatCompleted) {
        // Chat completed before eviction — just finalize
        await this.finalizePromptFromFiber(promptId, title, snapshot);
        return;
      }
    }

    // Phase 1: Run chat via Think
    try {
      const result = await this.runThinkChat(content, { authorEmail });

      // Phase 2: Checkpoint immediately after chat completes
      this.stashFiber({
        chatCompleted: true,
        assistantMessageId: result.assistantMessageId,
        text: result.text,
      });

      // Phase 3: Finalize
      await this.finalizePromptFromFiber(promptId, title, {
        chatCompleted: true,
        assistantMessageId: result.assistantMessageId,
        text: result.text,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Prompt failed";
      this.emitEvent({ data: { message }, type: "error_message" });
      await this.finishPrompt(promptId, { error: message, status: "failed" });
      sendNotification(this.env, this.ctx, { title: `Dodo: ${title} (failed)`, body: message, tags: "x,robot", priority: "high", ownerEmail: this.readMetadata("owner_email") ?? undefined });
    } finally {
      await this.syncSessionIndex({ status: "idle", title });
      this.emitEvent({ data: this.listPrompts(), type: "prompt" });
      this.emitEvent({ data: this.readSessionDetails(), type: "state" });
    }
  }

  /** Finalize a prompt from fiber snapshot data. */
  private async finalizePromptFromFiber(
    promptId: string,
    title: string,
    snapshot: { chatCompleted?: boolean; assistantMessageId?: string; text?: string },
  ): Promise<void> {
    const config = this.getConfig();
    const text = snapshot.text ?? "";
    const assistantRecord = uiMessageToChatRecord(
      { id: snapshot.assistantMessageId ?? "", role: "assistant", parts: [{ type: "text", text }] },
      { messageId: snapshot.assistantMessageId ?? "", model: config?.model ?? null, provider: config?.activeGateway ?? null, tokenInput: 0, tokenOutput: 0, authorEmail: null, createdAt: nowEpoch() },
    );

    await this.finishPrompt(promptId, { resultMessageId: snapshot.assistantMessageId, status: "completed" });
    this.emitEvent({ data: assistantRecord, type: "message" });
    sendNotification(this.env, this.ctx, { title: `Dodo: ${title}`, body: text.slice(0, 200), tags: "white_check_mark,robot", ownerEmail: this.readMetadata("owner_email") ?? undefined });
  }

  /** Read the fiber_id from a prompt row. */
  private readPromptFiberId(promptId: string): string | null {
    const row = this.db.one("SELECT fiber_id FROM prompts WHERE id = ?", promptId);
    return row?.fiber_id ? String(row.fiber_id) : null;
  }

  /** Store a fiber_id on a prompt row. */
  private setPromptFiberId(promptId: string, fiberId: string): void {
    this.db.exec("UPDATE prompts SET fiber_id = ? WHERE id = ?", fiberId, promptId);
  }

  /**
   * Called when a fiber recovers after DO eviction.
   * Updates the prompt status to "recovering" and emits an event.
   */
  async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void> {
    // Find the prompt associated with this fiber
    const row = this.db.one("SELECT id FROM prompts WHERE fiber_id = ?", ctx.id);
    if (row) {
      const promptId = String(row.id);
      this.updatePrompt(promptId, { status: "running" });
      this.writeMetadata("active_prompt_id", promptId);
      this.writeMetadata("status", "running");
      this.emitEvent({ data: this.listPrompts(), type: "prompt" });
      this.emitEvent({ data: this.readSessionDetails(), type: "state" });
    }

    // Default behavior: restart the fiber
    this.restartFiber(ctx.id);
  }

  /**
   * Called when a fiber completes (success, failure, or cancellation).
   */
  async onFiberComplete(ctx: FiberCompleteContext): Promise<void> {
    // Find the associated prompt
    const row = this.db.one("SELECT id, status FROM prompts WHERE fiber_id = ?", ctx.id);
    if (!row) return;

    const promptId = String(row.id);
    const fiber = this.getFiber(ctx.id);

    if (fiber?.status === "cancelled") {
      await this.finishPrompt(promptId, { error: "Prompt aborted", status: "aborted" });
      const title = this.readMetadata("title") ?? "Dodo prompt";
      sendNotification(this.env, this.ctx, { title: `Dodo: ${title} (aborted)`, body: "Prompt was cancelled", tags: "stop_sign,robot", ownerEmail: this.readMetadata("owner_email") ?? undefined });
    } else if (fiber?.status === "failed") {
      const error = fiber.error ?? "Prompt failed after max retries";
      await this.finishPrompt(promptId, { error, status: "failed" });
      const title = this.readMetadata("title") ?? "Dodo prompt";
      sendNotification(this.env, this.ctx, { title: `Dodo: ${title} (failed)`, body: error, tags: "x,robot", priority: "high", ownerEmail: this.readMetadata("owner_email") ?? undefined });
    }

    await this.syncSessionIndex({ status: "idle" });
    this.emitEvent({ data: this.listPrompts(), type: "prompt" });
    this.emitEvent({ data: this.readSessionDetails(), type: "state" });
  }

  // ─── Think chat integration ───

  /**
   * Configure the Think session from request headers (first-time setup).
   * Copies the user's config into Think.configure() so getModel() can read it.
   */
  private ensureThinkConfig(request: Request): void {
    if (this.getConfig()) return; // Already configured
    const config: DodoConfig = {
      sessionId: this.sessionId(),
      ownerEmail: this.readMetadata("owner_email") ?? "",
      createdAt: this.readMetadata("created_at") ?? new Date().toISOString(),
      browserEnabled: this.readMetadata("browser_enabled") === "true",
      activeGateway: (request.headers.get("x-dodo-gateway") === "ai-gateway" ? "ai-gateway" : "opencode"),
      model: request.headers.get("x-dodo-model") ?? this.env.DEFAULT_MODEL,
      opencodeBaseURL: request.headers.get("x-dodo-opencode-base-url") ?? this.env.OPENCODE_BASE_URL,
      aiGatewayBaseURL: request.headers.get("x-dodo-ai-base-url") ?? this.env.AI_GATEWAY_BASE_URL,
    };
    this.configure(config);
  }

  /** Insert a metadata record for a Think message. */
  private insertMessageMetadata(input: {
    messageId: string;
    authorEmail?: string | null;
    model?: string | null;
    provider?: string | null;
    tokenInput?: number;
    tokenOutput?: number;
  }): void {
    this.db.exec(
      "INSERT OR REPLACE INTO message_metadata (message_id, author_email, model, provider, token_input, token_output, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      input.messageId,
      input.authorEmail ?? null,
      input.model ?? null,
      input.provider ?? null,
      input.tokenInput ?? 0,
      input.tokenOutput ?? 0,
      nowEpoch(),
    );
  }

  /** Read metadata for a Think message. */
  private readMessageMetadata(messageId: string): MessageMetadata | null {
    const row = this.db.one(
      "SELECT message_id, author_email, model, provider, token_input, token_output, created_at FROM message_metadata WHERE message_id = ?",
      messageId,
    );
    if (!row) return null;
    return {
      messageId: String(row.message_id),
      authorEmail: row.author_email === null ? null : String(row.author_email),
      model: row.model === null ? null : String(row.model),
      provider: row.provider === null ? null : String(row.provider),
      tokenInput: Number(row.token_input ?? 0),
      tokenOutput: Number(row.token_output ?? 0),
      createdAt: Number(row.created_at),
    };
  }

  /**
   * List messages from Think storage, joined with sidecar metadata.
   * Returns ChatMessageRecord[] for backward compatibility.
   */
  private listThinkMessages(): ChatMessageRecord[] {
    const thinkSessionId = this.getCurrentSessionId();
    if (!thinkSessionId) return [];
    const history = this.sessions.getHistory(thinkSessionId);
    return history.map((msg) => {
      const meta = this.readMessageMetadata(msg.id);
      return uiMessageToChatRecord(msg, meta ?? undefined);
    });
  }

  /**
   * Run a chat turn via Think.chat().
   * Bridges Think streaming events to Dodo's SSE/WS event format.
   * Returns the assistant message ID and token usage.
   */
  private async runThinkChat(
    userContent: string,
    options?: { authorEmail?: string; signal?: AbortSignal },
  ): Promise<{ assistantMessageId: string; tokenInput: number; tokenOutput: number; text: string }> {
    // Insert user message metadata
    const userMsgId = crypto.randomUUID();
    const userMsg: UIMessage = {
      id: userMsgId,
      role: "user",
      parts: [{ type: "text", text: userContent }],
    };

    this.insertMessageMetadata({
      messageId: userMsgId,
      authorEmail: options?.authorEmail,
    });

    // Emit user message event in Dodo format
    const userRecord = uiMessageToChatRecord(userMsg, {
      messageId: userMsgId,
      authorEmail: options?.authorEmail ?? null,
      model: null,
      provider: null,
      tokenInput: 0,
      tokenOutput: 0,
      createdAt: nowEpoch(),
    });
    this.emitEvent({ data: userRecord, type: "message" });

    // Track assistant response metadata
    let assistantMessageId = "";
    let tokenInput = 0;
    let tokenOutput = 0;
    let fullText = "";

    const callback: StreamCallback = {
      onEvent: (json: string) => {
        try {
          const chunk = JSON.parse(json);
          // Bridge Think chunk events to Dodo SSE format
          if (chunk.type === "text-delta") {
            const delta = chunk.textDelta ?? "";
            fullText += delta;
            this.emitEvent({ data: { delta }, type: "text_delta" });
          } else if (chunk.type === "tool-call") {
            this.emitEvent({
              data: { code: chunk.args ?? "", result: chunk.toolCallId },
              type: "tool_call",
            });
          }
          // Note: toUIMessageStream() does not emit step-finish events, so token
          // usage from the AI SDK stream is not available here. This requires
          // Think to expose usage data via StreamCallback or a post-chat hook.
          // See feedback for @cloudflare/think.
        } catch {
          // Skip unparseable chunks
        }
      },
      onDone: () => {
        // After chat completes, find the latest assistant message
        const history = this.getHistory();
        const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
        if (lastAssistant) {
          assistantMessageId = lastAssistant.id;
          // Extract text from parts
          fullText = lastAssistant.parts
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("");
        }
      },
      onError: (error: string) => {
        console.error("Think chat error:", error);
      },
    };

    await this.chat(userMsg, callback, { signal: options?.signal });

    // Get config for provider info
    const config = this.getConfig();
    const model = config?.model ?? this.env.DEFAULT_MODEL;
    const gateway = config?.activeGateway ?? "opencode";

    // Insert assistant message metadata
    if (assistantMessageId) {
      this.insertMessageMetadata({
        messageId: assistantMessageId,
        model,
        provider: gateway,
        tokenInput,
        tokenOutput,
      });
    }

    return { assistantMessageId, tokenInput, tokenOutput, text: fullText };
  }

  private ensureMetadata(sessionId: string, ownerEmail?: string | null): void {
    const now = nowEpoch();
    if (!this.readMetadata("session_id")) {
      this.writeMetadata("session_id", sessionId);
      this.writeMetadata("created_at", new Date(now * 1000).toISOString());

    }
    if (ownerEmail && !this.readMetadata("owner_email")) {
      this.writeMetadata("owner_email", ownerEmail);
    }
    if (!this.readMetadata("status")) {
      this.writeMetadata("status", "idle");
    }
    this.writeMetadata("updated_at", new Date(now * 1000).toISOString());
  }

   private readSessionDetails(): SessionState {
    const createdAt = this.readMetadata("created_at") ?? new Date().toISOString();
    const updatedAt = this.readMetadata("updated_at") ?? createdAt;
    const sessionId = this.readMetadata("session_id") ?? "";
    const ownerEmail = this.readMetadata("owner_email") ?? undefined;
    const activePromptId = this.readMetadata("active_prompt_id");
    let status = (this.readMetadata("status") as SessionState["status"] | null) ?? "idle";
    // Reconcile stale "running" status when no prompt is active
    if (status === "running" && !activePromptId) {
      this.writeMetadata("status", "idle");
      status = "idle";
      // Fire-and-forget sync to UserControl
      void this.syncSessionIndex({ status: "idle" }).catch(() => {});
    }
    // Get token totals from the appropriate source
    const metaTotals = this.db.one("SELECT COALESCE(SUM(token_input), 0) AS total_in, COALESCE(SUM(token_output), 0) AS total_out FROM message_metadata");
    const totalTokenInput = Number(metaTotals?.total_in ?? 0);
    const totalTokenOutput = Number(metaTotals?.total_out ?? 0);
    return {
      activePromptId,
      activeStreamCount: this.clients.size,
      createdAt,
      messageCount: this.messageCount(),
      ownerEmail,
      sessionId,
      status,
      totalTokenInput,
      totalTokenOutput,
      updatedAt,
    };
  }

  private listMessages(): ChatMessageRecord[] {
    return this.listThinkMessages();
  }

  private messageCount(): number {
    const thinkSessionId = this.getCurrentSessionId();
    if (!thinkSessionId) return 0;
    return this.sessions.getMessageCount(thinkSessionId);
  }

  private insertPrompt(promptId: string, content: string, status: PromptRecord["status"], authorEmail?: string | null): void {
    const sessionId = this.sessionId();
    const createdAt = nowEpoch();
    this.db.exec(
      "INSERT INTO prompts (id, session_id, content, status, author_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      promptId,
      sessionId,
      content,
      status,
      authorEmail ?? null,
      createdAt,
      createdAt,
    );
  }

  private updatePrompt(
    promptId: string,
    patch: { error?: string; resultMessageId?: string; status: PromptRecord["status"] },
  ): void {
    const existing = this.db.one("SELECT error, result_message_id FROM prompts WHERE id = ?", promptId);
    this.db.exec(
      "UPDATE prompts SET status = ?, error = ?, result_message_id = ?, updated_at = ? WHERE id = ?",
      patch.status,
      patch.error ?? (existing?.error === null || existing?.error === undefined ? null : String(existing.error)),
      patch.resultMessageId ??
        (existing?.result_message_id === null || existing?.result_message_id === undefined
          ? null
          : String(existing.result_message_id)),
      nowEpoch(),
      promptId,
    );
  }

  private listPrompts(): PromptRecord[] {
    return this.db.all(
      "SELECT id, content, status, error, result_message_id, author_email, created_at, updated_at FROM prompts ORDER BY created_at DESC, rowid DESC",
    ).map((row) => ({
      authorEmail: row.author_email === null || row.author_email === undefined ? null : String(row.author_email),
      content: String(row.content),
      createdAt: epochToIso(row.created_at),
      error: row.error === null ? null : String(row.error),
      id: String(row.id),
      resultMessageId: row.result_message_id === null ? null : String(row.result_message_id),
      status: row.status as PromptRecord["status"],
      updatedAt: epochToIso(row.updated_at),
    }));
  }

  private mapWorkspaceEntry(entry: {
    createdAt: number;
    mimeType: string;
    name: string;
    path: string;
    size: number;
    type: "file" | "directory" | "symlink";
    updatedAt: number;
  }): WorkspaceEntry {
    return {
      createdAt: sanitizeTimestamp(entry.createdAt),
      mimeType: entry.mimeType,
      name: entry.name,
      path: entry.path,
      size: entry.size,
      type: entry.type,
      updatedAt: sanitizeTimestamp(entry.updatedAt),
    };
  }

  // ─── Approval Queue ───

  private listApprovals(statusFilter?: string): Array<{
    id: string;
    toolName: string;
    toolArgs: unknown;
    status: string;
    requestedAt: string;
    resolvedAt: string | null;
    resolvedBy: string | null;
  }> {
    const rows = statusFilter
      ? this.db.all("SELECT id, tool_name, tool_args, status, requested_at, resolved_at, resolved_by FROM approval_queue WHERE status = ? ORDER BY requested_at DESC", statusFilter)
      : this.db.all("SELECT id, tool_name, tool_args, status, requested_at, resolved_at, resolved_by FROM approval_queue ORDER BY requested_at DESC");
    return rows.map((row) => ({
      id: String(row.id),
      toolName: String(row.tool_name),
      toolArgs: JSON.parse(String(row.tool_args)),
      status: String(row.status),
      requestedAt: epochToIso(row.requested_at),
      resolvedAt: row.resolved_at === null ? null : epochToIso(row.resolved_at),
      resolvedBy: row.resolved_by === null ? null : String(row.resolved_by),
    }));
  }

  private resolveApproval(id: string, status: "approved" | "rejected", resolvedBy?: string): {
    id: string;
    status: string;
    resolvedAt: string;
    resolvedBy: string | null;
  } {
    const existing = this.db.one("SELECT status FROM approval_queue WHERE id = ?", id);
    if (!existing) throw new Error(`Approval ${id} not found`);
    if (String(existing.status) !== "pending") throw new Error(`Approval ${id} already resolved`);

    const now = nowEpoch();
    this.db.exec(
      "UPDATE approval_queue SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ?",
      status,
      now,
      resolvedBy ?? null,
      id,
    );
    this.emitEvent({ data: { id, status, resolvedBy }, type: "approval" });
    return { id, status, resolvedAt: epochToIso(now), resolvedBy: resolvedBy ?? null };
  }

  private openEventStream(request: Request): Response {
    const stream = new TransformStream<Uint8Array>();
    const writer = stream.writable.getWriter();
    this.clients.add(writer);
    this.setState({ ...this.readSessionDetails() });

    void this.writeEvent(writer, { data: this.readSessionDetails(), type: "ready" });

    request.signal.addEventListener(
      "abort",
      () => {
        this.clients.delete(writer);
        try { void writer.close(); } catch { /* stream may already be closed */ }
        this.setState({ ...this.readSessionDetails() });
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

  private async writeEvent(writer: WritableStreamDefaultWriter<Uint8Array>, event: SessionEvent): Promise<void> {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    await writer.write(new TextEncoder().encode(payload));
  }

  private emitEvent(event: SessionEvent): void {
    // Broadcast to SSE clients
    for (const writer of [...this.clients]) {
      void this.writeEvent(writer, event).catch(() => {
        this.clients.delete(writer);
      });
    }

    // Broadcast to WebSocket clients
    const wsPayload = JSON.stringify({ type: event.type, ...event.data as object });
    this.broadcastToWebSockets(wsPayload);
  }

  private requireSessionId(request: Request): string {
    const sessionId = request.headers.get("x-dodo-session-id");
    if (!sessionId) {
      throw new Error("Missing session id header");
    }
    return sessionId;
  }

  private sessionId(): string {
    return this.readMetadata("session_id") ?? "";
  }

  private readMetadata(key: string): string | null {
    const row = this.db.one("SELECT value FROM metadata WHERE key = ?", key);
    return row ? String(row.value) : null;
  }

  private writeMetadata(key: string, value: string): void {
    this.db.exec(
      "INSERT INTO metadata (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      key,
      value,
      nowEpoch(),
    );
  }

  private deleteMetadata(key: string): void {
    this.db.exec("DELETE FROM metadata WHERE key = ?", key);
  }

  private async readAppConfig(): Promise<AppConfig> {
    const ownerEmail = this.readMetadata("owner_email");
    if (!ownerEmail) {
      throw new Error("Session has no owner_email. Run migration (POST /api/admin/migrate) to fix legacy sessions.");
    }
    const stub = getUserControlStub(this.env, ownerEmail);
    const response = await stub.fetch("https://user-control/config");
    const appConfig = (await response.json()) as AppConfig;

    // Ensure Think config is populated
    if (!this.getConfig()) {
      const dodoConfig: DodoConfig = {
        sessionId: this.sessionId(),
        ownerEmail,
        createdAt: this.readMetadata("created_at") ?? new Date().toISOString(),
        browserEnabled: this.readMetadata("browser_enabled") === "true",
        activeGateway: appConfig.activeGateway,
        model: appConfig.model,
        opencodeBaseURL: appConfig.opencodeBaseURL,
        aiGatewayBaseURL: appConfig.aiGatewayBaseURL,
      };
      this.configure(dodoConfig);
    }

    return appConfig;
  }

  private async syncSessionIndex(patch: { status?: string; title?: string | null }): Promise<void> {
    const ownerEmail = this.readMetadata("owner_email");
    if (!ownerEmail) {
      throw new Error("Session has no owner_email. Run migration (POST /api/admin/migrate) to fix legacy sessions.");
    }
    try {
      const stub = getUserControlStub(this.env, ownerEmail);
      await stub.fetch("https://user-control/sessions/" + this.sessionId(), {
        body: JSON.stringify(patch),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
    } catch (error) {
      // Log but don't throw — sync failure shouldn't break prompt completion
      console.error("syncSessionIndex failed:", error instanceof Error ? error.message : error);
    }
  }

  private async destroyStorage(): Promise<void> {
    this.db.exec("DELETE FROM message_metadata");
    this.db.exec("DELETE FROM prompts");
    this.db.exec("DELETE FROM cron_jobs");
    this.db.exec("DELETE FROM metadata");
    // Clean up Think sessions
    const thinkSessionId = this.getCurrentSessionId();
    if (thinkSessionId) {
      this.sessions.delete(thinkSessionId);
    }

    try {
      await this.workspace.rm("/", { force: true, recursive: true });
    } catch {
      // workspace may already be empty
    }

    for (const writer of [...this.clients]) {
      try { void writer.close(); } catch { /* ignore */ }
      this.clients.delete(writer);
    }
  }
}
