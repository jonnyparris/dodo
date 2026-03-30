export type GatewayType = "opencode" | "ai-gateway";

export interface Env {
  AI_GATEWAY_BASE_URL: string;
  AI_GATEWAY_KEY?: string;
  ALLOW_UNAUTHENTICATED_DEV?: string;
  ASSETS?: Fetcher;
  CF_ACCESS_AUD: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  DEFAULT_MODEL: string;
  DODO_MCP_TOKEN?: string;
  DODO_VERSION?: string;
  GIT_AUTHOR_EMAIL?: string;
  GIT_AUTHOR_NAME?: string;
  LOADER?: WorkerLoader;
  OPENCODE_BASE_URL: string;
  OUTBOUND?: Fetcher;
  WORKSPACE_BUCKET?: R2Bucket;

  // Durable Object bindings
  CODING_AGENT: DurableObjectNamespace;
  USER_CONTROL: DurableObjectNamespace;
  SHARED_INDEX: DurableObjectNamespace;

  /** @deprecated Kept for migration only */
  APP_CONTROL: DurableObjectNamespace;

  // Secrets (wrangler secret)
  SECRETS_MASTER_KEY?: string;
  COOKIE_SECRET?: string;

  // Admin
  ADMIN_EMAIL?: string;

  // Per-user secrets (deprecated as env vars — now in UserControl encrypted_secrets)
  // Kept temporarily for migration and fallback
  GITHUB_TOKEN?: string;
  GITLAB_TOKEN?: string;
  NTFY_TOPIC?: string;
  OPENCODE_GATEWAY_TOKEN?: string;
}

export interface AppConfig {
  activeGateway: GatewayType;
  aiGatewayBaseURL: string;
  gitAuthorEmail: string;
  gitAuthorName: string;
  model: string;
  opencodeBaseURL: string;
}

export interface AccessIdentity {
  email: string | null;
  source: "access" | "dev" | "share";
}

export interface SessionState {
  activeStreamCount: number;
  activePromptId?: string | null;
  createdAt: string;
  messageCount: number;
  ownerEmail?: string;
  sessionId: string;
  status: "idle" | "running" | "deleted";
  totalTokenInput: number;
  totalTokenOutput: number;
  updatedAt: string;
}

export interface ChatMessageRecord {
  authorEmail?: string | null;
  content: string;
  createdAt: string;
  id: string;
  model: string | null;
  provider: string | null;
  role: "assistant" | "system" | "tool" | "user";
  tokenInput: number;
  tokenOutput: number;
}

export interface UpdateConfigRequest {
  activeGateway?: GatewayType;
  aiGatewayBaseURL?: string;
  gitAuthorEmail?: string;
  gitAuthorName?: string;
  model?: string;
  opencodeBaseURL?: string;
}

export interface SessionIndexRecord {
  createdAt: string;
  createdBy: string;
  id: string;
  ownerEmail: string;
  status: string;
  title: string | null;
  updatedAt: string;
}

export interface SessionEvent {
  data: unknown;
  type: string;
}

export interface PromptRecord {
  authorEmail?: string | null;
  content: string;
  createdAt: string;
  error: string | null;
  id: string;
  resultMessageId: string | null;
  status: "queued" | "running" | "completed" | "failed" | "aborted";
  updatedAt: string;
}

export interface WorkspaceEntry {
  createdAt: string;
  mimeType: string;
  name: string;
  path: string;
  size: number;
  type: "file" | "directory" | "symlink";
  updatedAt: string;
}

export interface AllowlistEntry {
  createdAt: string;
  hostname: string;
}

export interface MemoryEntry {
  content: string;
  createdAt: string;
  id: string;
  tags: string[];
  title: string;
  updatedAt: string;
}

export interface CronJobRecord {
  callback: string;
  createdAt: string;
  description: string;
  id: string;
  nextRunAt: string | null;
  payload: string;
  scheduleType: "scheduled" | "delayed" | "cron" | "interval";
}

export interface SessionSnapshot {
  files: Array<{ content: string; path: string }>;
  messages: ChatMessageRecord[];
  title: string | null;
}

// ─── New multi-tenancy types ───

export interface KeyEnvelope {
  id: string;
  pbkdf2Salt: string;
  wrappedDekPasskey: string;
  wrappedDekServer: string;
  createdAt: string;
  rotatedAt: string | null;
}

export interface EncryptedSecret {
  key: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserRecord {
  email: string;
  displayName: string | null;
  role: "admin" | "user";
  blockedAt: number | null;
  browserEnabled: boolean;
  createdAt: string;
  lastSeenAt: string;
}
