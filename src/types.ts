import type { Artifacts } from "./artifacts-types";
import type { CodingAgent } from "./coding-agent";
import type { AllowlistOutbound } from "./outbound";
import type { SharedIndex } from "./shared-index";
import type { UserControl } from "./user-control";

export interface Env {
  AI: Ai;
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
  /** Default model for the `explore` subagent. When unset, falls back to
   *  the getExploreModel() heuristic (cheap model by provider family). */
  DEFAULT_EXPLORE_MODEL?: string;
  /** Default model for the `task` subagent. Same fallback semantics. */
  DEFAULT_TASK_MODEL?: string;
  DEPLOY_MCP_CATALOG_CONFIG?: string;
  DODO_MCP_TOKEN?: string;
  DODO_COMMIT?: string;
  DODO_VERSION?: string;
  GIT_AUTHOR_EMAIL?: string;
  GIT_AUTHOR_NAME?: string;
  LOADER?: WorkerLoader;
  OPENCODE_BASE_URL: string;
  /**
   * Self-binding to {@link AllowlistOutbound}. Typed as a
   * `LoopbackServiceStub` so callers can invoke
   * `env.OUTBOUND({ props: { ownerId } })` to receive a per-call Fetcher
   * with the owner identity carried via workerd's runtime props
   * mechanism — see src/outbound.ts for the consumer side.
   */
  OUTBOUND?: LoopbackServiceStub<AllowlistOutbound>;
  WORKER_URL: string;
  WORKSPACE_BUCKET?: R2Bucket;
  /**
   * Bucket for inter-DO fork snapshots. Snapshots are JSON payloads
   * containing the full workspace (including base64-encoded `.git/objects`
   * pack files) that fork sources upload and fork targets download. Stored
   * here instead of DO SQLite because real-world payloads exceed the
   * SQLITE_TOOBIG cell limit (~2 MB) — dodo's seed snapshot is ~9 MB.
   * Objects are short-lived: written by `/fork-snapshots` POST, read by
   * `/snapshot/import`, deleted by `/fork-snapshots/:id` DELETE.
   */
  FORK_SNAPSHOTS?: R2Bucket;

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

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type TodoPriority = "low" | "medium" | "high";

export interface TodoItem {
  id: number;
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
}

export interface TodoStore {
  list: () => TodoItem[];
  add: (content: string, priority?: TodoPriority) => void;
  update: (id: number, patch: { status?: TodoStatus; content?: string; priority?: TodoPriority }) => boolean;
  clear: () => void;
}

export interface AppConfig {
  activeGateway: "opencode" | "ai-gateway";
  aiGatewayBaseURL: string;
  gitAuthorEmail: string;
  gitAuthorName: string;
  model: string;
  opencodeBaseURL: string;
  /** Optional user preamble prepended to the system prompt every session. */
  systemPromptPrefix?: string;
  /**
   * Default model used by the `explore` subagent when the model doesn't
   * pass an explicit `model` arg. Leave unset to use the built-in
   * getExploreModel() heuristic (cheap model by provider family), which
   * falls back to Kimi K2.6 for unfamiliar providers. Mixing providers is
   * supported — e.g. main model anthropic/claude-opus-4-7, explore model
   * @cf/moonshotai/kimi-k2.6. The subagent's gateway is auto-selected
   * from the model ID (@cf/* → ai-gateway, everything else → opencode).
   */
  exploreModel?: string;
  /** Same as exploreModel but for the generic `task` subagent. */
  taskModel?: string;
  /**
   * Where explore subagent work runs.
   *
   * - `"inprocess"` (default): today's path — a blocking `generateText()`
   *   call inside the parent's turn, tools share the parent's workspace.
   * - `"facet"`: delegates to `ExploreAgent`, a separately-addressable
   *   Durable Object (facet) on the same machine. Unlocks parallel
   *   explore fan-out (phase 3) and lets long explores run without
   *   parking the parent's turn against the step budget.
   *
   * Both modes produce the same output shape. Default stays `"inprocess"`
   * so a config-level rollback is a no-op toggle.
   */
  exploreMode?: "inprocess" | "facet";
  /**
   * Where task subagent work runs — see `exploreMode` for semantics.
   * Paired with phase-4 scratch-workspace support.
   */
  taskMode?: "inprocess" | "facet";
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
  attachments?: Array<{ mediaType: string; url: string; source?: "user" | "assistant" | "tool" }>;
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
  /** Pass empty string to clear. Capped server-side at 4 KB. */
  systemPromptPrefix?: string;
  /** Pass empty string to clear. Must be a valid model ID if set. */
  exploreModel?: string;
  /** Pass empty string to clear. Must be a valid model ID if set. */
  taskModel?: string;
  /** Override explore-subagent dispatch mode. See AppConfig.exploreMode. */
  exploreMode?: "inprocess" | "facet";
  /** Override task-subagent dispatch mode. See AppConfig.taskMode. */
  taskMode?: "inprocess" | "facet";
}

export interface SessionIndexRecord {
  createdAt: string;
  createdBy: string;
  id: string;
  ownerEmail: string;
  status: string;
  title: string | null;
  updatedAt: string;
  /**
   * Session classification. `'user'` is the default — a regular interactive
   * session that shows up in the sidebar and is subject to idle cleanup.
   * `'seed'` is an admin-owned warm clone used as a fork source for
   * `getOrCreateSeedSession` / `forkSeedSession`. Seeds are hidden from the
   * regular `/sessions` listing and exempt from idle cleanup.
   */
  kind: "user" | "seed";
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

/**
 * A row in the global seed-session registry. Each entry points at an
 * admin-owned session that has the repo cloned at HEAD of `baseBranch`,
 * so subsequent runs can fork it instead of running `git clone`.
 *
 * Created and refreshed manually via the admin UI / MCP — never
 * auto-evicted, since the cost of a stale clone is far lower than the
 * cost of the next user paying clone time and tokens for nothing.
 */
export interface SeedRecord {
  repoId: string;
  baseBranch: string;
  sessionId: string;
  ownerEmail: string;
  repoUrl: string;
  repoDir: string;
  createdAt: string;
  updatedAt: string;
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

// ─── Scheduled new-session jobs ───

export type ScheduledSessionType = "delayed" | "scheduled" | "cron" | "interval";
export type ScheduledSessionSource = "fresh" | "fork";

export interface ScheduledSessionRecord {
  id: string;
  description: string;
  prompt: string;
  scheduleType: ScheduledSessionType;
  /** Raw schedule values — only one is populated per row. */
  delaySeconds: number | null;
  targetEpoch: number | null;
  cronExpression: string | null;
  intervalSeconds: number | null;
  sourceType: ScheduledSessionSource;
  sourceSessionId: string | null;
  title: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastSessionId: string | null;
  runCount: number;
  failureCount: number;
  stalledAt: string | null;
  lastError: string | null;
  createdAt: string;
  createdBy: string;
}


