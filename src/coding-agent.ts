import { Workspace, createWorkspaceStateBackend } from "@cloudflare/shell";
import { type Connection, type ConnectionContext, type WSMessage } from "agents";
import type { LanguageModel, ToolSet } from "ai";
import { z } from "zod";
import { runAgenticChat, streamAgenticChat } from "./agentic";
import { getUserControlStub } from "./auth";
import { sendNotification } from "./notify";
import { runSandboxedCode } from "./executor";
import { createWorkspaceGit, defaultAuthor, resolveRemoteToken } from "./git";
import { PresenceTracker } from "./presence";
import { AgentConnectionTransport } from "./rpc-transport";
import { epochToIso, nowEpoch, SqlHelper, type SqlRow } from "./sql-helpers";
import { Think, type DodoConfig } from "./think-adapter";
import type { AppConfig, ChatMessageRecord, CronJobRecord, Env, PromptRecord, SessionEvent, SessionSnapshot, SessionState, WorkspaceEntry } from "./types";

const sendMessageSchema = z.object({ content: z.string().trim().min(1) }).strict();
const executeCodeSchema = z.object({ code: z.string().trim().min(1) }).strict();
const gitCommitSchema = z.object({ dir: z.string().optional(), message: z.string().trim().min(1) }).strict();
const gitCloneSchema = z.object({ branch: z.string().optional(), depth: z.number().int().positive().optional(), dir: z.string().optional(), singleBranch: z.boolean().optional(), url: z.string().url() }).strict();
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
const searchFilesSchema = z.object({ pattern: z.string().min(1), query: z.string().min(1) }).strict();
const writeFileSchema = z.object({ content: z.string(), mimeType: z.string().optional() }).strict();

