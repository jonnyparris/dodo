import type { Artifacts } from "./artifacts-types";
import type { CodingAgent } from "./coding-agent";
import type { SharedIndex } from "./shared-index";
import type { UserControl } from "./user-control";

export interface Env {
  AI_GATEWAY_BASE_URL: string;
  AI_GATEWAY_DEFAULT_MODEL?: string;
  AI_GATEWAY_KEY?: string;
  ALLOW_UNAUTHENTICATED_DEV?: string;
  ASSETS?: Fetcher;
  ARTIFACTS: Artifacts;
  BROWSER?: Fetcher;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  DEFAULT_MODEL: string;
  DODO_MCP_TOKEN?: string;
  DODO_COMMIT?: string;
  DODO_VERSION?: string;
  GIT_AUTHOR_EMAIL?: string;
  GIT_AUTHOR_NAME?: string;
  LOADER?: WorkerLoader;
  OPENCODE_BASE_URL: string;
  OUTBOUND?: Fetcher;
  WORKSPACE_BUCKET?: R2Bucket;

  // Durable Object bindings
  CODING_AGENT: DurableObjectNamespace<CodingAgent>;
  USER_CONTROL: DurableObjectNamespace<UserControl>;
  SHARED_INDEX: DurableObjectNamespace<SharedIndex>;

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
  activeGateway: "opencode" | "ai-gateway";
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
  compactionCount: number;
  contextBudget: number;
  contextUsagePercent: number;
  contextWindow: number;
  createdAt: string;
  messageCount: number;
  model: string;
  ownerEmail?: string;
  sessionId: string;
  status: "idle" | "running" | "deleted";
  totalTokenInput: number;
  totalTokenOutput: number;
  updatedAt: string;
}

export interface ChatMessageRecord {
  attachments?: Array<{ mediaType: string; url: string }>;
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
  activeGateway?: "opencode" | "ai-gateway";
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

export type WorkerRunStatus =
  | "session_created"
  | "repo_ready"
  | "branch_created"
  | "edit_applied"
  | "commit_created"
  | "prompt_running"
  | "push_verified"
  | "checks_running"
  | "checks_passed"
  | "done"
  | "failed";

export interface WorkerRunRecord {
  baseBranch: string;
  branch: string;
  commitMessage: string | null;
  createdAt: string;
  expectedFiles: string[];
  failureSnapshotId: string | null;
  id: string;
  lastError: string | null;
  parentSessionId: string | null;
  prUrl?: string | null;
  repoDir: string;
  repoId: string;
  repoUrl: string;
  sessionId: string;
  status: WorkerRunStatus;
  strategy: "deterministic" | "agent";
  title: string;
  updatedAt: string;
  verification: Record<string, unknown> | null;
  /** GitHub Actions workflow filename for external verification (e.g. "dodo-verify.yml"). Null = skip verify gate. */
  verifyWorkflow?: string | null;
  /** GitHub Actions workflow run id once triggered. */
  verifyWorkflowRunId?: string | null;
  /** Public URL of the workflow run for humans to inspect. */
  verifyWorkflowHtmlUrl?: string | null;
}

export interface FailureSnapshotRecord {
  createdAt: string;
  id: string;
  payload: Record<string, unknown>;
  runId: string;
}

export interface WorkspaceEntry {
  createdAt: string | null;
  mimeType: string;
  name: string;
  path: string;
  size: number;
  type: "file" | "directory" | "symlink";
  updatedAt: string | null;
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
