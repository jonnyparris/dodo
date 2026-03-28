export type GatewayType = "opencode" | "ai-gateway";

export interface Env {
  AI_GATEWAY_BASE_URL: string;
  AI_GATEWAY_KEY?: string;
  ALLOW_UNAUTHENTICATED_DEV?: string;
  APP_CONTROL: DurableObjectNamespace;
  ASSETS?: Fetcher;
  CF_ACCESS_AUD: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  CODING_AGENT: DurableObjectNamespace;
  DEFAULT_MODEL: string;
  GITHUB_TOKEN?: string;
  GITLAB_TOKEN?: string;
  GIT_AUTHOR_EMAIL?: string;
  GIT_AUTHOR_NAME?: string;
  LOADER?: WorkerLoader;
  DODO_MCP_TOKEN?: string;
  DODO_VERSION?: string;
  NTFY_TOPIC?: string;
  OPENCODE_BASE_URL: string;
  OPENCODE_GATEWAY_TOKEN?: string;
  WORKSPACE_BUCKET?: R2Bucket;
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
  source: "access" | "dev";
}

export interface SessionState {
  activeStreamCount: number;
  activePromptId?: string | null;
  createdAt: string;
  messageCount: number;
  sessionId: string;
  status: "idle" | "running" | "deleted";
  totalTokenInput: number;
  totalTokenOutput: number;
  updatedAt: string;
}

export interface ChatMessageRecord {
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
  id: string;
  status: string;
  title: string | null;
  updatedAt: string;
}

export interface SessionEvent {
  data: unknown;
  type: string;
}

export interface PromptRecord {
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