const SYSTEM_PROMPT = [
  "You are Dodo, a Cloudflare Workers coding agent.",
  "Be concise, direct, and implementation-focused.",
  "Prefer concrete next actions over long explanations.",
  "",
  "## Git",
  "You have git tools: git_clone, git_status, git_add, git_commit, git_push, git_pull,",
  "git_branch, git_checkout, git_diff, git_log. Authentication for GitHub and GitLab is automatic.",
  "Use these for cloning repos, making changes, and pushing commits.",
  "",
  "## External APIs",
  "You can use fetch() in codemode to call external APIs. Requests to GitHub",
  "(api.github.com, raw.githubusercontent.com) and GitLab hosts have auth headers",
  "injected automatically — you do NOT need a token.",
].join("\n");

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

  /** Fibers disabled until Wave 5. */
  override fibers = false;

  private readonly activePromptControllers = new Map<string, AbortController>();
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
    // Temporary: throw — we don't use Think's chat loop yet (Wave 3+4)
    throw new Error("getModel() called before Think chat is enabled");
  }

  override getSystemPrompt(): string {
    return SYSTEM_PROMPT;
  }

  override getTools(): ToolSet {
    // Empty until Wave 2 — old tools still wired through agentic.ts
    return {};
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

        const llmConfig = await this.readAppConfig();
        const title = this.readMetadata("title") ?? content.slice(0, 72);

        this.writeMetadata("title", title);
        this.writeMetadata("active_prompt_id", promptId);
        this.writeMetadata("status", "running");
        this.insertPrompt(promptId, content, "queued", entry?.email);
        await this.syncSessionIndex({ status: "running", title });
        this.emitEvent({ data: this.readSessionDetails(), type: "state" });

        connection.send(JSON.stringify({ type: "prompt_queued", promptId }));
        void this.runAsyncPrompt(promptId, content, llmConfig, title, entry?.email);
        break;
      }

      case "abort": {
        const promptId = this.readMetadata("active_prompt_id");
        if (!promptId) {
          connection.send(JSON.stringify({ type: "error", error: "No active prompt" }));
          return;
        }
        const controller = this.activePromptControllers.get(promptId);
        if (controller) {
          controller.abort();
        } else {
          await this.finishPrompt(promptId, { error: "Prompt aborted", status: "aborted" });
        }
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

  /** Broadcast current presence list to all WebSocket clients. */
  private broadcastPresence(): void {
    const payload = JSON.stringify({
      type: "presence",
      users: this.presence.getAll(),
    });
    this.broadcastToWebSockets(payload);
  }

  /** Get current presence entries (used by RPC API). */
  getPresenceEntries() {
    return this.presence.getAll();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        model TEXT,
        provider TEXT,
        author_email TEXT,
        created_at INTEGER NOT NULL,
        token_input INTEGER NOT NULL DEFAULT 0,
        token_output INTEGER NOT NULL DEFAULT 0
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

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at)");

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
    const result = await git.clone({
      branch: body.branch,
      depth: body.depth,
      dir,
      singleBranch: body.singleBranch,
      token,
      url: body.url,
    });
    return Response.json(result);
  }

  private async handleGitAdd(request: Request): Promise<Response> {
    const body = z.object({ dir: z.string().optional(), filepath: z.string().min(1) }).strict().parse(await request.json());
    const git = createWorkspaceGit(this.workspace);
    return Response.json(await git.add({ dir: body.dir ? normalizePath(body.dir) : undefined, filepath: body.filepath }));
  }

  private async handleGitCommit(request: Request): Promise<Response> {
    const body = gitCommitSchema.parse(await request.json());
    const ownerEmail = request.headers.get("x-owner-email");
    if (ownerEmail && !this.readMetadata("owner_email")) {
      this.writeMetadata("owner_email", ownerEmail);
    }
    const git = createWorkspaceGit(this.workspace);
    const config = await this.readAppConfig();
    return Response.json(
      await git.commit({ author: defaultAuthor(config), dir: body.dir ? normalizePath(body.dir) : undefined, message: body.message }),
    );
  }

  private async handleGitStatus(url: URL): Promise<Response> {
    const git = createWorkspaceGit(this.workspace);
    const dir = url.searchParams.get("dir");
    return Response.json({ entries: await git.status({ dir: dir ? normalizePath(dir) : undefined }) });
  }

  private async handleGitLog(url: URL): Promise<Response> {
    const git = createWorkspaceGit(this.workspace);
    const dir = url.searchParams.get("dir");
    const depth = url.searchParams.get("depth");
    return Response.json({ entries: await git.log({ depth: depth ? Number(depth) : undefined, dir: dir ? normalizePath(dir) : undefined }) });
  }

  private async handleGitDiff(url: URL): Promise<Response> {
    const git = createWorkspaceGit(this.workspace);
    const dir = url.searchParams.get("dir");
    return Response.json({ entries: await git.diff({ dir: dir ? normalizePath(dir) : undefined }) });
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
    const token = await resolveRemoteToken({ dir, env: this.env, git, remote: body.remote, ownerEmail });
    return Response.json(await git.push({ dir, force: body.force, ref: body.ref, remote: body.remote, token }));
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
    await this.runAsyncPrompt(promptId, payload.prompt, await this.readAppConfig(), title, this.readMetadata("owner_email") ?? undefined);
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

  private async exportSnapshot(): Promise<SessionSnapshot> {
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

    return {
      files,
      messages: this.listMessages(),
      title: this.readMetadata("title"),
    };
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

    const snapshot = z.object({ files: z.array(z.object({ content: z.string(), path: z.string().min(1) })), messages: z.array(z.object({ content: z.string(), createdAt: z.string(), id: z.string(), model: z.string().nullable(), provider: z.string().nullable(), role: z.enum(["assistant", "system", "tool", "user"]) })), title: z.string().nullable() }).parse(snapshotInput) as SessionSnapshot;

    if (snapshot.title) {
      this.writeMetadata("title", snapshot.title);
    }

    for (const file of snapshot.files) {
      await this.workspace.writeFile(normalizePath(file.path), file.content);
    }

    for (const message of snapshot.messages) {
      this.insertMessage({ content: message.content, model: message.model, provider: message.provider, role: message.role });
    }

    return Response.json({ imported: true, messages: snapshot.messages.length, files: snapshot.files.length });
  }

  private async handleMessage(request: Request): Promise<Response> {
    const input = sendMessageSchema.parse(await request.json());
    const sessionId = this.requireSessionId(request);
    const authorEmail = request.headers.get("x-author-email");
    const ownerEmail = request.headers.get("x-owner-email");
    this.ensureMetadata(sessionId, ownerEmail);

    const title = this.readMetadata("title") ?? input.content.slice(0, 72);
    this.writeMetadata("title", title);
    this.writeMetadata("status", "running");
    await this.syncSessionIndex({ status: "running", title });

    const userMessage = this.insertMessage({
      authorEmail,
      content: input.content,
      model: null,
      provider: null,
      role: "user",
    });
    this.emitEvent({ data: userMessage, type: "message" });

    try {
      const llmConfig = this.readGatewayConfig(request);
      const history = this.recentMessages().map((m) => ({ content: m.content, role: m.role }));
      const result = await streamAgenticChat({
        authorEmail: authorEmail ?? undefined,
        config: llmConfig,
        env: this.env,
        messages: history,
        onTextDelta: (delta) => {
          this.emitEvent({ data: { delta }, type: "text_delta" });
        },
        onToolCall: (tc) => {
          this.emitEvent({ data: { code: tc.code, result: tc.result }, type: "tool_call" });
        },
        ownerEmail: this.readMetadata("owner_email") ?? undefined,
        stateBackend: this.stateBackend,
        systemPrompt: SYSTEM_PROMPT,
        workspace: this.workspace,
      });

      const assistantMessage = this.insertMessage({
        content: result.text,
        model: result.model,
        provider: result.gateway,
        role: "assistant",
        tokenInput: result.tokenInput,
        tokenOutput: result.tokenOutput,
      });

      this.writeMetadata("status", "idle");
      await this.syncSessionIndex({ status: "idle", title });
      this.emitEvent({ data: assistantMessage, type: "message" });
      this.emitEvent({ data: this.readSessionDetails(), type: "state" });
      sendNotification(this.env, this.ctx, { title: `Dodo: ${title}`, body: result.text.slice(0, 200), tags: "white_check_mark,robot", ownerEmail: this.readMetadata("owner_email") ?? undefined });

      return Response.json({ gateway: result.gateway, message: assistantMessage, sessionId, steps: result.steps, toolCalls: result.toolCalls });
    } catch (error) {
      this.writeMetadata("status", "idle");
      await this.syncSessionIndex({ status: "idle", title });
      this.emitEvent({ data: this.readSessionDetails(), type: "state" });
      const message = error instanceof Error ? error.message : "Unknown LLM failure";
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

    const promptId = crypto.randomUUID();
    const llmConfig = this.readGatewayConfig(request);
    const title = this.readMetadata("title") ?? input.content.slice(0, 72);

    this.writeMetadata("title", title);
    this.writeMetadata("active_prompt_id", promptId);
    this.writeMetadata("status", "running");
    this.insertPrompt(promptId, input.content, "queued", authorEmail);
    await this.syncSessionIndex({ status: "running", title });

    this.emitEvent({ data: this.readSessionDetails(), type: "state" });
    void this.runAsyncPrompt(promptId, input.content, llmConfig, title, authorEmail ?? undefined);

    return Response.json({ promptId, status: "queued" }, { status: 202 });
  }

  private async handleAbort(): Promise<Response> {
    const promptId = this.readMetadata("active_prompt_id");
    if (!promptId) {
      return Response.json({ error: "No active prompt" }, { status: 409 });
    }

    const controller = this.activePromptControllers.get(promptId);
    if (controller) {
      controller.abort();
    } else {
      await this.finishPrompt(promptId, { error: "Prompt aborted", status: "aborted" });
    }

    return Response.json({ aborted: true, promptId });
  }

  private async runAsyncPrompt(promptId: string, content: string, llmConfig: AppConfig, title: string, authorEmail?: string): Promise<void> {
    const controller = new AbortController();
    this.activePromptControllers.set(promptId, controller);
    this.updatePrompt(promptId, { status: "running" });
    this.emitEvent({ data: this.listPrompts(), type: "prompt" });

    const userMessage = this.insertMessage({
      content,
      model: null,
      provider: null,
      role: "user",
    });
    this.emitEvent({ data: userMessage, type: "message" });

    try {
      const history = this.recentMessages().map((m) => ({ content: m.content, role: m.role }));
      const result = await runAgenticChat({
        authorEmail,
        config: llmConfig,
        env: this.env,
        messages: history,
        ownerEmail: this.readMetadata("owner_email") ?? undefined,
        signal: controller.signal,
        stateBackend: this.stateBackend,
        systemPrompt: SYSTEM_PROMPT,
        workspace: this.workspace,
      });

      for (const call of result.toolCalls) {
        this.emitEvent({ data: { code: call.code, result: call.result }, type: "tool_call" });
      }

      const assistantMessage = this.insertMessage({
        content: result.text,
        model: result.model,
        provider: result.gateway,
        role: "assistant",
        tokenInput: result.tokenInput,
        tokenOutput: result.tokenOutput,
      });

      await this.finishPrompt(promptId, { resultMessageId: assistantMessage.id, status: "completed" });
      this.emitEvent({ data: assistantMessage, type: "message" });
      sendNotification(this.env, this.ctx, { title: `Dodo: ${title}`, body: result.text.slice(0, 200), tags: "white_check_mark,robot", ownerEmail: this.readMetadata("owner_email") ?? undefined });
    } catch (error) {
      if (controller.signal.aborted) {
        await this.finishPrompt(promptId, { error: "Prompt aborted", status: "aborted" });
        sendNotification(this.env, this.ctx, { title: `Dodo: ${title} (aborted)`, body: "Prompt was cancelled", tags: "stop_sign,robot", ownerEmail: this.readMetadata("owner_email") ?? undefined });
      } else {
        const message = error instanceof Error ? error.message : "Prompt failed";
        await this.finishPrompt(promptId, { error: message, status: "failed" });
        sendNotification(this.env, this.ctx, { title: `Dodo: ${title} (failed)`, body: message, tags: "x,robot", priority: "high", ownerEmail: this.readMetadata("owner_email") ?? undefined });
      }
    } finally {
      this.activePromptControllers.delete(promptId);
      await this.syncSessionIndex({ status: "idle", title });
      this.emitEvent({ data: this.listPrompts(), type: "prompt" });
      this.emitEvent({ data: this.readSessionDetails(), type: "state" });
    }
  }

  private async finishPrompt(
    promptId: string,
    patch: { error?: string; resultMessageId?: string; status: PromptRecord["status"] },
  ): Promise<void> {
    this.updatePrompt(promptId, patch);
    this.deleteMetadata("active_prompt_id");
    this.writeMetadata("status", "idle");
  }

  private readGatewayConfig(request: Request): AppConfig {
    const activeGateway = request.headers.get("x-dodo-gateway") === "ai-gateway" ? "ai-gateway" : "opencode";
    return {
      activeGateway,
      aiGatewayBaseURL: request.headers.get("x-dodo-ai-base-url") ?? this.env.AI_GATEWAY_BASE_URL,
      gitAuthorEmail: this.env.GIT_AUTHOR_EMAIL ?? "dodo@example.com",
      gitAuthorName: this.env.GIT_AUTHOR_NAME ?? "Dodo",
      model: request.headers.get("x-dodo-model") ?? this.env.DEFAULT_MODEL,
      opencodeBaseURL: request.headers.get("x-dodo-opencode-base-url") ?? this.env.OPENCODE_BASE_URL,
    };
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
    if (status === "running" && !activePromptId && !this.activePromptControllers.size) {
      this.writeMetadata("status", "idle");
      status = "idle";
      // Fire-and-forget sync to UserControl
      void this.syncSessionIndex({ status: "idle" }).catch(() => {});
    }
    const totals = this.db.one("SELECT COALESCE(SUM(token_input), 0) AS total_in, COALESCE(SUM(token_output), 0) AS total_out FROM messages");
    return {
      activePromptId,
      activeStreamCount: this.clients.size,
      createdAt,
      messageCount: this.messageCount(),
      ownerEmail,
      sessionId,
      status,
      totalTokenInput: Number(totals?.total_in ?? 0),
      totalTokenOutput: Number(totals?.total_out ?? 0),
      updatedAt,
    };
  }

  private insertMessage(input: {
    authorEmail?: string | null;
    content: string;
    model: string | null;
    provider: string | null;
    role: ChatMessageRecord["role"];
    tokenInput?: number;
    tokenOutput?: number;
  }): ChatMessageRecord {
    const sessionId = this.sessionId();
    const messageId = crypto.randomUUID();
    const createdAtEpoch = nowEpoch();
    const createdAt = new Date(createdAtEpoch * 1000).toISOString();

    this.db.exec(
      "INSERT INTO messages (id, session_id, role, content, model, provider, author_email, created_at, token_input, token_output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      messageId,
      sessionId,
      input.role,
      input.content,
      input.model,
      input.provider,
      input.authorEmail ?? null,
      createdAtEpoch,
      input.tokenInput ?? 0,
      input.tokenOutput ?? 0,
    );

    this.writeMetadata("updated_at", createdAt);
    this.setState({ ...this.readSessionDetails() });

    return {
      authorEmail: input.authorEmail ?? null,
      content: input.content,
      createdAt,
      id: messageId,
      model: input.model,
      provider: input.provider,
      role: input.role,
      tokenInput: input.tokenInput ?? 0,
      tokenOutput: input.tokenOutput ?? 0,
    };
  }

  private listMessages(): ChatMessageRecord[] {
    return this.db.all(
      "SELECT id, role, content, model, provider, author_email, created_at, token_input, token_output FROM messages ORDER BY created_at ASC, rowid ASC",
    ).map((row) => this.mapMessageRow(row));
  }

  private recentMessages(limit = 50): ChatMessageRecord[] {
    const rows = this.db.all(
      "SELECT id, role, content, model, provider, author_email, created_at, token_input, token_output FROM messages ORDER BY created_at DESC, rowid DESC LIMIT ?",
      limit,
    );
    return rows.reverse().map((row) => this.mapMessageRow(row));
  }

  private messageCount(): number {
    return Number(this.db.one("SELECT COUNT(*) AS count FROM messages")?.count ?? 0);
  }

  private mapMessageRow(row: SqlRow): ChatMessageRecord {
    return {
      authorEmail: row.author_email === null || row.author_email === undefined ? null : String(row.author_email),
      content: String(row.content ?? ""),
      createdAt: epochToIso(row.created_at),
      id: String(row.id),
      model: row.model === null ? null : String(row.model),
      provider: row.provider === null ? null : String(row.provider),
      role: row.role as ChatMessageRecord["role"],
      tokenInput: Number(row.token_input ?? 0),
      tokenOutput: Number(row.token_output ?? 0),
    };
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
      createdAt: epochToIso(entry.createdAt),
      mimeType: entry.mimeType,
      name: entry.name,
      path: entry.path,
      size: entry.size,
      type: entry.type,
      updatedAt: epochToIso(entry.updatedAt),
    };
  }

  // ─── Approval Queue ───

  /** Submit a tool call for approval (used by the agentic loop in the future). */
  submitApproval(toolName: string, toolArgs: unknown): string {
    const id = crypto.randomUUID();
    this.db.exec(
      "INSERT INTO approval_queue (id, tool_name, tool_args, status, requested_at) VALUES (?, ?, ?, 'pending', ?)",
      id,
      toolName,
      JSON.stringify(toolArgs),
      nowEpoch(),
    );
    this.emitEvent({ data: { id, toolName, status: "pending" }, type: "approval" });
    return id;
  }

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
    return (await response.json()) as AppConfig;
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
    this.db.exec("DELETE FROM messages");
    this.db.exec("DELETE FROM prompts");
    this.db.exec("DELETE FROM cron_jobs");
    this.db.exec("DELETE FROM metadata");

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
