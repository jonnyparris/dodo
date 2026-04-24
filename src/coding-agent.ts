import { Workspace, createWorkspaceStateBackend } from "@cloudflare/shell";
import { type Connection, type ConnectionContext, type WSMessage } from "agents";
import type { ArtifactsRepo } from "./artifacts-types";
import { flushTurnToArtifacts } from "./artifacts-flush";
import { generateText, streamText, type FileUIPart, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import { buildProvider, buildToolsForThink } from "./agentic";
import type { AttachmentRef } from "./attachments";
import { rewriteAttachmentsForClient, uploadAttachment } from "./attachments";
import { getUserControlStub, isAdmin } from "./auth";
import { log } from "./logger";
import { HttpMcpGatekeeper, type McpGatekeeper, type McpGatekeeperConfig } from "./mcp-gatekeeper";
import { sendNotification } from "./notify";
import { runSandboxedCode } from "./executor";
import { createWorkspaceGit, defaultAuthor, resolveRemoteToken, verifyRemoteBranch } from "./git";
import { PresenceTracker } from "./presence";
import { AgentConnectionTransport } from "./rpc-transport";
import { epochToIso, nowEpoch, SqlHelper } from "./sql-helpers";
import {
  Think,
  type ChatMessageOptions,
  type DodoConfig,
  type FiberCompleteContext,
  type FiberRecoveryContext,
  type MessageMetadata,
  type StreamCallback,
  type StreamableResult,
  type UIMessage,

  truncateToolOutput,
  uiMessageToChatRecord,
  chatRecordToUIMessage,
} from "./think-adapter";
import type { SnapshotV2 } from "./think-adapter";
import type { AppConfig, ChatMessageRecord, CronJobRecord, Env, PromptRecord, SessionEvent, SessionSnapshot, SessionState, TodoPriority, TodoStatus, TodoStore, WorkspaceEntry } from "./types";
import { FALLBACK_MODELS, WORKERS_AI_MODELS, FLUX_IMAGE_MODEL, FLUX_IMAGE_MEDIA_TYPE, FLUX_MAX_PROMPT_LENGTH, extractGeneratePrompt } from "./shared-index";

/**
 * Context window sizes (in tokens) by model ID. Used for token budget enforcement.
 *
 * Derived from the shared model catalog in shared-index.ts so the two lists
 * cannot drift. If a model is missing from the catalog but used at runtime,
 * DEFAULT_CONTEXT_WINDOW applies. See issue #34.
 */
const CONTEXT_WINDOW_TOKENS: Record<string, number> = Object.fromEntries(
  [...FALLBACK_MODELS, ...WORKERS_AI_MODELS].map((m) => [m.id, m.contextWindow]),
);
const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Budget factor — use 80% of context window for messages, leave 20% for response. */
const CONTEXT_BUDGET_FACTOR = 0.8;

/**
 * Compaction settings.
 * When context usage exceeds COMPACTION_TRIGGER_PERCENT of the budget, older
 * messages are summarized by an LLM call and stored as a compaction record.
 * Think's assembleContext() automatically injects the summary in place of
 * the original messages on subsequent turns.
 */
const COMPACTION_TRIGGER_PERCENT = 60;
/** Fraction of messages to compact (from the oldest end). */
const COMPACTION_MESSAGE_FRACTION = 0.5;
/** Model to use for generating compaction summaries — cheap and fast. */
// Use Haiku 4.5 for compaction — fast, cheap ($1/M input, 3x cheaper than Sonnet),
// and good at structured summarization. Falls back to session model if unavailable.
const COMPACTION_MODEL = "anthropic/claude-haiku-4-5";

/** Zero-cost marker that replaces cleared tool output — ~8 tokens. */
const CLEARED_MARKER = "[Old tool result content cleared]";

/**
 * Content-aware tokens-per-char ratios derived from Anthropic tokenizer
 * measurements. The flat `len/3.5` heuristic under-counts code and
 * tool-result JSON by 15-25 % because those payloads have dense punctuation
 * and no word structure to benefit from BPE merges.
 *
 * These numbers come from sampling Anthropic's tokenizer against
 * representative Dodo traffic (code files, tool outputs, chat messages).
 * Keep conservative — safer to over-estimate than to trip the context
 * limit mid-step.
 */
const CHARS_PER_TOKEN_PROSE = 4.0;
const CHARS_PER_TOKEN_CODE = 2.9;
const CHARS_PER_TOKEN_JSON = 2.6;
const CHARS_PER_TOKEN_DEFAULT = 3.3;

/**
 * Heuristically classify a string and return its chars-per-token ratio.
 * Cheap: one pass over a small prefix.
 */
function charsPerTokenFor(sample: string): number {
  if (sample.length === 0) return CHARS_PER_TOKEN_DEFAULT;
  // Cap the sample — we only need a signal, not full-text analysis
  const head = sample.length > 2048 ? sample.slice(0, 2048) : sample;
  const punctCount = (head.match(/[{}[\]":,;=<>()]/g) ?? []).length;
  const braceCount = (head.match(/[{}[\]]/g) ?? []).length;
  const wordCount = (head.match(/[A-Za-z]{3,}/g) ?? []).length;
  const totalChars = head.length;

  // JSON-dominated: lots of quote/brace/colon punctuation relative to chars
  if (braceCount >= 3 && punctCount / totalChars > 0.1) return CHARS_PER_TOKEN_JSON;
  // Code-ish: dense punctuation plus enough word tokens to suggest
  // identifiers rather than natural prose
  if (punctCount / totalChars > 0.08 && wordCount >= 5) return CHARS_PER_TOKEN_CODE;
  // Prose: many multi-character words, sparse punctuation
  if (wordCount > totalChars / 30 && punctCount / totalChars < 0.05) return CHARS_PER_TOKEN_PROSE;
  return CHARS_PER_TOKEN_DEFAULT;
}

/**
 * Token estimate for a single ModelMessage. Content-aware: picks a
 * chars-per-token ratio based on whether the serialized message looks
 * like JSON, code, prose, or mixed.
 *
 * The estimate is used by the autocompaction guard (trigger at 60% of
 * budget), the pre-step budget check, and the compaction cutoff walk. All
 * three prefer over-estimates — a false-positive compaction is cheap, a
 * false-negative "just squeeze it in" is a 429.
 *
 * Cheap enough to call on every message each step.
 */
export function estimateMessageTokens(msg: ModelMessage): number {
  const serialized = JSON.stringify(msg);
  const cpt = charsPerTokenFor(serialized);
  return Math.ceil(serialized.length / cpt);
}

/**
 * Sum of estimateMessageTokens across an array. Used by the pre-step budget
 * check and the loop-entry oversized-prompt guard in onChatMessage().
 */
export function estimateMessagesTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

/**
 * Image attachment limits — keep in sync with `public/js/dodo-chat.js`.
 * Base64 encodes 3 bytes → 4 chars, so MAX_IMAGE_BASE64_LENGTH ≈ MAX_IMAGE_BYTES * 4/3.
 * Kept tight to protect the DO isolate: 5 images × 4MB base64 = 20MB peak payload.
 */
const MAX_IMAGES_PER_MESSAGE = 5;
const MAX_IMAGE_BASE64_LENGTH = 4_000_000; // ~3MB decoded per image
const ALLOWED_IMAGE_MEDIA_TYPES = /^image\/(png|jpeg|gif|webp)$/;
// Sampled base64 validation — avoids running a regex across a multi-MB string, which
// is expensive in the DO isolate. Base64 must have length divisible by 4; the head/tail
// sampling catches most corruption without the full scan. convertToLanguageModelV3DataContent
// in the AI SDK will surface any deeper decoding errors at send time.
const BASE64_SAMPLE_REGEX = /^[A-Za-z0-9+/]+=*$/;
const isLikelyBase64 = (s: string): boolean => {
  if (s.length % 4 !== 0) return false;
  const head = s.slice(0, 128);
  const tail = s.slice(-128);
  return BASE64_SAMPLE_REGEX.test(head) && BASE64_SAMPLE_REGEX.test(tail);
};
const imageAttachmentSchema = z.object({
  data: z.string().min(1).max(MAX_IMAGE_BASE64_LENGTH).refine(isLikelyBase64, "Invalid base64"),
  mediaType: z.string().regex(ALLOWED_IMAGE_MEDIA_TYPES),
}).strict();
const sendMessageSchema = z.object({
  content: z.string().trim().min(1),
  images: z.array(imageAttachmentSchema).max(MAX_IMAGES_PER_MESSAGE).optional(),
}).strict();
/** /generate schema — FLUX-1-schnell rejects >2048 chars, so enforce at the edge. */
const generateImageSchema = z.object({
  content: z.string().trim().min(1).max(FLUX_MAX_PROMPT_LENGTH),
}).strict();
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

/** System prompt aligned with Think's real workspace tools. */
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
  "**Your first action for any non-trivial request** — use `todo_add` to write down the plan. One todo per distinct step. Then start working through them with `todo_update` as you go. This isn't optional scaffolding; it's how you stay oriented across compactions, avoid repeating yourself, and give the user a legible view of progress.",
  "",
  "**When to skip todos:** the task is a single tool call (\"read this file\", \"run git status\", \"fix this typo\"). Everything else gets todos.",
  "",
  "### Decision triggers",
  "",
  "- User says \"update the README\" / \"add a feature\" / \"fix this bug across the repo\" → `todo_add` first, then work.",
  "- You catch yourself about to chain 3+ tool calls → stop, `todo_add` the plan, then resume.",
  "- A step turns out bigger than expected → `todo_add` the subtasks.",
  "- You complete a todo → `todo_update` to mark it `completed` in the same turn, before moving on.",
  "- Context is getting dense (many tool results accumulated) → call `todo_list` to re-ground yourself before the next action.",
  "",
  "### Delegate bounded work with `task`",
  "",
  "For sub-jobs that will take 3+ of your own steps and don't need the full conversation context, call `task` with a self-contained prompt. The subagent runs in its own context window and returns a compact summary. Use cases:",
  "",
  "- \"review these 6 files and report any dead code\" → `task`",
  "- \"update all imports of X to Y across src/\" → `task`",
  "- \"run the test suite and summarise failures\" → `task`",
  "",
  "Don't use `task` for a single lookup (just call the tool) or for anything the main conversation needs to see in detail.",
  "",
  "### Standing rules",
  "",
  "1. **Check memory first.** If a memory MCP is connected, search it for patterns, decisions, or prior work related to the task.",
  "2. **Use `explore` for ALL codebase discovery.** When you need to find where something is defined, understand how a feature works, or locate relevant files — use `explore`. Do NOT use `read`, `list`, `find`, or `grep` for open-ended exploration. `explore` runs a search agent in a separate context window and returns a compact summary. Using direct tools for discovery will exhaust your context budget before you can make any edits.",
  "",
  "   Examples of when to use `explore`:",
  "   - 'Where is the config schema defined?' → `explore`",
  "   - 'How does the settings UI work?' → `explore`",
  "   - 'Find all files related to git author' → `explore`",
  "",
  "   Examples of when to use direct tools:",
  "   - You already know the file and line numbers → `read` with offset/limit",
  "   - You need to make an edit → `edit`",
  "   - You need to search for a specific string → `grep`",
  "",
  "3. **Read only what you need.** After `explore` tells you which files and lines matter, use `read` with `offset`/`limit` to fetch only the sections you need to edit.",
  "4. **Plan, then edit.** State your plan in one short paragraph (or a todo list, preferred), then execute. Don't narrate each step.",
  "5. **Stay focused.** Only make changes that are directly requested or clearly necessary.",
  "6. **Commit completed work only.** When you finish a coherent, working chunk in a git repo, stage and commit it before you reply unless the user explicitly says not to commit. Don't commit half-finished scaffolding or partial changes that would break the build. If your context runs out mid-task, commit what's complete and describe what remains.",
  "7. **Delete unused code.** No commented-out code, no `_unused` renames.",
  "8. **Be security-conscious.** Never commit secrets or credentials.",
  "",
  "## Workspace tools",
  "",
  "You have workspace tools for file operations:",
  "",
  "| Tool | Purpose | Key params |",
  "|------|---------|------------|",
  "| **explore** | Search agent for codebase discovery (compact summary) | `query`, `scope` |",
  "| **task** | Delegate a bounded sub-task to a fresh subagent (read+write workspace tools) | `prompt`, `scope?` |",
  "| **read** | Read file contents | `path`, `offset`, `limit` (line numbers) |",
  "| **write** | Create or overwrite a file | `path`, `content` |",
  "| **edit** | Find-and-replace (unique match) | `path`, `old_string`, `new_string` |",
  "| **replace_all** | Replace ALL occurrences of a string | `path`, `old_string`, `new_string` |",
  "| **grep** | Search file contents by regex | `query`, `include` (glob filter) |",
  "| **delete** | Remove a file or directory | `path`, `recursive` |",
  "| **todo_list** | List session todos with status and priority | — |",
  "| **todo_add** | Append a todo | `content`, `priority?` |",
  "| **todo_update** | Update todo `status`, `content`, or `priority` | `id`, `status?`, ... |",
  "| **todo_clear** | Clear all todos | — |",
  "",
  "### Token budget",
  "",
  "Your context window is shared across all tool calls in a single prompt. Every file you read, every tool result — it all accumulates. If you exhaust the budget on reading, you won't have room to edit.",
  "",
  "- **`explore` first, `read` second.** Use `explore` for any question about the codebase (where is X defined? how does Y work?). Use `read` only for the specific lines you need to edit.",
  "- **Use `read` with `offset` and `limit`.** Don't read a 2000-line file if you only need lines 50-80.",
  "- **Use `edit` instead of `write`** for targeted changes. Rewriting an entire file wastes context.",
  "- **Use `grep` to find specific lines** before reading. It returns line numbers — use those to read the exact range.",
  "- **Never read the same file twice** unless it changed.",
  "- **Avoid generated/lock files** (package-lock.json, *.min.js, *.map).",
  "",
  "## Code execution",
  "",
  "The **codemode** tool runs JavaScript in a sandboxed Worker with access to the workspace filesystem and git.",
  "Use it for: build scripts, tests, one-off computations, or calling external APIs via fetch() (GitHub and GitLab auth is injected automatically).",
  "The sandbox has a 30-second timeout and restricted network access.",
  "",
  "## Git",
  "",
  "You have git tools: git_clone_known, git_clone, git_status, git_add, git_commit, git_push_checked, git_push, git_pull,",
  "git_branch, git_checkout, git_diff, git_log, git_verify_remote_branch.",
  "Authentication for GitHub and GitLab is automatic — you do NOT need tokens.",
  "",
  "### Git safety rules",
  "",
  "- Always run git_status before committing.",
  "- Stage specific files, not '.' (unless you intend to commit everything).",
  "- Write clear, concise commit messages that explain *why*.",
  "- Never force-push unless the user explicitly asks.",
  "- Prefer `git_clone_known` for built-in repos. Use `git_push_checked` with an explicit branch ref.",
  "",
  "## Working with errors",
  "",
  "When something fails: state what failed, fix it, move on. Don't apologize repeatedly.",
  "",
  "## Context management",
  "",
  "**Every tool result stays in your context window.** This is the most important constraint.",
  "",
  "- Your context budget is limited. Plan efficiently — use `explore` for discovery, then targeted reads for edits.",
  "- Large outputs are automatically truncated. If you see `[truncated]`, use `read` with `offset`/`limit` to get the specific portion you need.",
  "- The workspace is ephemeral per session. Clone repos to get their contents.",
  "- If the user switches topics, suggest a fresh session to keep context clean.",
  "- Users can prefix a message with `!!` to minimize its context footprint. You'll see `[message excluded by user]` as a placeholder instead of the original content.",
].join("\n");

/** Build a LanguageModel from DodoConfig (Think per-session config). */
function buildProviderFromConfig(config: DodoConfig, env: Env): LanguageModel {
  const appConfig: AppConfig = {
    activeGateway: config.activeGateway,
    aiGatewayBaseURL: config.aiGatewayBaseURL,
    gitAuthorEmail: config.gitAuthorEmail,
    gitAuthorName: config.gitAuthorName,
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
    compactionCount: 0,
    contextBudget: 0,
    contextUsagePercent: 0,
    contextWindow: 0,
    createdAt: "",
    messageCount: 0,
    model: "",
    sessionId: "",
    status: "idle",
    totalTokenInput: 0,
    totalTokenOutput: 0,
    updatedAt: "",
  };

  /** Enable durable fiber recovery for async prompts. */
  override fibers = true;

  private readonly clients = new Map<WritableStreamDefaultWriter<Uint8Array>, Promise<void>>();
  private readonly db: SqlHelper;
  /** Captured token usage from the most recent onChatMessage() call. */
  private _lastUsage: { inputTokens: number; outputTokens: number } | null = null;
  /** Overflow recovery flag — prevents infinite retry loops on persistent overflow. */
  private _overflowRecoveryAttempted = false;
  /** Set by assembleContext() when messages are dropped due to token budget. */
  private _contextTruncated = false;
  /** Connected MCP gatekeepers, populated by connectMcpServers(). */
  private mcpGatekeepers: McpGatekeeper[] = [];
  /** MCP recursion depth from incoming request, propagated to outbound MCP calls. */
  private mcpDepth = 0;
  /** AbortController for the currently running fiber prompt. Signalled by handleAbort(). */
  private _fiberAbortController: AbortController | null = null;
  /**
   * Cached project-instructions content (AGENTS.md / CLAUDE.md) loaded from
   * the workspace. Warmed by `warmProjectInstructions()` at the top of
   * `onChatMessage()`, consumed synchronously by `getSystemPrompt()`.
   *
   * `null` = not yet found. We retry the search each turn until something
   * is found (which matters for sessions where the user clones a repo on
   * turn 1 — the AGENTS.md only exists after the clone lands). Once found,
   * the result is stable for the session (prompt-cache friendly).
   */
  private _projectInstructions: string | null = null;
  /**
   * Per-tool-call attachment references captured during streaming. Populated
   * by the `onToolAttachments` callback threaded into `buildToolsForThink`.
   * Cleared per chat turn in `runThinkChat` so attachments from one prompt
   * don't bleed into the next. Used to enrich the streamed `tool_result`
   * SSE event with images produced by the tool.
   */
  private _toolAttachments: Map<string, AttachmentRef[]> = new Map();
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
    let prompt = SYSTEM_PROMPT;

    // Conditionally include browser tools section
    const browserEnabled = this.readMetadata("browser_enabled") === "true";
    if (browserEnabled) {
      prompt += [
        "",
        "",
        "## Browser",
        "",
        "You have full browser automation via the Chrome DevTools Protocol (CDP).",
        "",
        "**Two tools:**",
        "- `browser_search` — Write JS to query the CDP spec (~1.7MB, stays server-side). Use this to discover available commands, events, and types before executing them.",
        "- `browser_execute` — Write JS using a `cdp` helper to run CDP commands against a live headless Chrome session. The session is opened fresh per call and closed after.",
        "",
        "**`browser_execute` pattern:**",
        "A fresh browser with a blank page is launched per call. The CDP session is already attached to that page,",
        "so you can send page-scoped commands directly:",
        "1. Enable domains: `cdp.send(\"Page.enable\")`",
        "2. Navigate: `cdp.send(\"Page.navigate\", { url: \"...\" })`",
        "3. Wait for load, then act: `cdp.send(\"Page.captureScreenshot\", { format: \"png\" })`",
        "",
        "**Common tasks:**",
        "- Navigate + get text: `Page.navigate` → `Runtime.evaluate` with `document.body.innerText`",
        "- Screenshot: `Page.captureScreenshot` → returns base64 PNG",
        "- Click/type: `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`",
        "- Network: `Network.enable` → intercept/monitor requests",
        "- DOM inspection: `DOM.getDocument` → `DOM.querySelectorAll`",
        "",
        "Always use `browser_search` first if you're unsure which CDP method to use.",
      ].join("\n");
    }

    // Inject bounded workspace summary on first turn only.
    // Use this.messages.length <= 1 because Think's chat() persists the
    // user message before calling onChatMessage() → getSystemPrompt(),
    // so messageCount() is already 1 on the first turn.
    if (this.messages.length <= 1) {
      const summary = this.getWorkspaceSummary();
      if (summary) {
        prompt = `${prompt}\n\n## Current workspace\n\n${summary}`;
      }
    }

    // Inject project instructions (AGENTS.md / CLAUDE.md) if loaded.
    // Warmed by `warmProjectInstructions()` in onChatMessage before this
    // call, so it's safe to read synchronously. Included on every turn so
    // compaction summaries don't lose project-specific rules.
    if (this._projectInstructions) {
      prompt = `${prompt}\n\n## Project instructions\n\n${this._projectInstructions}`;
    }

    // Prepend user-customisable prefix (systemPromptPrefix in DodoConfig).
    // Placed at the very top so user rules take precedence over the default
    // Dodo prompt when models resolve conflicts.
    const config = this.getConfig();
    const prefix = config?.systemPromptPrefix?.trim();
    if (prefix) {
      prompt = `${prefix}\n\n---\n\n${prompt}`;
    }

    return prompt;
  }

  /**
   * Load project-local agent instructions from the workspace and cache
   * them on this instance. Called from onChatMessage() before
   * getSystemPrompt() so the sync accessor can see them.
   *
   * Searches (in order) for `AGENTS.md`, `CLAUDE.md`, `.cursorrules`,
   * `.rules` at the workspace root and the first direct subdirectory (git
   * clones typically land under `/<repo-name>/`). First match wins. Content
   * is capped at 6 KB with a middle-truncation notice.
   *
   * Idempotent: once attempted (success or miss), won't re-run. Stable
   * system prompt is friendlier to Anthropic prompt caching.
   */
  private async warmProjectInstructions(): Promise<void> {
    // Skip only if we've already FOUND instructions. If a previous turn
    // searched an empty workspace and found nothing, retry — the user may
    // have since cloned a repo. Without this, `git_clone` on turn 1 means
    // turn 2+ never sees the project's AGENTS.md.
    if (this._projectInstructions) return;

    const MAX_BYTES = 6_000;
    const candidates = ["AGENTS.md", "CLAUDE.md"];

    // Build search paths: workspace root + first-level subdirs (common for clones)
    const searchPaths: string[] = [];
    for (const name of candidates) {
      searchPaths.push(`/${name}`);
    }
    // Add first-level subdir candidates — most clones land under /<repo>/
    try {
      const entries = await this.workspace.readDir("/");
      for (const entry of entries) {
        // FileInfo: { name, type: 'file' | 'directory' | 'symlink', ... }
        if (entry.type === "directory" && entry.name && !entry.name.startsWith(".")) {
          for (const candidate of candidates) {
            searchPaths.push(`/${entry.name}/${candidate}`);
          }
        }
      }
    } catch {
      // readDir throws if the workspace's SQL tables aren't ready — skip
      // subdir search and try root-only paths. Not a real error.
    }

    for (const path of searchPaths) {
      // Workspace.readFile returns Promise<string | null> — null on miss,
      // not a throw. No try/catch needed for the normal not-found case.
      const content = await this.workspace.readFile(path);
      if (typeof content !== "string" || content.length === 0) continue;

      let trimmed = content.trim();
      if (trimmed.length > MAX_BYTES) {
        const head = trimmed.slice(0, Math.floor(MAX_BYTES * 0.7));
        const tail = trimmed.slice(-Math.floor(MAX_BYTES * 0.2));
        trimmed = `${head}\n\n[... truncated ${content.length - head.length - tail.length} bytes of ${path} ...]\n\n${tail}`;
      }

      this._projectInstructions = `Loaded from \`${path}\`:\n\n${trimmed}`;
      log("info", "project-instructions-loaded", {
        sessionId: this.sessionId(),
        path,
        bytes: trimmed.length,
      });
      return;
    }
  }

  /**
   * Build a bounded workspace summary — shallow root listing only.
   * Returns null if the workspace is empty. Capped at ~40 entries
   * to prevent bloating the system prompt on large repos.
   */
  private getWorkspaceSummary(): string | null {
    try {
      // Synchronous readDir not available — use the Think workspace's
      // internal SQL to get a fast root listing without async.
      const rows = this.db.all(
        "SELECT path, type FROM workspace_entries WHERE parent = '/' ORDER BY type DESC, path ASC LIMIT 40",
      );
      if (!rows.length) return null;

      const lines = rows.map((r) => {
        const name = String(r.path).split("/").filter(Boolean).pop() ?? String(r.path);
        return r.type === "directory" ? `${name}/` : name;
      });
      const total = this.db.one("SELECT COUNT(*) as cnt FROM workspace_entries WHERE parent = '/'");
      const count = Number(total?.cnt ?? lines.length);
      let result = "```\n" + lines.join("\n") + "\n```";
      if (count > 40) {
        result += `\n(${count} entries total, showing first 40)`;
      }
      return result;
    } catch {
      // workspace_entries table may not exist or be empty — no summary
      return null;
    }
  }

  override getTools(): ToolSet {
    const appConfig = this.getAppConfigFromThink();
    const ownerEmail = this.readMetadata("owner_email") ?? undefined;
    return buildToolsForThink(this.env, this.workspace, appConfig, {
      browserEnabled: this.readMetadata("browser_enabled") === "true",
      isAdminUser: isAdmin(ownerEmail ?? null, this.env),
      ownerId: this.resolveOwnerId(ownerEmail),
      ownerEmail,
      sessionId: this.sessionId(),
      // Forward tool-produced attachments (e.g. browser_execute screenshots)
      // to the SSE stream so the chat UI can render them in real time, and
      // persist them to SQLite so history restore after reload can surface
      // the same images. Persisted under `message_id = toolCallId` initially;
      // `runThinkChat` rebinds the rows to the assistant message id after
      // the stream completes.
      onToolAttachments: (toolCallId, attachments) => {
        this._toolAttachments.set(toolCallId, attachments);
        for (const a of attachments) {
          this.insertMessageAttachment({
            messageId: toolCallId,
            toolCallId,
            mediaType: a.mediaType,
            url: a.url,
            size: a.size,
            source: "tool",
          });
        }
        this.emitEvent({
          data: {
            toolCallId,
            attachments: rewriteAttachmentsForClient(
              attachments.map((a) => ({ mediaType: a.mediaType, url: a.url, size: a.size })),
            ),
          },
          type: "tool_attachments",
        });
      },
      stateBackend: this.stateBackend,
      mcpGatekeepers: this.mcpGatekeepers,
      todoStore: this.todoStore(),
    });
  }

  /**
   * Override onChatMessage with Dodo's own agentic loop.
   *
   * Instead of delegating to AI SDK's internal multi-step loop via
   * `streamText({ maxSteps: 15 })`, we run a while-loop calling
   * `streamText({ maxSteps: 1 })` per iteration. This gives us full
   * control between steps:
   *
   * - Reassemble context each iteration (clear old tool results)
   * - Detect doom loops (same tool+args 3× in a row)
   * - Enforce token budget thresholds (warn → wrap-up → hard stop)
   * - Trigger mid-loop compaction when context exceeds threshold
   * - Abort cleanly on signal
   *
   * Returns a custom StreamableResult whose toUIMessageStream() is an
   * async generator that concatenates chunks from all iterations.
   */
  override async onChatMessage(options?: ChatMessageOptions): Promise<StreamableResult> {
    this._lastUsage = null;

    // Warm project instructions (AGENTS.md / CLAUDE.md) before getSystemPrompt()
    // reads them. Idempotent — only loads once per session.
    await this.warmProjectInstructions();

    const baseTools = this.getTools();
    const tools = options?.tools ? { ...baseTools, ...options.tools } : baseTools;
    const model = this.getModel();
    const system = this.getSystemPrompt();
    const signal = options?.signal;
    const maxSteps = this.getMaxSteps();
    const sessionId = this.sessionId();

    // ─── Token budget thresholds ───
    const config = this.getConfig();
    const modelId = config?.model ?? this.env.DEFAULT_MODEL ?? "";
    const contextWindow = CONTEXT_WINDOW_TOKENS[modelId] ?? DEFAULT_CONTEXT_WINDOW;
    const tokenBudget = Math.floor(contextWindow * CONTEXT_BUDGET_FACTOR);

    // ─── Loop state ───
    const recentToolCalls: string[] = []; // "toolName:argsJSON" for doom-loop detection
    const recentTextPrefixes: string[] = []; // first ~80 chars of text per iteration for repetition detection
    let cumulativeInputTokens = 0;
    let cumulativeOutputTokens = 0;
    let step = 0;
    let warnInjected = false;
    let wrapUpInjected = false;
    let compactionTriggered = false;
    let consecutiveNoTextSteps = 0; // Track iterations where the model produces tool calls but no text
    let exitReason: "natural" | "step-limit" | "budget-limit" | "doom-loop" | "no-text-loop" | "text-loop" | "abort" = "natural";

    // ─── Budget thresholds (% of tokenBudget) ───
    const WARN_THRESHOLD = 0.70;
    const WRAP_UP_THRESHOLD = 0.85;
    const HARD_STOP_THRESHOLD = 0.95;

    // ─── Doom loop detection ───
    const DOOM_LOOP_THRESHOLD = 3;
    const NO_TEXT_LOOP_THRESHOLD = 15;
    const NO_TEXT_GRACE_STEPS = 10; // Skip no-text detection for the first N steps (exploration phase)
    // OpenAI/Google/DeepSeek models work silently (tool calls without text narration).
    // The no-text detector is only useful for Anthropic models where silence means stuck.
    const noTextDetectionEnabled = modelId.startsWith("anthropic/");

    // ─── Mid-loop compaction threshold ───
    const MID_LOOP_COMPACTION_THRESHOLD = 0.50; // Compact when >50% of budget used

    const self = this;

    // Return a custom StreamableResult. Think's chat() calls toUIMessageStream()
    // and iterates it, forwarding chunks via the StreamCallback.
    return {
      async *toUIMessageStream() {
        // ─── Assemble context once at the start ───
        // Think's chat() persists the assistant message only AFTER this entire
        // generator completes. So this.messages (and thus assembleContext()) is
        // stale during the loop — it only has messages up to the user message,
        // not any tool calls/results from previous iterations.
        //
        // We assemble once, then accumulate response messages (assistant + tool
        // results) from each streamText() call so the model sees its own
        // previous tool results on subsequent iterations.
        let messages = await self.assembleContext();

        // ─── Capture the original user prompt for phase-transition digests ───
        // The auto-continuation loop rebuilds `messages` on each phase with
        // `[firstMsg, summaryInjection, ...recentMsgs]`, where `firstMsg`
        // defaults to `messages[0]`. If the original user prompt is large
        // (dispatch prompts often are), preserving it in full on every phase
        // re-sends the whole prompt to the LLM each turn, inflating input
        // tokens on every phase transition — the prompt ends up counted N
        // times for N phases. See issue #34 comment about prompt duplication.
        //
        // We capture a short digest of the original prompt here so later
        // phases can substitute the digest for `firstMsg` instead of the full
        // prompt.
        const originalFirstMsg = messages[0];
        const originalPromptDigest = ((): string => {
          if (!originalFirstMsg) return "";
          const content = originalFirstMsg.content;
          const text = typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .map((part) => (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part ? String(part.text) : ""))
                  .filter(Boolean)
                  .join("\n")
              : "";
          // Keep the first ~500 chars — enough to carry the goal statement
          // without dragging the whole prompt forward.
          return text.length > 500 ? `${text.slice(0, 500)}…[truncated, see phase summary for progress]` : text;
        })();

        // ─── Loop-entry oversized-prompt guard (issue #34, bug 3) ───
        // When the user prompt itself is large (detailed dispatch prompts, long
        // pasted logs, etc.) the first streamText() call can exceed the budget
        // on step 0. The own-loop assumed prompts fit and relied on turn-over-
        // turn accumulation to trigger safeguards; that gave nothing to trip in
        // the failure mode the autocompaction feature is designed for.
        //
        // If we're already past the compaction threshold before step 0, force a
        // compaction pass, set compactionTriggered so the mid-loop check doesn't
        // fire again unnecessarily, and re-assemble.
        const entryInputTokens = estimateMessagesTokens(messages);
        const entryUsage = entryInputTokens / tokenBudget;
        if (entryUsage >= MID_LOOP_COMPACTION_THRESHOLD) {
          compactionTriggered = true;
          log("info", "own-loop: loop-entry compaction triggered", {
            sessionId,
            entryInputTokens,
            tokenBudget,
            entryUsage: `${Math.round(entryUsage * 100)}%`,
          });
          try {
            await self.maybeCompactContext({ force: true });
            const thinkSessionId = self.getCurrentSessionId();
            if (thinkSessionId) {
              self.messages = self.sessions.getHistory(thinkSessionId);
            }
            messages = await self.assembleContext();
          } catch (err) {
            log("warn", "own-loop: loop-entry compaction failed", {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        while (step < maxSteps) {
          if (signal?.aborted) { exitReason = "abort"; break; }

          // ─── Newline separator between iterations ───
          // After a tool call, the model starts a new text response. Without
          // a separator, the new text gets concatenated directly to the previous
          // text, creating an unreadable wall of text (e.g. "Let me explore...Let me explore...").
          // Yield a synthetic text-delta chunk so the separator flows through
          // Think's callback and gets appended to fullText and the SSE stream.
          if (step > 0) {
            yield { type: "text-delta", id: crypto.randomUUID(), delta: "\n\n" };
          }

          // ─── Between-step injections ───
          const injections: ModelMessage[] = [];

          // Doom loop detection: check if the last N tool calls are identical
          const DOOM_LOOP_HARD_BREAK = DOOM_LOOP_THRESHOLD + 2; // 5 identical calls → hard break
          if (recentToolCalls.length >= DOOM_LOOP_THRESHOLD) {
            const lastN = recentToolCalls.slice(-DOOM_LOOP_THRESHOLD);
            const allSame = lastN.every(c => c === lastN[0]);
            if (allSame) {
              const toolName = lastN[0].split(":")[0];

              // Hard break after DOOM_LOOP_HARD_BREAK identical calls
              if (recentToolCalls.length >= DOOM_LOOP_HARD_BREAK) {
                const hardN = recentToolCalls.slice(-DOOM_LOOP_HARD_BREAK);
                if (hardN.every(c => c === hardN[0])) {
                  log("warn", "doom loop hard break — identical tool calls", {
                    sessionId,
                    toolName,
                    step,
                    repeats: DOOM_LOOP_HARD_BREAK,
                  });
                  yield { type: "text-delta", id: crypto.randomUUID(), delta: `\n\n[Stopped: repeated ${toolName} calls detected]\n\n` };
                  exitReason = "doom-loop";
                  break;
                }
              }

              injections.push({
                role: "system" as const,
                content: `[WARNING: You have called ${toolName} with the same arguments ${DOOM_LOOP_THRESHOLD} times in a row. This is a loop. Try a different approach — use a different tool, different arguments, or explain what's blocking you.]`,
              });
              log("warn", "doom loop detected", {
                sessionId,
                toolName,
                step,
                repeats: DOOM_LOOP_THRESHOLD,
              });
            }
          }

          // Budget-aware injections
          const budgetUsage = cumulativeInputTokens / tokenBudget;

          if (budgetUsage >= HARD_STOP_THRESHOLD) {
            // Hard stop — yield a wrap-up message and break
            log("warn", "own-loop: hard stop — budget exhausted", {
              sessionId,
              step,
              cumulativeInputTokens,
              tokenBudget,
              usage: `${Math.round(budgetUsage * 100)}%`,
            });
            exitReason = "budget-limit";
            break;
          }

          if (budgetUsage >= WRAP_UP_THRESHOLD && !wrapUpInjected) {
            injections.push({
              role: "system" as const,
              content: "[CONTEXT BUDGET NEARLY EXHAUSTED] Summarize what you've done and what remains, then stop. Do not read new files or start new tasks. Complete your current thought and wrap up.",
            });
            wrapUpInjected = true;
            log("info", "own-loop: wrap-up injection", {
              sessionId,
              step,
              cumulativeInputTokens,
              tokenBudget,
              usage: `${Math.round(budgetUsage * 100)}%`,
            });
          } else if (budgetUsage >= WARN_THRESHOLD && !warnInjected) {
            injections.push({
              role: "system" as const,
              content: "[CONTEXT BUDGET WARNING] You are using most of your context budget. Focus on completing the current task. Avoid reading new files unless essential. Prefer targeted edits over full file reads.",
            });
            warnInjected = true;
            log("info", "own-loop: budget warning injection", {
              sessionId,
              step,
              cumulativeInputTokens,
              tokenBudget,
              usage: `${Math.round(budgetUsage * 100)}%`,
            });
          }

          // ─── Mid-loop compaction ───
          // If context usage is above threshold and we haven't compacted yet this turn,
          // trigger Think's compaction system to summarize older messages.
          // After compaction, re-assemble the local messages array so it
          // picks up the compacted history (with the summary injected).
          //
          // No `step >= N` guard: a large prompt + aggressive exploration can burn
          // through the budget in steps 0-2. The `!compactionTriggered` flag already
          // prevents compaction from firing more than once per turn, so gating on
          // step count only delays a necessary safety net. See issue #34.
          if (budgetUsage >= MID_LOOP_COMPACTION_THRESHOLD && !compactionTriggered) {
            compactionTriggered = true;
            try {
              await self.maybeCompactContext();
              // Refresh messages from storage and re-assemble with compaction summary.
              const thinkSessionId = self.getCurrentSessionId();
              if (thinkSessionId) {
                self.messages = self.sessions.getHistory(thinkSessionId);
              }
              messages = await self.assembleContext();
              log("info", "own-loop: mid-loop compaction triggered", {
                sessionId,
                step,
                cumulativeInputTokens,
                tokenBudget,
              });
            } catch (err) {
              log("warn", "own-loop: mid-loop compaction failed", {
                sessionId,
                step,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          // Build final messages with injections appended
          let finalMessages = injections.length > 0
            ? [...messages, ...injections]
            : messages;

          // ─── Pre-step budget check (issue #34, bug 2) ───
          // cumulativeInputTokens is only updated AFTER streamText() completes,
          // so the budget-aware injections above (warn / wrap-up / hard-stop) see
          // counters that trail the just-finished step. If a single step burns
          // through the budget, the next step's pre-call injection won't fire in
          // time. Estimate the input size directly from the outgoing messages and
          // force compaction before making the LLM call if we're already past the
          // compaction threshold.
          const projectedInputTokens = estimateMessagesTokens(finalMessages);
          const projectedUsage = projectedInputTokens / tokenBudget;

          if (projectedUsage >= MID_LOOP_COMPACTION_THRESHOLD && !compactionTriggered) {
            compactionTriggered = true;
            log("info", "own-loop: pre-step compaction triggered", {
              sessionId,
              step,
              projectedInputTokens,
              tokenBudget,
              projectedUsage: `${Math.round(projectedUsage * 100)}%`,
            });
            try {
              await self.maybeCompactContext({ force: true });
              const thinkSessionId = self.getCurrentSessionId();
              if (thinkSessionId) {
                self.messages = self.sessions.getHistory(thinkSessionId);
              }
              messages = await self.assembleContext();
              finalMessages = injections.length > 0
                ? [...messages, ...injections]
                : messages;
            } catch (err) {
              log("warn", "own-loop: pre-step compaction failed", {
                sessionId,
                step,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          // Hard stop if even after compaction we're projected above the budget.
          // Without this, streamText() is guaranteed to throw a context-overflow
          // error — better to exit cleanly with a wrap-up message.
          const projectedAfterCompactionTokens = estimateMessagesTokens(finalMessages);
          const projectedAfterUsage = projectedAfterCompactionTokens / tokenBudget;
          if (projectedAfterUsage >= HARD_STOP_THRESHOLD) {
            log("warn", "own-loop: pre-step hard stop — projected tokens exceed budget", {
              sessionId,
              step,
              projectedInputTokens: projectedAfterCompactionTokens,
              tokenBudget,
              projectedUsage: `${Math.round(projectedAfterUsage * 100)}%`,
            });
            yield { type: "text-delta", id: crypto.randomUUID(), delta: "\n\n[Stopped: context budget exhausted before next step]\n\n" };
            exitReason = "budget-limit";
            break;
          }

          // ─── Single-step LLM call with overflow recovery (Tactic 5) ───
          // Note: Prompt cache retention (Tactic 7) requires the native @ai-sdk/anthropic
          // provider. Dodo uses @ai-sdk/openai-compatible which doesn't support
          // Anthropic-specific providerOptions. Cache control will be enabled when/if
          // we switch to the native Anthropic provider.
          let result;
          // Declared outside try so post-step bookkeeping can access them
          let iterationText = "";
          let chunkCount = 0;
          let hasErrorChunk = false;
          let errorText = "";
          try {
            result = streamText({
              model,
              system,
              messages: finalMessages,
              tools,
              abortSignal: signal,
            });

            // Forward all chunks from this iteration to the caller.
            // Capture text emitted this iteration for repetition detection.
            for await (const chunk of result.toUIMessageStream()) {
              yield chunk;
              chunkCount++;
              const c = chunk as { type?: string; delta?: string; errorText?: string; error?: string };
              if (c.type === "text-delta" && c.delta) {
                iterationText += c.delta;
              } else if (c.type === "error") {
                hasErrorChunk = true;
                errorText = c.errorText ?? c.error ?? "unknown";
              }
            }

            // Log diagnostic info when the stream produced no content
            if (!iterationText && chunkCount === 0) {
              log("warn", "own-loop: LLM stream produced zero chunks", {
                sessionId,
                step,
                model: modelId,
              });
            } else if (hasErrorChunk) {
              log("warn", "own-loop: LLM stream contained error chunk", {
                sessionId,
                step,
                model: modelId,
                errorText: errorText.slice(0, 500),
                chunkCount,
              });
              if (!iterationText && errorText) {
                throw new Error(errorText);
              }
            }
          } catch (err) {
            // ─── Overflow recovery ───
            // Detect context overflow errors and trigger emergency compaction.
            // Only attempt once per onChatMessage() invocation to prevent infinite loops.
            const errMsg = err instanceof Error ? err.message : String(err);
            const isOverflow = /context.*(length|limit|overflow|window|too long|exceed)/i.test(errMsg)
              || /max.*token/i.test(errMsg)
              || /request too large/i.test(errMsg);

            if (isOverflow && !self._overflowRecoveryAttempted) {
              self._overflowRecoveryAttempted = true;
              log("warn", "own-loop: context overflow detected, attempting emergency compaction", {
                sessionId,
                step,
                error: errMsg.slice(0, 200),
              });

              try {
                await self.maybeCompactContext({ force: true });
                // Refresh messages from storage so we get the compaction summary.
                const thinkSid = self.getCurrentSessionId();
                if (thinkSid) {
                  self.messages = self.sessions.getHistory(thinkSid);
                }
                // Re-assemble context after compaction to pick up the summary.
                // This replaces the stale accumulated messages with freshly
                // compacted ones.
                messages = await self.assembleContext();
                step++;
                continue;
              } catch (compactionErr) {
                log("warn", "own-loop: emergency compaction failed, propagating original error", {
                  sessionId,
                  error: compactionErr instanceof Error ? compactionErr.message : String(compactionErr),
                });
              }
            }
            // Re-throw if not an overflow or recovery failed
            throw err;
          }

          // ─── Post-step bookkeeping ───
          // Reset overflow recovery flag on successful step
          self._overflowRecoveryAttempted = false;

          const usage = await (result as unknown as { totalUsage: PromiseLike<{ inputTokens?: number; outputTokens?: number }> }).totalUsage;
          cumulativeInputTokens += usage?.inputTokens ?? 0;
          cumulativeOutputTokens += usage?.outputTokens ?? 0;

          // ─── Accumulate response messages for the next iteration ───
          // streamText() returns response messages (assistant + tool results)
          // that must be appended to the messages array so the model sees its
          // own tool call results on subsequent iterations. Without this, each
          // iteration would only see the original user message (because
          // this.messages is not updated until Think's chat() finishes).
          const response = await (result as unknown as { response: PromiseLike<{ messages: ModelMessage[] }> }).response;
          if (response?.messages?.length) {
            messages = [...messages, ...response.messages];
          }

          // Track tool calls for doom loop detection
          const steps = await (result as unknown as { steps: PromiseLike<Array<{ toolCalls?: Array<{ toolName: string; input: unknown }> }>> }).steps;
          const lastStep = steps?.[steps.length - 1];
          if (lastStep?.toolCalls?.length) {
            for (const tc of lastStep.toolCalls) {
              recentToolCalls.push(`${tc.toolName}:${JSON.stringify(tc.input)}`);
            }
            // Keep only the last DOOM_LOOP_THRESHOLD * 2 entries to bound memory
            if (recentToolCalls.length > DOOM_LOOP_THRESHOLD * 2) {
              recentToolCalls.splice(0, recentToolCalls.length - DOOM_LOOP_THRESHOLD * 2);
            }
          }

          // ─── Text repetition detection ───
          // Catches loops where the model emits similar text each iteration
          // but varies tool arguments (evading the tool-call doom loop detector).
          // Compare the first ~80 chars of text from each iteration.
          const textPrefix = iterationText.trim().slice(0, 80);
          if (textPrefix.length > 10) {
            recentTextPrefixes.push(textPrefix);
            if (recentTextPrefixes.length > DOOM_LOOP_THRESHOLD * 2) {
              recentTextPrefixes.splice(0, recentTextPrefixes.length - DOOM_LOOP_THRESHOLD * 2);
            }
            if (recentTextPrefixes.length >= DOOM_LOOP_THRESHOLD) {
              const lastN = recentTextPrefixes.slice(-DOOM_LOOP_THRESHOLD);
              const allSame = lastN.every(t => t === lastN[0]);
              if (allSame) {
                log("warn", "text repetition loop detected — breaking", {
                  sessionId,
                  step,
                  repeatedText: textPrefix.slice(0, 60),
                  repeats: DOOM_LOOP_THRESHOLD,
                });
                exitReason = "text-loop";
                break;
              }
            }
          }

          // ─── No-text tool-call loop detection ───
          // Catches loops where the model makes diverse tool calls (evading the
          // identical-call detector) and produces no meaningful text (evading the
          // text-repetition detector). If the model makes tool calls without any
          // text for too many consecutive iterations, it's stuck exploring.
          if (noTextDetectionEnabled && textPrefix.length <= 10 && lastStep?.toolCalls?.length) {
            consecutiveNoTextSteps++;
            if (step >= NO_TEXT_GRACE_STEPS && consecutiveNoTextSteps >= NO_TEXT_LOOP_THRESHOLD) {
              log("warn", "no-text tool-call loop detected — breaking", {
                sessionId,
                step,
                consecutiveNoTextSteps,
                recentTools: recentToolCalls.slice(-NO_TEXT_LOOP_THRESHOLD),
              });
              // Inject a final message asking the model to summarize
              yield { type: "text-delta", id: crypto.randomUUID(), delta: "\n\n[Loop detected — summarizing progress so far]\n\n" };
              exitReason = "no-text-loop";
              break;
            }
          } else {
            consecutiveNoTextSteps = 0;
          }

          // Check finish reason — if the model didn't make a tool call, it's done
          const finishReason = await (result as unknown as { finishReason: PromiseLike<string> }).finishReason;

          log("info", "own-loop: step complete", {
            sessionId,
            step,
            finishReason,
            inputTokens: usage?.inputTokens ?? 0,
            cumulativeInputTokens,
            budgetUsage: `${Math.round((cumulativeInputTokens / tokenBudget) * 100)}%`,
            toolCalls: lastStep?.toolCalls?.map(tc => tc.toolName) ?? [],
            consecutiveNoTextSteps,
          });

          if (finishReason !== "tool-calls") break;

          step++;
        }

        // Tag step-limit exit (while condition failed)
        if (step >= maxSteps && exitReason === "natural") {
          exitReason = "step-limit";
        }

        // ─── Multi-phase auto-continuation ───
        // When the loop ends due to resource limits (step or budget), truncate
        // context in-memory and start a new phase. Repeats up to MAX_PHASES
        // times. Does NOT trigger on loop detection exits (doom loop, text
        // repetition, no-text loop) — those indicate the model is stuck.
        const MAX_CONTINUATION_PHASES = 5;
        let totalInputTokens = cumulativeInputTokens;
        let totalOutputTokens = cumulativeOutputTokens;

        for (let phase = 1; phase <= MAX_CONTINUATION_PHASES; phase++) {
          const shouldAutoContinue = (exitReason === "step-limit" || exitReason === "budget-limit");
          if (!shouldAutoContinue || signal?.aborted) break;

          const phaseNum = phase + 1; // phase 1 = original, phase 2+ = continuations
          log("info", `own-loop: auto-continuation phase ${phaseNum}`, {
            sessionId,
            step,
            exitReason,
            budgetUsage: `${Math.round((totalInputTokens / tokenBudget) * 100)}%`,
          });

          yield { type: "text-delta", id: crypto.randomUUID(), delta: `\n\n[Compacting context and continuing... (phase ${phaseNum})]\n\n` };

          try {
            // ─── In-memory context truncation ───
            // Keep more recent messages (12) so the model retains context
            // from the current phase. Also extract text output from dropped
            // messages to preserve the model's findings and plan.
            const keepRecent = 12;
            if (messages.length > keepRecent + 2) {
              // Replace the original (potentially huge) user prompt at index 0
              // with a compact synthetic system message that carries only the
              // goal digest. See issue #34 — re-sending the full prompt on
              // every phase duplicated input-token cost N times for N phases.
              const firstMsg: ModelMessage = originalPromptDigest
                ? {
                    role: "system" as const,
                    content: `[Original task]\n${originalPromptDigest}`,
                  }
                : messages[0];
              const recentMsgs = messages.slice(-keepRecent);
              const droppedMsgs = messages.slice(1, -keepRecent);

              const droppedCount = droppedMsgs.length;
              const droppedToolNames = new Set<string>();
              const discoveredFiles = new Set<string>();
              const assistantTexts: string[] = [];

              for (const msg of droppedMsgs) {
                if (typeof msg.content === "object" && Array.isArray(msg.content)) {
                  for (const part of msg.content) {
                    if (part && typeof part === "object" && "type" in part) {
                      if (part.type === "tool-call" && "toolName" in part) {
                        droppedToolNames.add(String(part.toolName));
                        // Extract file paths from tool-call arguments
                        if ("input" in part && part.input && typeof part.input === "object") {
                          const input = part.input as Record<string, unknown>;
                          if (typeof input.path === "string" && input.path.length > 1) {
                            discoveredFiles.add(input.path);
                          }
                        }
                      }
                      // Extract the model's text output (findings, plans, decisions)
                      if (part.type === "text" && "text" in part && typeof part.text === "string") {
                        const text = part.text.trim();
                        if (text.length > 20) assistantTexts.push(text);
                      }
                    }
                  }
                }
              }

              // Build a summary that preserves the model's key findings
              const toolsSummary = [...droppedToolNames].join(", ") || "none";
              const filesList = discoveredFiles.size > 0
                ? "\n\nFiles discovered in previous phases:\n" + [...discoveredFiles].join("\n")
                : "";
              const findingsDigest = assistantTexts.length > 0
                ? "\n\nKey findings from previous phases:\n" + assistantTexts.join("\n").slice(-1500)
                : "";

              const summaryInjection: ModelMessage = {
                role: "system" as const,
                content: `[Previous context truncated — ${droppedCount} messages dropped. Tools used: ${toolsSummary}. The task is not yet complete. Do NOT re-explore files you already found — use the file paths and findings below to continue making edits.${filesList}${findingsDigest}]`,
              };

              messages = [firstMsg, summaryInjection, ...recentMsgs];
              log("info", `own-loop: phase ${phaseNum} context truncation`, {
                sessionId,
                originalCount: messages.length + droppedCount,
                keptCount: messages.length,
                droppedTools: [...droppedToolNames],
                discoveredFiles: discoveredFiles.size,
                findingsLength: findingsDigest.length,
              });
            }

            // Reset budget tracking for the new phase
            cumulativeInputTokens = 0;
            cumulativeOutputTokens = 0;
            warnInjected = false;
            wrapUpInjected = false;
            compactionTriggered = false;
            consecutiveNoTextSteps = 0;
            recentToolCalls.length = 0;
            recentTextPrefixes.length = 0;
            exitReason = "natural";

            // Inject continuation prompt — directive to avoid re-exploration
            const continuationInjection: ModelMessage = {
              role: "user" as const,
              content: "[auto-continue] Your previous turn was cut short by context limits. The conversation has been compacted. Do NOT re-explore the codebase — your findings are preserved in the summary above. Start making edits immediately using the file paths and line numbers from the summary and recent context.",
            };
            messages = [...messages, continuationInjection];

            // Run the next phase
            step = 0;
            while (step < maxSteps) {
              if (signal?.aborted) { exitReason = "abort"; break; }

              if (step > 0) {
                yield { type: "text-delta", id: crypto.randomUUID(), delta: "\n\n" };
              }

              const phaseInjections: ModelMessage[] = [];
              const phaseBudgetUsage = cumulativeInputTokens / tokenBudget;

              if (phaseBudgetUsage >= HARD_STOP_THRESHOLD) {
                log("warn", `own-loop: phase ${phase + 1} hard stop`, { sessionId, step });
                exitReason = "budget-limit";
                break;
              }
              if (phaseBudgetUsage >= WRAP_UP_THRESHOLD && !wrapUpInjected) {
                phaseInjections.push({
                  role: "system" as const,
                  content: "[CONTEXT BUDGET NEARLY EXHAUSTED] Summarize what you've done and what remains, then stop. Do not read new files or start new tasks. Complete your current thought and wrap up.",
                });
                wrapUpInjected = true;
              } else if (phaseBudgetUsage >= WARN_THRESHOLD && !warnInjected) {
                phaseInjections.push({
                  role: "system" as const,
                  content: "[CONTEXT BUDGET WARNING] You are using most of your context budget. Focus on completing the current task. Avoid reading new files unless essential. Prefer targeted edits over full file reads.",
                });
                warnInjected = true;
              }

              // Doom loop detection (two-tier: soft warning then hard break)
              if (recentToolCalls.length >= DOOM_LOOP_THRESHOLD) {
                const lastN = recentToolCalls.slice(-DOOM_LOOP_THRESHOLD);
                if (lastN.every(c => c === lastN[0])) {
                  const toolName = lastN[0].split(":")[0];
                  const DOOM_LOOP_HARD_BREAK = DOOM_LOOP_THRESHOLD + 2;

                  if (recentToolCalls.length >= DOOM_LOOP_HARD_BREAK) {
                    const hardN = recentToolCalls.slice(-DOOM_LOOP_HARD_BREAK);
                    if (hardN.every(c => c === hardN[0])) {
                      log("warn", `own-loop: phase ${phase + 1} doom loop hard break`, { sessionId, step, toolName });
                      yield { type: "text-delta", id: crypto.randomUUID(), delta: `\n\n[Stopped: repeated ${toolName} calls detected]\n\n` };
                      exitReason = "doom-loop";
                      break;
                    }
                  }

                  phaseInjections.push({
                    role: "system" as const,
                    content: `[WARNING: You have called ${toolName} with the same arguments ${DOOM_LOOP_THRESHOLD} times in a row. This is a loop. Try a different approach.]`,
                  });
                }
              }

              const finalMessages = phaseInjections.length > 0
                ? [...messages, ...phaseInjections]
                : messages;

              let phResult;
              let phText = "";
              try {
                phResult = streamText({
                  model,
                  system,
                  messages: finalMessages,
                  tools,
                  abortSignal: signal,
                });

                for await (const chunk of phResult.toUIMessageStream()) {
                  yield chunk;
                  const c = chunk as { type?: string; delta?: string };
                  if (c.type === "text-delta" && c.delta) {
                    phText += c.delta;
                  }
                }
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                const isOverflow = /context.*(length|limit|overflow|window|too long|exceed)/i.test(errMsg)
                  || /max.*token/i.test(errMsg)
                  || /request too large/i.test(errMsg);
                if (isOverflow) {
                  log("warn", `own-loop: phase ${phase + 1} overflow — stopping`, { sessionId });
                  exitReason = "budget-limit";
                  break;
                }
                throw err;
              }

              const phUsage = await (phResult as unknown as { totalUsage: PromiseLike<{ inputTokens?: number; outputTokens?: number }> }).totalUsage;
              cumulativeInputTokens += phUsage?.inputTokens ?? 0;
              cumulativeOutputTokens += phUsage?.outputTokens ?? 0;

              const phResponse = await (phResult as unknown as { response: PromiseLike<{ messages: ModelMessage[] }> }).response;
              if (phResponse?.messages?.length) {
                messages = [...messages, ...phResponse.messages];
              }

              // Track tool calls for loop detection
              const phSteps = await (phResult as unknown as { steps: PromiseLike<Array<{ toolCalls?: Array<{ toolName: string; input: unknown }> }>> }).steps;
              const phLastStep = phSteps?.[phSteps.length - 1];
              if (phLastStep?.toolCalls?.length) {
                for (const tc of phLastStep.toolCalls) {
                  recentToolCalls.push(`${tc.toolName}:${JSON.stringify(tc.input)}`);
                }
                if (recentToolCalls.length > DOOM_LOOP_THRESHOLD * 2) {
                  recentToolCalls.splice(0, recentToolCalls.length - DOOM_LOOP_THRESHOLD * 2);
                }
              }

              // Text repetition detection
              const phTextPrefix = phText.trim().slice(0, 80);
              if (phTextPrefix.length > 10) {
                recentTextPrefixes.push(phTextPrefix);
                if (recentTextPrefixes.length > DOOM_LOOP_THRESHOLD * 2) {
                  recentTextPrefixes.splice(0, recentTextPrefixes.length - DOOM_LOOP_THRESHOLD * 2);
                }
                if (recentTextPrefixes.length >= DOOM_LOOP_THRESHOLD) {
                  const lastN = recentTextPrefixes.slice(-DOOM_LOOP_THRESHOLD);
                  if (lastN.every(t => t === lastN[0])) {
                    log("warn", `own-loop: phase ${phase + 1} text repetition loop`, { sessionId, step });
                    exitReason = "text-loop";
                    break;
                  }
                }
              }

              // No-text loop detection (only for Anthropic; OpenAI/Google work silently)
              if (noTextDetectionEnabled && phTextPrefix.length <= 10 && phLastStep?.toolCalls?.length) {
                consecutiveNoTextSteps++;
                if (step >= NO_TEXT_GRACE_STEPS && consecutiveNoTextSteps >= NO_TEXT_LOOP_THRESHOLD) {
                  log("warn", `own-loop: phase ${phaseNum} no-text loop`, { sessionId, step });
                  yield { type: "text-delta", id: crypto.randomUUID(), delta: "\n\n[Loop detected — summarizing progress so far]\n\n" };
                  exitReason = "no-text-loop";
                  break;
                }
              } else {
                consecutiveNoTextSteps = 0;
              }

              const phFinishReason = await (phResult as unknown as { finishReason: PromiseLike<string> }).finishReason;

              log("info", `own-loop: phase ${phase + 1} step complete`, {
                sessionId,
                step,
                finishReason: phFinishReason,
                budgetUsage: `${Math.round((cumulativeInputTokens / tokenBudget) * 100)}%`,
                toolCalls: phLastStep?.toolCalls?.map(tc => tc.toolName) ?? [],
              });

              if (phFinishReason !== "tool-calls") break;
              step++;
            }

            // Tag step-limit exit
            if (step >= maxSteps && exitReason === "natural") {
              exitReason = "step-limit";
            }

            // Accumulate phase tokens into total
            totalInputTokens += cumulativeInputTokens;
            totalOutputTokens += cumulativeOutputTokens;
          } catch (err) {
            totalInputTokens += cumulativeInputTokens;
            totalOutputTokens += cumulativeOutputTokens;
            log("warn", `own-loop: auto-continuation phase ${phase} failed`, {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
            yield { type: "text-delta", id: crypto.randomUUID(), delta: "\n\n[Auto-continuation failed — send 'continue' to resume manually]\n\n" };
            break;
          }
        }

        // Use totals across all phases for _lastUsage
        cumulativeInputTokens = totalInputTokens;
        cumulativeOutputTokens = totalOutputTokens;

        // ─── Store cumulative usage for runThinkChat to read ───
        self._lastUsage = {
          inputTokens: cumulativeInputTokens,
          outputTokens: cumulativeOutputTokens,
        };
      },
    };
  }

  /** Build an AppConfig from Think's per-session config, falling back to env defaults. */
  private getAppConfigFromThink(): AppConfig {
    const config = this.getConfig();
    if (config) {
      return {
        activeGateway: config.activeGateway,
        aiGatewayBaseURL: config.aiGatewayBaseURL,
        gitAuthorEmail: config.gitAuthorEmail,
        gitAuthorName: config.gitAuthorName,
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
    // High safety net — the token budget thresholds (warn at 70%,
    // wrap-up at 85%, hard stop at 95%) are the real limiting factor.
    // This just prevents truly runaway loops if budget tracking fails.
    return 200;
  }

  /**
   * Override assembleContext to apply compaction guardrails:
   * 1. Per-tool output shaping: apply tool-aware truncation rules to prevent
   *    context window bloat. Different tools get different response contracts.
   * 2. Older tool results get aggressively truncated to free budget.
   * 3. Enforce total token budget — drop oldest messages when the estimated
   *    token count exceeds 80% of the model's context window.
   *
   * Instrumentation: logs per-turn stats (tool count, output bytes before/after,
   * estimated tokens) for debugging token waste.
   */
  override async assembleContext(): Promise<ModelMessage[]> {
    let messages = await super.assembleContext();

    // ─── Inject compaction summary if missing ───
    // Think's getHistory() is supposed to inject the compaction summary as a
    // system UIMessage, but due to timing issues (stale this.messages, race
    // conditions) it may not appear in the ModelMessage array after conversion.
    // As a safety net, read the latest compaction directly from the DB and
    // inject it if no system message with the summary marker exists.
    const COMPACTION_MARKER = "[Previous conversation summary]";
    const hasCompactionSummary = messages.some((msg) => {
      if (msg.role !== "system") return false;
      const text = typeof msg.content === "string" ? msg.content : "";
      return text.startsWith(COMPACTION_MARKER);
    });

    if (!hasCompactionSummary) {
      const thinkSessionId = this.getCurrentSessionId();
      if (thinkSessionId) {
        const compactions = this.sessions.getCompactions(thinkSessionId);
        if (compactions.length > 0) {
          const latest = compactions[compactions.length - 1];
          const summaryContent = `${COMPACTION_MARKER}\n${latest.summary}`;
          messages = [
            { role: "system" as const, content: summaryContent },
            ...messages,
          ];
          log("info", "assembleContext: injected compaction summary (safety net)", {
            sessionId: this.sessionId(),
            summaryChars: latest.summary.length,
            compactionCount: compactions.length,
          });
        }
      }
    }

    // ─── Selective message exclusion (Tactic 8) ───
    // Messages prefixed with "!!" are visible in the UI but excluded from
    // LLM context. Replace content with a minimal placeholder rather than
    // filtering entirely — this avoids orphaned assistant responses that
    // reference a message the model can't see on the current turn.
    messages = messages.map((msg) => {
      if (msg.role !== "user") return msg;
      const content = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter((p): p is { type: "text"; text: string } => p.type === "text").map(p => p.text).join("")
          : "";
      if (!content.startsWith("!!")) return msg;
      return { ...msg, content: "[message excluded by user]" };
    });

    // ─── Per-tool output shaping ───
    const useShaping = true; // Per-tool output shaping always enabled

    // Max chars per tool result — ~8k chars ≈ ~2k tokens. Enough for most
    // source files, tight enough to prevent context blowout from large reads.
    const MAX_TOOL_OUTPUT_CHARS = 8_000;
    // Older tool results (beyond this message index from the end) get aggressively truncated
    const RECENT_MESSAGE_WINDOW = 4;
    // Known large/low-value file patterns get extra-aggressive truncation
    const LOW_VALUE_PATTERNS = [
      /package-lock\.json/i,
      /yarn\.lock/i,
      /pnpm-lock\.yaml/i,
      /\.min\.(js|css)$/i,
      /\.map$/i,
      /\.git\//,
    ];
    const LOW_VALUE_MAX_CHARS = 2_000;

    const totalMessages = messages.length;
    let toolCallCount = 0;
    let totalOutputBytesBefore = 0;
    let totalOutputBytesAfter = 0;
    let truncatedCount = 0;

    for (let i = 0; i < totalMessages; i++) {
      const msg = messages[i];
      if (msg.role !== "tool") continue;

      const isRecent = i >= totalMessages - RECENT_MESSAGE_WINDOW;

      for (const part of msg.content) {
        if (part.type !== "tool-result" || part.output === undefined) continue;
        toolCallCount++;
        const output = part.output as { type?: string; value?: unknown };
        if (!output || typeof output !== "object") continue;

        const toolResult = part as { toolName?: string; input?: unknown };
        const toolName = toolResult.toolName ?? "unknown";

        // Serialize the value to measure size
        const value = output.value;
        const serialized = typeof value === "string" ? value : JSON.stringify(value);
        const originalBytes = serialized.length;
        totalOutputBytesBefore += originalBytes;

        // ─── Per-tool output shaping (Phase 1.2) ───
        if (useShaping) {
          // Compact response tools: write, edit, delete, git_add, git_commit
          // These should return a small status, not file contents.
          const compactTools = new Set([
            "write", "edit", "delete",
            "git_add", "git_commit", "git_init",
            "git_branch", "git_checkout",
          ]);
          if (compactTools.has(toolName) && originalBytes > 1_000) {
            // These tools shouldn't produce large output — cap at 1KB
            const capped = truncateToolOutput(serialized, {
              maxChars: 1_000,
              strategy: "middle",
            });
            if (output.type === "text") {
              (output as { value: string }).value = capped;
            } else {
              (part as { output: unknown }).output = { type: "text", value: capped };
            }
            totalOutputBytesAfter += capped.length;
            if (capped.length < originalBytes) truncatedCount++;
            continue;
          }
          // Per-tool shaping for read/list/grep/find is handled at the tool
          // level in agentic.ts:capToolOutputs, not here.
        }

        // ─── General truncation (existing + improved) ───
        const argsStr = toolResult.input ? JSON.stringify(toolResult.input) : "";
        const isLowValue = LOW_VALUE_PATTERNS.some((p) =>
          p.test(argsStr) || p.test(serialized.slice(0, 500)),
        );
        // Non-recent tool results: clear entirely with marker (Pattern #3)
        // Recent results: truncate to cap if oversized
        if (!isRecent && serialized.length > 200) {
          // Old results → zero-cost marker (~8 tokens vs ~500-2000 tokens)
          if (output.type === "text") {
            (output as { value: string }).value = CLEARED_MARKER;
          } else {
            (part as { output: unknown }).output = { type: "text", value: CLEARED_MARKER };
          }
          totalOutputBytesAfter += CLEARED_MARKER.length;
          truncatedCount++;
          continue;
        }

        let maxChars: number;
        if (isLowValue) {
          maxChars = LOW_VALUE_MAX_CHARS;
        } else {
          maxChars = MAX_TOOL_OUTPUT_CHARS;
        }

        if (serialized.length <= maxChars) {
          totalOutputBytesAfter += serialized.length;
          continue;
        }

        const truncated = truncateToolOutput(serialized, {
          maxChars,
          strategy: "middle",
        });
        truncatedCount++;

        // Preserve the output shape but replace the value with truncated text
        if (output.type === "text") {
          (output as { value: string }).value = truncated;
        } else {
          (part as { output: unknown }).output = { type: "text", value: truncated };
        }
        totalOutputBytesAfter += truncated.length;
      }
    }

    // ─── Token-budget enforcement (hybrid tracking) ───
    // Anchor on provider-reported cumulative input tokens from the agentic loop,
    // then only estimate the trailing delta (messages added since last LLM call).
    // This bounds estimation error to 1-3 messages instead of the full history.
    const config = this.getConfig();
    const modelId = config?.model ?? this.env.DEFAULT_MODEL ?? "";
    const contextWindow = CONTEXT_WINDOW_TOKENS[modelId] ?? DEFAULT_CONTEXT_WINDOW;
    const tokenBudget = Math.floor(contextWindow * CONTEXT_BUDGET_FACTOR);

    // Use the top-of-file estimateMessageTokens which is content-aware
    // (separate chars-per-token ratios for prose / code / JSON / default).
    // Prior versions had a shadow `estimateTokens` here using a flat 3.5
    // ratio — that under-counted code/JSON by 15-25% and let oversized
    // messages slip past the cutoff walk below.
    const estimateTokens = estimateMessageTokens;

    // ─── Protect compaction summaries from being dropped ───
    // The compaction summary (injected above or by Think's getHistory) MUST survive
    // token-budget enforcement — it's the compressed representation of older messages.
    const minProtectedIndex = messages.findIndex((msg) => {
      if (msg.role !== "system") return false;
      const text = typeof msg.content === "string" ? msg.content : "";
      return text.startsWith(COMPACTION_MARKER);
    });
    // If a compaction summary exists, the cutoff must not go before it.
    // Set the floor to the index AFTER the compaction summary so it's always included.
    const cutoffFloor = minProtectedIndex >= 0 ? minProtectedIndex : 0;

    // Log compaction detection for debugging
    if (messages.some(m => m.role === "system")) {
      log("info", "assembleContext: system messages found", {
        sessionId: this.sessionId(),
        totalMessages: messages.length,
        systemCount: messages.filter(m => m.role === "system").length,
        minProtectedIndex,
        systemPreviews: messages
          .map((m, i) => m.role === "system" ? { i, preview: (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 80) } : null)
          .filter(Boolean),
      });
    }



    // Hybrid approach: use provider-reported tokens as anchor if available.
    // _lastUsage.inputTokens is the cumulative input tokens from the current
    // onChatMessage() run. If available, it's a near-exact count for everything
    // except the trailing messages added after the last LLM call.
    const anchorTokens = this._lastUsage?.inputTokens ?? 0;
    let totalTokens = 0;
    let cutoffIndex = 0;

    if (anchorTokens > 0 && messages.length > 0) {
      // Find the last assistant message (the anchor point)
      let anchorIndex = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") { anchorIndex = i; break; }
      }
      if (anchorIndex >= 0) {
        // Estimate only trailing messages after the anchor
        let trailingTokens = 0;
        for (let i = anchorIndex + 1; i < messages.length; i++) {
          trailingTokens += estimateTokens(messages[i]);
        }
        totalTokens = anchorTokens + trailingTokens;
        // Walk backwards from the anchor to find cutoff if budget exceeded
        if (totalTokens > tokenBudget) {
          let budget = tokenBudget - trailingTokens;
          for (let i = anchorIndex; i >= 0; i--) {
            const msgTokens = estimateTokens(messages[i]);
            if (budget - msgTokens < 0) {
              cutoffIndex = Math.max(i + 1, cutoffFloor);
              break;
            }
            budget -= msgTokens;
          }
        }
      } else {
        // No assistant message yet — fall back to pure estimation
        for (let i = messages.length - 1; i >= 0; i--) {
          const msgTokens = estimateTokens(messages[i]);
          if (totalTokens + msgTokens > tokenBudget) {
            cutoffIndex = Math.max(i + 1, cutoffFloor);
            break;
          }
          totalTokens += msgTokens;
        }
      }
    } else {
      // No provider-reported usage yet — pure estimation (first turn)
      for (let i = messages.length - 1; i >= 0; i--) {
        const msgTokens = estimateTokens(messages[i]);
        if (totalTokens + msgTokens > tokenBudget) {
          cutoffIndex = Math.max(i + 1, cutoffFloor);
          break;
        }
        totalTokens += msgTokens;
      }
    }

    // ─── Current-turn overshoot check (Phase 1.4) ───
    // Even after truncation, check if the most recent messages alone exceed budget.
    // This catches the case where many tool calls in a single turn accumulate.
    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      const lastMsgTokens = estimateTokens(lastMsg);
      if (lastMsgTokens > tokenBudget * 0.5) {
        log("warn", "assembleContext: single message uses >50% of token budget", {
          sessionId: this.sessionId(),
          role: lastMsg.role,
          estimatedTokens: lastMsgTokens,
          tokenBudget,
          model: modelId,
        });
      }
    }

    // ─── Instrumentation (Phase 0.1) ───
    log("info", "assembleContext", {
      sessionId: this.sessionId(),
      model: modelId,
      messageCount: totalMessages,
      toolCallCount,
      outputBytesBefore: totalOutputBytesBefore,
      outputBytesAfter: totalOutputBytesAfter,
      truncatedToolResults: truncatedCount,
      estimatedTokens: totalTokens,
      tokenBudget,
      contextWindow,
      dropped: cutoffIndex > 0 ? cutoffIndex : 0,
    });

    if (cutoffIndex > 0 && cutoffIndex < messages.length) {
      this._contextTruncated = true;
      const droppedCount = cutoffIndex;
      const hasCompactionSummary = minProtectedIndex >= 0 && minProtectedIndex < cutoffIndex;
      log("warn", "assembleContext: dropping oldest messages", {
        sessionId: this.sessionId(),
        droppedCount,
        compactionSummaryProtected: minProtectedIndex >= 0,
        model: modelId,
        tokenBudget,
      });

      // If a compaction summary exists within the dropped range, preserve it
      // at the front of the returned messages. The summary is the compressed
      // representation of even older messages — losing it means total amnesia.
      const preserved: ModelMessage[] = [];
      if (hasCompactionSummary) {
        preserved.push(messages[minProtectedIndex]);
      }

      const truncationNote: ModelMessage = {
        role: "system" as const,
        content: `[Earlier messages truncated — context window limit reached. ${droppedCount} message(s) dropped to stay within the ${contextWindow}-token context window.]`,
      };

      return [...preserved, truncationNote, ...messages.slice(cutoffIndex)];
    }

    return messages;
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

    // Reconcile orphaned prompt queue — if no prompt is active but the queue
    // has items, the DO likely evicted between finishPrompt() clearing
    // active_prompt_id and dequeueAndRunNext() reading the queue.
    if (!this.readMetadata("active_prompt_id")) {
      this.dequeueAndRunNext();
    }
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

      // Debug endpoint: run compaction diagnostics without side effects
      if (request.method === "GET" && url.pathname === "/debug/compaction") {
        const thinkSid = this.getCurrentSessionId();
        if (!thinkSid) return Response.json({ error: "no session" });

        const cfg = this.getConfig();
        const mid = cfg?.model ?? this.env.DEFAULT_MODEL ?? "";
        const cw = CONTEXT_WINDOW_TOKENS[mid] ?? DEFAULT_CONTEXT_WINDOW;
        const cb = Math.floor(cw * CONTEXT_BUDGET_FACTOR);

        const latestAssistant = this.db.one(
          "SELECT token_input FROM message_metadata WHERE model IS NOT NULL ORDER BY created_at DESC LIMIT 1",
        );
        const lastInputTokens = Number(latestAssistant?.token_input ?? 0);
        const usagePct = cb > 0 ? Math.round((lastInputTokens / cb) * 100) : 0;

        const history = this.sessions.getHistory(thinkSid);
        const realMessages = history.filter((m) => !m.id.startsWith("compaction_"));
        const compactions = this.sessions.getCompactions(thinkSid);

        const targetCompactCount = Math.max(2, Math.floor(realMessages.length * COMPACTION_MESSAGE_FRACTION));
        const fromId = realMessages.length > 0 ? realMessages[0].id : null;
        const toId = realMessages.length >= targetCompactCount ? realMessages[targetCompactCount - 1].id : null;

        const alreadyCompacted = fromId && toId ? compactions.some(
          (c) => c.from_message_id === fromId || c.to_message_id === toId,
        ) : false;

        // Check serialization: would we get any content?
        let serializedCount = 0;
        for (const msg of realMessages.slice(0, targetCompactCount)) {
          const textContent = msg.parts
            ?.filter((p: { type: string }) => p.type === "text")
            .map((p: { type: string; text?: string }) => (p as { text: string }).text)
            .join("") ?? "";
          if (textContent) serializedCount++;
        }

        return Response.json({
          thinkSessionId: thinkSid,
          model: mid,
          contextWindow: cw,
          contextBudget: cb,
          lastInputTokens,
          usagePercent: usagePct,
          triggerThreshold: COMPACTION_TRIGGER_PERCENT,
          wouldTrigger: usagePct >= COMPACTION_TRIGGER_PERCENT,
          historyLength: history.length,
          realMessageCount: realMessages.length,
          compactionCount: compactions.length,
          targetCompactCount,
          fromId,
          toId,
          alreadyCompacted,
          serializedCount,
          historyRoles: history.map(m => `${m.role}:${m.id.slice(0, 8)}`),
        });
      }

      if (request.method === "GET" && url.pathname === "/messages") {
        return Response.json({ messages: this.listMessages() });
      }

      if (request.method === "GET" && url.pathname === "/prompts") {
        return Response.json({ prompts: this.listPrompts() });
      }

      if (request.method === "GET" && url.pathname === "/prompt-queue") {
        return Response.json(this.readQueueState());
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/prompt-queue/")) {
        const queueId = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        this.db.exec("DELETE FROM prompt_queue WHERE id = ?", queueId);
        this.emitEvent({ data: this.readQueueState(), type: "queue_update" });
        return Response.json({ deleted: true, id: queueId });
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

      if (request.method === "POST" && url.pathname === "/git/push-checked") {
        return await this.handleGitPushChecked(request);
      }

      if (request.method === "POST" && url.pathname === "/git/verify-branch") {
        return await this.handleGitVerifyBranch(request);
      }

      if (request.method === "POST" && url.pathname === "/git/remote") {
        return await this.handleGitRemote(request);
      }

      if (request.method === "POST" && url.pathname === "/message") {
        return await this.handleMessage(request);
      }

      if (request.method === "POST" && url.pathname === "/prompt") {
        return await this.handlePrompt(request);
      }

      if (request.method === "POST" && url.pathname === "/generate") {
        return await this.handleGenerate(request);
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
    const writeActions = new Set(["prompt", "message", "abort", "cron-create", "cron-delete"]);
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
        this.broadcastTyping();
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
          // Queue the prompt instead of rejecting — WS prompts are async (fire-and-forget)
          const queueResponse = this.enqueuePrompt(content, entry?.email);
          const queueBody = await queueResponse.json() as { promptId?: string; position?: number };
          connection.send(JSON.stringify({ type: "prompt_queued", promptId: queueBody.promptId, position: queueBody.position, queued: true }));
          return;
        }

        await this.readAppConfig(); // Ensure Think config is populated
        const existingTitle = this.readMetadata("title");
        const title = existingTitle || (content.length > 50 ? content.slice(0, 50) + "..." : content);

        if (!existingTitle) this.writeMetadata("title", title);
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
        // Signal the AbortController to interrupt the running LLM call immediately
        if (this._fiberAbortController) {
          this._fiberAbortController.abort();
          this._fiberAbortController = null;
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

  /** Broadcast current typing users to all WebSocket clients. */
  private broadcastTyping(): void {
    const payload = JSON.stringify({
      type: "typing",
      users: this.presence.getAll().filter((u) => u.isTyping),
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

    // Attachment refs (screenshots, generated images, user uploads) tied to
    // a specific message. Stored here instead of inside the Think UIMessage
    // parts because:
    //   1. Think's enforceRowSizeLimit replaces tool outputs > 1KB with a
    //      placeholder during persistence — base64 screenshots would vanish.
    //   2. Tool-result events fire with the tool_call_id before the assistant
    //      message the tool ran under has an id. Persisting refs here (keyed
    //      by message_id — initially the tool_call bucket, later rebound to
    //      the assistant message id once known) lets history restore surface
    //      screenshots for the right message on reload.
    //
    // R2 lifecycle (30 days) is the canonical retention; this table is just
    // a pointer index. If a pointer outlives its R2 object the client gets
    // a 404 on load — acceptable degradation for long-gone history.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        tool_call_id TEXT,
        media_type TEXT NOT NULL,
        url TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_message_attachments_msg ON message_attachments(message_id)",
    );

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
      CREATE TABLE IF NOT EXISTS prompt_queue (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        author_email TEXT,
        created_at INTEGER NOT NULL,
        position INTEGER NOT NULL
      )
    `);

    // Per-session todo list — backs the `todo_*` tools. Scoped to the
    // session so no cross-session leakage. Persisted through compaction
    // (which summarizes messages, not this table) so the model always
    // has a stable checklist to refer to after context summaries.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','in_progress','completed','cancelled')),
        priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_prompts_created ON prompts(created_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_prompt_queue_position ON prompt_queue(position ASC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_session_todos_status ON session_todos(status)");
  }

  /**
   * Expose a stable read/write surface to the `todo_*` tools in agentic.ts
   * without coupling them to the DO internals. Each method is a small,
   * synchronous SQL operation — no async bookkeeping needed.
   */
  private todoStore(): TodoStore {
    return {
      list: () => {
        const rows = this.db.all(
          "SELECT id, content, status, priority, created_at, updated_at FROM session_todos ORDER BY id ASC",
        );
        return rows.map((r) => ({
          id: Number(r.id),
          content: String(r.content),
          status: r.status as TodoStatus,
          priority: r.priority as TodoPriority,
        }));
      },
      add: (content, priority) => {
        const now = nowEpoch();
        this.db.exec(
          "INSERT INTO session_todos (content, status, priority, created_at, updated_at) VALUES (?, 'pending', ?, ?, ?)",
          content,
          priority ?? "medium",
          now,
          now,
        );
      },
      update: (id, patch) => {
        const now = nowEpoch();
        const existing = this.db.one("SELECT id FROM session_todos WHERE id = ?", id);
        if (!existing) return false;
        if (patch.status) {
          this.db.exec(
            "UPDATE session_todos SET status = ?, updated_at = ? WHERE id = ?",
            patch.status,
            now,
            id,
          );
        }
        if (patch.content) {
          this.db.exec(
            "UPDATE session_todos SET content = ?, updated_at = ? WHERE id = ?",
            patch.content,
            now,
            id,
          );
        }
        if (patch.priority) {
          this.db.exec(
            "UPDATE session_todos SET priority = ?, updated_at = ? WHERE id = ?",
            patch.priority,
            now,
            id,
          );
        }
        return true;
      },
      clear: () => {
        this.db.exec("DELETE FROM session_todos");
      },
    };
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
    const ownerEmail = request.headers.get("x-owner-email") ?? this.readMetadata("owner_email") ?? undefined;
    this.ensureMetadata(this.requireSessionId(request), ownerEmail);

    const execution = await runSandboxedCode({
      code: body.code,
      env: this.env,
      workspace: this.workspace,
      ownerId: this.resolveOwnerId(ownerEmail),
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
      const dir = body.dir ? normalizePath(body.dir) : undefined;
      const statusEntries = await git.status({ dir });
      if (!Array.isArray(statusEntries) || statusEntries.length === 0) {
        return Response.json({ error: "Nothing to commit. Make sure you edited files and staged them before committing." }, { status: 400 });
      }
      const config = await this.readAppConfig();
      const result = await git.commit({ author: defaultAuthor(config), dir, message: body.message });
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
    const body = z.object({ dir: z.string().optional(), force: z.boolean().optional(), ref: z.string().optional(), remote: z.string().optional(), baseRef: z.string().optional(), expectedFiles: z.array(z.string()).optional() }).strict().parse(await request.json());
    const git = createWorkspaceGit(this.workspace);
    const dir = body.dir ? normalizePath(body.dir) : undefined;
    const ownerEmail = request.headers.get("x-owner-email") ?? this.readMetadata("owner_email") ?? undefined;
    try {
      const token = await resolveRemoteToken({ dir, env: this.env, git, remote: body.remote, ownerEmail });
      const result = await git.push({ dir, force: body.force, ref: body.ref, remote: body.remote, token });
      if (!result.ok) {
        const refErrors = Object.entries(result.refs ?? {})
          .filter(([, v]) => !v.ok)
          .map(([k, v]) => `${k}: ${v.error}`)
          .join("; ");
        return Response.json({ error: `Push failed: ${refErrors || "remote rejected the push"}`, refs: result.refs }, { status: 422 });
      }
      // Detect no-op pushes: ok=true but no refs changed
      const refs = result.refs ?? {};
      if (Object.keys(refs).length === 0) {
        return Response.json({ error: "Push was a no-op — no refs were pushed. Verify you are on the correct branch and have committed changes.", refs }, { status: 422 });
      }
      if (body.ref) {
        const verification = await verifyRemoteBranch({
          baseRef: body.baseRef,
          dir,
          env: this.env,
          expectedFiles: body.expectedFiles,
          git,
          ownerEmail,
          ref: body.ref,
          remote: body.remote,
        });
        if (!verification.ok) {
          return Response.json({ error: verification.error ?? `Branch '${body.ref}' failed verification after push`, refs, verification }, { status: 422 });
        }
        return Response.json({ ...result, verification });
      }
      return Response.json(result);
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

  private async handleGitPushChecked(request: Request): Promise<Response> {
    const body = z.object({ dir: z.string().optional(), force: z.boolean().optional(), ref: z.string().min(1), remote: z.string().optional(), baseRef: z.string().optional(), expectedFiles: z.array(z.string()).optional() }).strict().parse(await request.json());
    return this.handleGitPush(new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(body),
    }));
  }

  private async handleGitVerifyBranch(request: Request): Promise<Response> {
    const body = z.object({ dir: z.string().optional(), ref: z.string().min(1), remote: z.string().optional(), baseRef: z.string().optional(), expectedFiles: z.array(z.string()).optional() }).strict().parse(await request.json());
    const git = createWorkspaceGit(this.workspace);
    const dir = body.dir ? normalizePath(body.dir) : undefined;
    const ownerEmail = request.headers.get("x-owner-email") ?? this.readMetadata("owner_email") ?? undefined;
    const verification = await verifyRemoteBranch({
      baseRef: body.baseRef,
      dir,
      env: this.env,
      expectedFiles: body.expectedFiles,
      git,
      ownerEmail,
      ref: body.ref,
      remote: body.remote,
    });
    if (!verification.ok) {
      return Response.json(verification, { status: 422 });
    }
    return Response.json(verification);
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
    const files: Array<{ content: string; path: string; encoding?: "base64" }> = [];

    for (const path of paths) {
      const stat = await this.workspace.stat(path);
      if (!stat || stat.type !== "file") {
        continue;
      }
      // Binary files (git internals) must be base64-encoded to survive JSON round-trip
      const isBinary = path.startsWith("/.git/") || path.includes("/.git/");
      if (isBinary) {
        const bytes = await this.workspace.readFileBytes(path);
        if (bytes !== null) {
          // Convert Uint8Array to base64
          const binary = String.fromCharCode(...bytes);
          const base64 = btoa(binary);
          files.push({ content: base64, path, encoding: "base64" });
        }
      } else {
        const content = await this.workspace.readFile(path);
        if (content !== null) {
          files.push({ content, path });
        }
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
        const normalized = normalizePath(file.path);
        if ((file as { encoding?: string }).encoding === "base64") {
          // Decode base64 back to binary
          const binary = atob(file.content);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          await this.workspace.writeFileBytes(normalized, bytes);
        } else {
          await this.workspace.writeFile(normalized, file.content);
        }
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
      const normalized = normalizePath(file.path);
      if ((file as { encoding?: string }).encoding === "base64") {
        const binary = atob(file.content);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        await this.workspace.writeFileBytes(normalized, bytes);
      } else {
        await this.workspace.writeFile(normalized, file.content);
      }
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
    this.mcpDepth = parseInt(request.headers.get("x-dodo-mcp-depth") ?? "0", 10) || 0;
    this.ensureMetadata(sessionId, ownerEmail);

    // Server-side slash command routing so /generate works from every entry
    // point (browser UI, MCP tools, webhooks) — not just the client JS. We do
    // this before the active-prompt check because `runImageGeneration` has its
    // own 409 handling for that case.
    const imagePrompt = extractGeneratePrompt(input.content);
    if (imagePrompt) {
      this.ensureThinkConfig(request);
      return this.runImageGeneration({
        prompt: imagePrompt,
        sessionId,
        authorEmail,
        ownerEmail,
      });
    }

    // handleMessage is synchronous — callers (MCP, external integrations) expect the
    // assistant response in the HTTP reply. Queuing would lose the response. Keep 409.
    if (this.readMetadata("active_prompt_id")) {
      return Response.json({ error: "A prompt is already running" }, { status: 409 });
    }

    const title = this.readMetadata("title") ?? (input.content.length > 72 ? input.content.slice(0, 72) + "…" : input.content);
    this.writeMetadata("title", title);
    this.writeMetadata("status", "running");
    await this.syncSessionIndex({ status: "running", title });

    this.ensureThinkConfig(request);
    await this.readAppConfig();
    try {
      const result = await this.runThinkChat(input.content, { authorEmail: authorEmail ?? undefined, images: input.images });

      // Guard: treat empty LLM response as a failure (same as runFiberPrompt)
      if (!result.text && !result.assistantMessageId) {
        const message = "LLM returned an empty response — the model may be unavailable or the request was rejected. Try again or switch models.";
        this.writeMetadata("status", "idle");
        await this.syncSessionIndex({ status: "idle", title });
        this.emitEvent({ data: { message }, type: "error_message" });
        this.emitEvent({ data: this.readSessionDetails(), type: "state" });
        sendNotification(this.env, this.ctx, { title: `Dodo: ${title} (failed)`, body: message, tags: "x,robot", priority: "high", ownerEmail: this.readMetadata("owner_email") ?? undefined });
        return Response.json({ error: message, sessionId }, { status: 502 });
      }

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
    this.mcpDepth = parseInt(request.headers.get("x-dodo-mcp-depth") ?? "0", 10) || 0;
    this.ensureMetadata(sessionId, ownerEmail);
    this.ensureThinkConfig(request);

    // Server-side slash routing — /generate works the same whether it comes
    // from the browser UI, an MCP `send_prompt` call, a webhook, etc. Image
    // uploads alongside /generate are ignored (FLUX-1-schnell is text-to-image
    // only; multi-reference inputs are FLUX.2).
    const imagePrompt = extractGeneratePrompt(input.content);
    if (imagePrompt) {
      return this.runImageGeneration({
        prompt: imagePrompt,
        sessionId,
        authorEmail,
        ownerEmail,
      });
    }

    // If a prompt is already running, queue this one
    if (this.readMetadata("active_prompt_id")) {
      return this.enqueuePrompt(input.content, authorEmail);
    }

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
      images: input.images,
      authorEmail: authorEmail ?? undefined,
      title,
    }, { maxRetries: 3 });
    this.setPromptFiberId(promptId, fiberId);

    return Response.json({ promptId, status: "queued" }, { status: 202 });
  }

  private async handleGenerate(request: Request): Promise<Response> {
    const input = generateImageSchema.parse(await request.json());
    const sessionId = this.requireSessionId(request);
    const authorEmail = request.headers.get("x-author-email");
    const ownerEmail = request.headers.get("x-owner-email");
    this.ensureMetadata(sessionId, ownerEmail);
    this.ensureThinkConfig(request);
    return this.runImageGeneration({
      prompt: input.content,
      sessionId,
      authorEmail,
      ownerEmail,
    });
  }

  /** Shared image-generation core. Invoked by `handleGenerate` (dedicated
   *  endpoint) and by `handleMessage`/`handlePrompt` when they detect a
   *  `/generate` slash command in the chat content. Returns a Response so
   *  callers can bubble errors and status codes without double-wrapping. */
  private async runImageGeneration(opts: {
    prompt: string;
    sessionId: string;
    authorEmail: string | null;
    ownerEmail: string | null;
  }): Promise<Response> {
    if (opts.prompt.length > FLUX_MAX_PROMPT_LENGTH) {
      return Response.json({ error: `Prompt exceeds ${FLUX_MAX_PROMPT_LENGTH} characters` }, { status: 400 });
    }

    const thinkSessionId = this.getCurrentSessionId();
    if (!thinkSessionId) {
      return Response.json({ error: "No Think session" }, { status: 500 });
    }

    // Reject when another prompt is already running so we don't corrupt
    // `active_prompt_id` or dequeue another user's queued prompt on finish.
    // Matches `handleMessage`'s 409 behaviour — /generate is synchronous so
    // queueing would lose the response anyway.
    if (this.readMetadata("active_prompt_id")) {
      return Response.json({ error: "A prompt is already running" }, { status: 409 });
    }

    const promptId = crypto.randomUUID();
    const title = this.readMetadata("title") ?? (opts.prompt.length > 72 ? opts.prompt.slice(0, 72) + "…" : opts.prompt);

    this.writeMetadata("title", title);
    this.writeMetadata("active_prompt_id", promptId);
    this.writeMetadata("status", "running");
    this.insertPrompt(promptId, opts.prompt, "queued", opts.authorEmail);
    await this.syncSessionIndex({ status: "running", title });
    this.emitEvent({ data: this.readSessionDetails(), type: "state" });

    try {
      // 1. Persist user prompt message
      const userMsgId = this.persistGenerateUserMessage(thinkSessionId, opts.prompt, opts.authorEmail);

      // 2. Generate image via Workers AI. Pass a random seed so repeat
      //    invocations of the same prompt don't collapse to identical output.
      const raw = await this.env.AI.run(FLUX_IMAGE_MODEL, {
        prompt: opts.prompt,
        seed: Math.floor(Math.random() * 1_000_000),
      });
      // Defensive parsing — type assertions would silently break if the
      // Workers AI response shape ever drifts (it already has for FLUX.2).
      if (!raw || typeof raw !== "object" || typeof (raw as { image?: unknown }).image !== "string" || !(raw as { image: string }).image) {
        throw new Error("FLUX returned unexpected response shape");
      }
      const imageData = (raw as { image: string }).image;

      // 3. Persist assistant message with the generated image
      const assistantResult = await this.persistGeneratedImageMessage({
        thinkSessionId,
        sessionId: opts.sessionId,
        prompt: opts.prompt,
        imageData,
        ownerEmail: opts.ownerEmail ?? undefined,
      });

      await this.finishPrompt(promptId, { resultMessageId: assistantResult.messageId, status: "completed" });
      this.emitEvent({ data: this.readSessionDetails(), type: "state" });
      this.emitEvent({ data: this.listPrompts(), type: "prompt" });

      return Response.json({
        message: assistantResult.record,
        promptId,
        status: "completed",
        userMsgId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Image generation failed";
      this.emitEvent({ data: { message }, type: "error_message" });
      await this.finishPrompt(promptId, { error: message, status: "failed" });
      this.emitEvent({ data: this.readSessionDetails(), type: "state" });
      this.emitEvent({ data: this.listPrompts(), type: "prompt" });
      return Response.json({ error: message }, { status: 502 });
    }
  }

  /** Persist the user's /generate prompt as a regular text message and emit a
   *  `message` SSE event so the UI renders it identically to a chat prompt. */
  private persistGenerateUserMessage(thinkSessionId: string, content: string, authorEmail: string | null): string {
    const userMsgId = crypto.randomUUID();
    const userMsg: UIMessage = {
      id: userMsgId,
      role: "user",
      parts: [{ type: "text", text: content }],
    };
    this.sessions.append(thinkSessionId, userMsg);
    this.insertMessageMetadata({
      messageId: userMsgId,
      authorEmail: authorEmail ?? null,
      model: null,
      provider: null,
      tokenInput: 0,
      tokenOutput: 0,
    });
    const userRecord = uiMessageToChatRecord(userMsg, {
      messageId: userMsgId,
      authorEmail: authorEmail ?? null,
      model: null,
      provider: null,
      tokenInput: 0,
      tokenOutput: 0,
      createdAt: nowEpoch(),
    });
    this.emitEvent({ data: userRecord, type: "message" });
    return userMsgId;
  }

  /** Upload the FLUX-generated image to R2 and persist it as an assistant
   *  message. If R2 is unavailable the message falls back to an inline data
   *  URL so the user still sees the image rather than a silent stub — this
   *  matches the design contract in `src/attachments.ts`. */
  private async persistGeneratedImageMessage(opts: {
    thinkSessionId: string;
    sessionId: string;
    prompt: string;
    imageData: string;
    ownerEmail: string | undefined;
  }): Promise<{ messageId: string; record: ChatMessageRecord }> {
    const assistantMsgId = crypto.randomUUID();
    const mediaType = FLUX_IMAGE_MEDIA_TYPE;

    const attachmentRef = await uploadAttachment(this.env, {
      sessionId: opts.sessionId,
      messageId: assistantMsgId,
      mediaType,
      data: opts.imageData,
      source: "assistant",
      ownerEmail: opts.ownerEmail,
    });

    // Short, non-verbose caption — the image carries the meaning. Truncate the
    // prompt so a 2000-char prompt doesn't dominate the bubble.
    const preview = opts.prompt.length > 80 ? `${opts.prompt.slice(0, 80).trimEnd()}…` : opts.prompt;
    const assistantParts: UIMessage["parts"] = [
      { type: "text", text: `🎨 ${preview}` },
    ];
    // Prefer the R2-backed URL; fall back to an inline data URL when R2 is
    // unavailable so the UI still renders something useful in local dev.
    const imageUrl = attachmentRef?.url ?? `data:${mediaType};base64,${opts.imageData}`;
    assistantParts.push({
      type: "file",
      mediaType,
      url: imageUrl,
    } as FileUIPart);

    const assistantMsg: UIMessage = {
      id: assistantMsgId,
      role: "assistant",
      parts: assistantParts,
    };
    this.sessions.append(opts.thinkSessionId, assistantMsg);
    this.insertMessageMetadata({
      messageId: assistantMsgId,
      authorEmail: null,
      model: FLUX_IMAGE_MODEL,
      provider: "Workers AI",
      tokenInput: 0,
      tokenOutput: 0,
    });

    if (attachmentRef) {
      this.insertMessageAttachment({
        messageId: assistantMsgId,
        mediaType,
        url: attachmentRef.url,
        size: attachmentRef.size,
        source: "assistant",
      });
    } else {
      log("warn", "persistGeneratedImageMessage: R2 unavailable, falling back to inline data URL", {
        sessionId: opts.sessionId,
      });
    }

    const record = uiMessageToChatRecord(assistantMsg, {
      messageId: assistantMsgId,
      authorEmail: null,
      model: FLUX_IMAGE_MODEL,
      provider: "Workers AI",
      tokenInput: 0,
      tokenOutput: 0,
      createdAt: nowEpoch(),
    });

    this.emitEvent({ data: record, type: "message" });
    if (attachmentRef) {
      this.emitEvent({
        data: {
          messageId: assistantMsgId,
          attachments: rewriteAttachmentsForClient([
            { mediaType: attachmentRef.mediaType, url: attachmentRef.url, size: attachmentRef.size },
          ]),
        },
        type: "message_attachments",
      });
    }

    return { messageId: assistantMsgId, record };
  }

  private async handleAbort(): Promise<Response> {
    const promptId = this.readMetadata("active_prompt_id");
    if (!promptId) {
      return Response.json({ error: "No active prompt" }, { status: 409 });
    }

    // Signal the AbortController to interrupt the running LLM call immediately
    if (this._fiberAbortController) {
      this._fiberAbortController.abort();
      this._fiberAbortController = null;
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

    // Dequeue next prompt if any
    this.dequeueAndRunNext();
  }

  // ─── Prompt queue management ───

  private enqueuePrompt(content: string, authorEmail?: string | null): Response {
    const id = crypto.randomUUID();
    const now = nowEpoch();
    // Position = max existing position + 1
    const maxRow = this.db.one("SELECT MAX(position) as max_pos FROM prompt_queue");
    const position = maxRow?.max_pos != null ? Number(maxRow.max_pos) + 1 : 1;
    this.db.exec(
      "INSERT INTO prompt_queue (id, content, author_email, created_at, position) VALUES (?, ?, ?, ?, ?)",
      id, content, authorEmail ?? null, now, position,
    );
    this.emitEvent({ data: this.readQueueState(), type: "queue_update" });
    return Response.json({ status: "queued", promptId: id, position }, { status: 202 });
  }

  private dequeueAndRunNext(): void {
    const next = this.db.one("SELECT id, content, author_email FROM prompt_queue ORDER BY position ASC LIMIT 1");
    if (!next) return;

    const queuedId = String(next.id);
    const content = String(next.content);
    const authorEmail = next.author_email ? String(next.author_email) : undefined;

    // Remove from queue
    this.db.exec("DELETE FROM prompt_queue WHERE id = ?", queuedId);
    this.emitEvent({ data: this.readQueueState(), type: "queue_update" });

    // Run as a new prompt via fiber
    const promptId = crypto.randomUUID();
    const title = this.readMetadata("title") ?? (content.length > 72 ? content.slice(0, 72) + "…" : content);

    this.writeMetadata("active_prompt_id", promptId);
    this.writeMetadata("status", "running");
    this.insertPrompt(promptId, content, "queued", authorEmail);

    this.emitEvent({ data: this.readSessionDetails(), type: "state" });

    const fiberId = this.spawnFiber("runFiberPrompt", {
      promptId,
      content,
      authorEmail,
      title,
    }, { maxRetries: 3 });
    this.setPromptFiberId(promptId, fiberId);

    void this.syncSessionIndex({ status: "running", title });
  }

  private readQueueState(): { queue: Array<{ id: string; content: string; position: number; createdAt: string }> } {
    const rows = this.db.all("SELECT id, content, position, created_at FROM prompt_queue ORDER BY position ASC");
    return {
      queue: rows.map((r) => ({
        id: String(r.id),
        content: String(r.content),
        position: Number(r.position),
        createdAt: epochToIso(r.created_at),
      })),
    };
  }

  // ─── Fiber-aware prompt execution ───

  /**
   * Fiber-aware async prompt. Uses stashFiber() checkpoints so that
   * if the DO is evicted mid-chat, recovery replays from the top and
   * skips already-completed work.
   */
  async runFiberPrompt(payload: { promptId: string; content: string; images?: Array<{ data: string; mediaType: string }>; authorEmail?: string; title: string }): Promise<void> {
    const { promptId, content, images, authorEmail, title } = payload;

    // Refresh Think config from the latest account config before each prompt run.
    await this.readAppConfig();

    // Check fiber snapshot — if chat already completed, skip to finalization
    const fiberId = this.readPromptFiberId(promptId);
    if (fiberId) {
      const fiber = this.getFiber(fiberId);
      const snapshot = fiber?.snapshot as { chatCompleted?: boolean; assistantMessageId?: string; text?: string; tokenInput?: number; tokenOutput?: number } | null;
      if (snapshot?.chatCompleted) {
        // Chat completed before eviction — just finalize
        await this.finalizePromptFromFiber(promptId, title, snapshot);
        return;
      }
    }

    // Phase 1: Run chat via Think
    // Create an AbortController so handleAbort() can interrupt the running LLM call
    this._fiberAbortController = new AbortController();
    const signal = this._fiberAbortController.signal;
    try {
      const result = await this.runThinkChat(content, { authorEmail, signal, images });

      // Guard: treat empty LLM response as a failure
      if (!result.text && !result.assistantMessageId) {
        const message = "LLM returned an empty response — the model may be unavailable or the request was rejected. Try again or switch models.";
        this.emitEvent({ data: { message }, type: "error_message" });
        await this.finishPrompt(promptId, { error: message, status: "failed" });
        sendNotification(this.env, this.ctx, { title: `Dodo: ${title} (failed)`, body: message, tags: "x,robot", priority: "high", ownerEmail: this.readMetadata("owner_email") ?? undefined });
        return;
      }

      // Phase 2: Checkpoint immediately after chat completes
      this.stashFiber({
        chatCompleted: true,
        assistantMessageId: result.assistantMessageId,
        text: result.text,
        tokenInput: result.tokenInput,
        tokenOutput: result.tokenOutput,
      });

      // Phase 3: Finalize
      await this.finalizePromptFromFiber(promptId, title, {
        chatCompleted: true,
        assistantMessageId: result.assistantMessageId,
        text: result.text,
        tokenInput: result.tokenInput,
        tokenOutput: result.tokenOutput,
      });
    } catch (error) {
      // Don't report abort-caused errors as failures — the abort handler already
      // marked the prompt as aborted.
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : "Prompt failed";
      this.emitEvent({ data: { message }, type: "error_message" });
      await this.finishPrompt(promptId, { error: message, status: "failed" });
      sendNotification(this.env, this.ctx, { title: `Dodo: ${title} (failed)`, body: message, tags: "x,robot", priority: "high", ownerEmail: this.readMetadata("owner_email") ?? undefined });
    } finally {
      this._fiberAbortController = null;
      await this.syncSessionIndex({ status: "idle", title });
      this.emitEvent({ data: this.listPrompts(), type: "prompt" });
      this.emitEvent({ data: this.readSessionDetails(), type: "state" });
    }
  }

  /** Finalize a prompt from fiber snapshot data. */
  private async finalizePromptFromFiber(
    promptId: string,
    title: string,
    snapshot: { chatCompleted?: boolean; assistantMessageId?: string; text?: string; tokenInput?: number; tokenOutput?: number },
  ): Promise<void> {
    const config = this.getConfig();
    const text = snapshot.text ?? "";
    const assistantRecord = uiMessageToChatRecord(
      { id: snapshot.assistantMessageId ?? "", role: "assistant", parts: [{ type: "text", text }] },
      { messageId: snapshot.assistantMessageId ?? "", model: config?.model ?? null, provider: config?.activeGateway ?? null, tokenInput: snapshot.tokenInput ?? 0, tokenOutput: snapshot.tokenOutput ?? 0, authorEmail: null, createdAt: nowEpoch() },
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
   * Configure the Think session from request headers.
   * On first call, sets up the full config. On subsequent calls, updates
   * the model/gateway if they've changed (e.g. user changed model in settings).
   */
  private ensureThinkConfig(request: Request): void {
    const incomingModel = request.headers.get("x-dodo-model") ?? this.env.DEFAULT_MODEL;
    const incomingGateway = request.headers.get("x-dodo-gateway") === "ai-gateway" ? "ai-gateway" as const : "opencode" as const;
    const existing = this.getConfig();

    if (existing) {
      // Check if model or gateway changed — if so, reconfigure
      if (existing.model === incomingModel && existing.activeGateway === incomingGateway) {
        return; // No change
      }
      this.configure({
        ...existing,
        model: incomingModel,
        activeGateway: incomingGateway,
        opencodeBaseURL: request.headers.get("x-dodo-opencode-base-url") ?? existing.opencodeBaseURL,
        aiGatewayBaseURL: request.headers.get("x-dodo-ai-base-url") ?? existing.aiGatewayBaseURL,
      });
      return;
    }

    // First-time setup
    const config: DodoConfig = {
      sessionId: this.sessionId(),
      ownerEmail: this.readMetadata("owner_email") ?? "",
      createdAt: this.readMetadata("created_at") ?? new Date().toISOString(),
      browserEnabled: this.readMetadata("browser_enabled") === "true",
      activeGateway: incomingGateway,
      gitAuthorEmail: this.env.GIT_AUTHOR_EMAIL ?? "dodo@example.com",
      gitAuthorName: this.env.GIT_AUTHOR_NAME ?? "Dodo",
      model: incomingModel,
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

  /**
   * Persist an attachment reference. Used for tool-produced screenshots and
   * assistant-generated images so history restore after reload can surface
   * the same images that were visible during the stream.
   *
   * For tool attachments, `messageId` is initially the tool call id (we
   * don't know the assistant messageId at tool-result time). After the
   * stream completes, `rebindToolAttachments` remaps the rows.
   */
  private insertMessageAttachment(input: {
    messageId: string;
    toolCallId?: string | null;
    mediaType: string;
    url: string;
    size: number;
    source: "user" | "assistant" | "tool";
  }): void {
    this.db.exec(
      "INSERT INTO message_attachments (message_id, tool_call_id, media_type, url, size, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      input.messageId,
      input.toolCallId ?? null,
      input.mediaType,
      input.url,
      input.size,
      input.source,
      nowEpoch(),
    );
  }

  /**
   * Rebind attachments originally stored under a tool_call_id to the actual
   * assistant message id, now that the stream has finished and we know it.
   * Idempotent — repeated calls with the same args do nothing new.
   */
  private rebindToolAttachments(toolCallIds: string[], assistantMessageId: string): void {
    if (toolCallIds.length === 0) return;
    const placeholders = toolCallIds.map(() => "?").join(",");
    this.db.exec(
      `UPDATE message_attachments SET message_id = ? WHERE tool_call_id IN (${placeholders}) AND message_id != ?`,
      assistantMessageId,
      ...toolCallIds,
      assistantMessageId,
    );
  }

  /** List attachment refs for one or more messages, ordered by creation time. */
  private listMessageAttachments(messageIds: string[]): Map<string, Array<{ mediaType: string; url: string; size: number }>> {
    const result = new Map<string, Array<{ mediaType: string; url: string; size: number }>>();
    if (messageIds.length === 0) return result;
    const placeholders = messageIds.map(() => "?").join(",");
    const rows = this.db.all(
      `SELECT message_id, media_type, url, size FROM message_attachments WHERE message_id IN (${placeholders}) ORDER BY id ASC`,
      ...messageIds,
    );
    for (const row of rows) {
      const id = String(row.message_id);
      const list = result.get(id) ?? [];
      list.push({
        mediaType: String(row.media_type),
        url: String(row.url),
        size: Number(row.size ?? 0),
      });
      result.set(id, list);
    }
    return result;
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
   * List messages from Think storage, joined with sidecar metadata and
   * persisted attachment refs. Returns ChatMessageRecord[] for backward
   * compatibility.
   *
   * Attachments come from two places:
   *   1. The UIMessage parts themselves — user uploads and assistant-
   *      generated file parts live here. uiMessageToChatRecord handles them.
   *   2. The message_attachments table — tool-produced screenshots and
   *      assistant-generated images, stored separately because Think's
   *      enforceRowSizeLimit would strip them from message parts at >1KB.
   *
   * We merge both so the client sees a single `attachments` list regardless
   * of which storage path produced it.
   */
  private listThinkMessages(): ChatMessageRecord[] {
    const thinkSessionId = this.getCurrentSessionId();
    if (!thinkSessionId) return [];
    const history = this.sessions.getHistory(thinkSessionId);
    const records = history.map((msg) => {
      const meta = this.readMessageMetadata(msg.id);
      return uiMessageToChatRecord(msg, meta ?? undefined);
    });
    if (records.length === 0) return records;
    const attachmentsByMsgId = this.listMessageAttachments(records.map((r) => r.id));
    for (const record of records) {
      const persisted = attachmentsByMsgId.get(record.id);
      if (!persisted || persisted.length === 0) continue;
      // Rewrite stored URLs (dodo-attachment://) to session-scoped HTTP paths
      // the client can load. rewriteAttachmentsForClient leaves data URLs and
      // external URLs untouched for the local-dev fallback path.
      const rewritten = rewriteAttachmentsForClient(persisted) ?? persisted;
      const merged = [...(record.attachments ?? []), ...rewritten];
      // Dedupe by URL — if the same image ended up on both the UIMessage
      // part and the side-table (shouldn't happen in practice, but belt-
      // and-braces), we don't want the client to render it twice.
      const seen = new Set<string>();
      record.attachments = merged.filter((a) => {
        if (seen.has(a.url)) return false;
        seen.add(a.url);
        return true;
      });
    }
    return records;
  }

  /**
   * Run a chat turn via Think.chat().
   * Bridges Think streaming events to Dodo's SSE/WS event format.
   * Returns the assistant message ID and token usage.
   */
  private async runThinkChat(
    userContent: string,
    options?: { authorEmail?: string; signal?: AbortSignal; images?: Array<{ data: string; mediaType: string }> },
  ): Promise<{ assistantMessageId: string; tokenInput: number; tokenOutput: number; text: string }> {
    // Connect MCP servers before Think calls getTools()
    await this.connectMcpServers();

    // Insert user message metadata
    const userMsgId = crypto.randomUUID();
    const parts: UIMessage["parts"] = [{ type: "text", text: userContent }];
    if (options?.images?.length) {
      for (const img of options.images) {
        // Pass raw base64 in the url field — the AI SDK's downloadAssets step
        // tries new URL(data) which throws for raw base64 (not a valid URL),
        // so it skips the download. convertToLanguageModelV3DataContent then
        // handles the raw string as inline base64 data.
        const filePart = {
          type: "file",
          mediaType: img.mediaType,
          url: img.data,
        } satisfies FileUIPart;
        parts.push(filePart);
      }
    }
    const userMsg: UIMessage = {
      id: userMsgId,
      role: "user",
      parts,
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
    let fullText = "";
    let streamError: string | null = null;

    // Reset per-turn tool attachment cache. The map is keyed by toolCallId and
    // populated by the onToolAttachments callback in getTools() — clearing here
    // ensures attachments from a previous prompt don't leak into this turn's
    // tool_result events.
    this._toolAttachments.clear();
    // Collect assistant-generated images streamed during this turn. Uploaded
    // to R2 at onDone() once we know the assistant message id.
    const generatedImages: Array<{ mediaType: string; url: string }> = [];

    const callback: StreamCallback = {
      onEvent: (json: string) => {
        try {
          const chunk = JSON.parse(json);
          // Bridge Think chunk events to Dodo SSE format. Chunks come from
          // the AI SDK's `toUIMessageStream()` pipeline — see the ai package
          // for the full chunk type union.
          if (chunk.type === "text-delta") {
            const delta = chunk.delta ?? "";
            fullText += delta;
            this.emitEvent({ data: { delta }, type: "text_delta" });
          } else if (chunk.type === "tool-input-available") {
            // Tool arguments finalised — show the user that a tool is running.
            this.emitEvent({
              data: {
                toolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                input: chunk.input,
              },
              type: "tool_call",
            });
          } else if (chunk.type === "tool-output-available") {
            // Tool finished — emit the result plus any images the tool
            // produced (streamed earlier via the onToolAttachments callback).
            const refs = this._toolAttachments.get(chunk.toolCallId) ?? [];
            this.emitEvent({
              data: {
                toolCallId: chunk.toolCallId,
                output: chunk.output,
                attachments: rewriteAttachmentsForClient(
                  refs.map((r) => ({ mediaType: r.mediaType, url: r.url, size: r.size })),
                ),
              },
              type: "tool_result",
            });
          } else if (chunk.type === "file") {
            // Assistant generated an image (Gemini, Gemma vision, etc.).
            // The AI SDK emits a data URL; we defer the R2 upload to onDone()
            // so we can key it by the assistant message id.
            if (typeof chunk.mediaType === "string" && typeof chunk.url === "string") {
              generatedImages.push({ mediaType: chunk.mediaType, url: chunk.url });
            }
          } else if (chunk.type === "error") {
            // AI SDK emits { type: "error", errorText: "..." } when the gateway
            // returns an error. Think's applyChunkToParts silently drops these.
            // Capture so we can throw after the stream ends.
            streamError = chunk.errorText ?? chunk.error ?? "Unknown LLM error";
            console.error("[runThinkChat] stream error chunk:", streamError);
          }
          // Token usage is captured via onChatMessage() override — see _lastUsage.
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
        streamError = error;
      },
    };

    await this.chat(userMsg, callback, { signal: options?.signal });

    // Flush workspace changes to Artifacts. Fire-and-forget — never blocks the turn.
    const artifactsCtx = await this.getOrCreateArtifactsContext().catch(() => null);
    if (artifactsCtx) {
      void flushTurnToArtifacts({
        workspace: this.workspace,
        remote: artifactsCtx.remote,
        tokenSecret: artifactsCtx.tokenSecret,
        message: `dodo: turn ${new Date().toISOString()}`,
        author: options?.authorEmail
          ? { name: options.authorEmail, email: options.authorEmail }
          : { name: "Dodo", email: "dodo@workers.dev" },
      });
    }

    // If the stream contained an error chunk that Think silently dropped,
    // throw it so the caller (runFiberPrompt) can surface it properly.
    if (streamError && !fullText) {
      throw new Error(streamError);
    }

    // Get config for provider info
    const config = this.getConfig();
    const model = config?.model ?? this.env.DEFAULT_MODEL;
    const gateway = config?.activeGateway ?? "opencode";

    // Read captured token usage from onChatMessage() override
    const tokenInput = this._lastUsage?.inputTokens ?? 0;
    const tokenOutput = this._lastUsage?.outputTokens ?? 0;

    // Insert assistant message metadata
    if (assistantMessageId) {
      this.insertMessageMetadata({
        messageId: assistantMessageId,
        model,
        provider: gateway,
        tokenInput,
        tokenOutput,
      });

      // Rebind any tool-produced attachments recorded during this turn from
      // their tool_call_id buckets to the actual assistant message id. This
      // is what makes screenshots show up on reload — listMessageAttachments
      // queries by message_id, and without the rebind the rows would only be
      // findable via tool_call_id which isn't on the ChatMessageRecord.
      const toolCallIds = Array.from(this._toolAttachments.keys());
      if (toolCallIds.length > 0) {
        this.rebindToolAttachments(toolCallIds, assistantMessageId);
      }
    }

    // Persist any assistant-generated images to R2 and emit a message-level
    // attachments event so the UI can render them. We do this post-stream
    // because we need the assistant message id (only known after onDone) to
    // key the R2 object. The inline data URL remains on the UIMessage part;
    // `uiMessageToChatRecord` handles the transport from data URL → served URL.
    if (assistantMessageId && generatedImages.length > 0) {
      const uploaded: AttachmentRef[] = [];
      for (const img of generatedImages) {
        const ref = await uploadAttachment(this.env, {
          sessionId: this.sessionId(),
          messageId: assistantMessageId,
          mediaType: img.mediaType,
          data: img.url, // uploadAttachment strips the data: prefix
          ownerEmail: options?.authorEmail,
          source: "assistant",
        });
        if (ref) uploaded.push(ref);
      }
      if (uploaded.length > 0) {
        // Persist before emitting — if the client reloads during emission
        // we still want the image to surface from history.
        for (const ref of uploaded) {
          this.insertMessageAttachment({
            messageId: assistantMessageId,
            mediaType: ref.mediaType,
            url: ref.url,
            size: ref.size,
            source: "assistant",
          });
        }
        this.emitEvent({
          data: {
            messageId: assistantMessageId,
            attachments: rewriteAttachmentsForClient(
              uploaded.map((r) => ({ mediaType: r.mediaType, url: r.url, size: r.size })),
            ),
          },
          type: "message_attachments",
        });
      }
    }

    // Check if context compaction is needed.
    // Awaited (not fire-and-forget) so the compaction completes before the next
    // request arrives. Without this, there's a race: the next chat() call may
    // start before addCompaction() finishes, causing getHistory() to return
    // the old non-compacted messages and the compaction summary to be invisible.
    try {
      await this.maybeCompactContext();
    } catch (err) {
      console.warn("[compaction] Post-chat compaction failed:", err instanceof Error ? err.message : err);
    }

    return { assistantMessageId, tokenInput, tokenOutput, text: fullText };
  }

  /**
   * Check if context compaction is needed and run it if so.
   *
   * Implements several context management tactics from pi-mono:
   * - Turn-aware cut points: never splits tool-call/result pairs
   * - Conversation serialization: [Role]: format with 2K tool result cap
   * - Structured summary format: rigid template with cumulative file tracking
   * - Iterative summary updates: updates previous summary instead of regenerating
   *
   * Triggers when the last turn's input tokens exceed COMPACTION_TRIGGER_PERCENT
   * of the context budget.
   */
  private async maybeCompactContext(options?: { force?: boolean }): Promise<void> {
    const thinkSessionId = this.getCurrentSessionId();
    if (!thinkSessionId) return;

    // Check if context usage warrants compaction
    const config = this.getConfig();
    const modelId = config?.model ?? this.env.DEFAULT_MODEL ?? "";
    const contextWindow = CONTEXT_WINDOW_TOKENS[modelId] ?? DEFAULT_CONTEXT_WINDOW;
    const contextBudget = Math.floor(contextWindow * CONTEXT_BUDGET_FACTOR);

    // When force=true (overflow recovery) or context was truncated by
    // assembleContext(), skip the usage threshold check. The truncation flag
    // catches the Catch-22: assembleContext drops old messages → LLM reports
    // low usage → compaction threshold not met → messages stay dropped forever.
    const contextWasTruncated = this._contextTruncated;
    this._contextTruncated = false; // Reset for next turn
    let usagePercent = 100; // Default to high for forced/truncated compaction
    if (!options?.force && !contextWasTruncated) {
      const latestAssistant = this.db.one(
        "SELECT token_input FROM message_metadata WHERE model IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      );
      const lastInputTokens = Number(latestAssistant?.token_input ?? 0);
      if (lastInputTokens === 0) return;

      usagePercent = Math.round((lastInputTokens / contextBudget) * 100);
      if (usagePercent < COMPACTION_TRIGGER_PERCENT) return;
    }

    const history = this.sessions.getHistory(thinkSessionId);
    if (history.length < 6) return;

    // Filter out synthetic compaction summary messages (IDs like "compaction_<uuid>")
    const realMessages = history.filter((m) => !m.id.startsWith("compaction_"));
    if (realMessages.length < 6) return;

    // ─── Turn-aware cut point (Tactic 4) ───
    // Find the cut point that doesn't split tool-call/result pairs.
    // A "turn" is: user message → assistant message(s) → tool result(s).
    // Valid cut points: the boundary BEFORE a user message.
    const targetCompactCount = Math.max(2, Math.floor(realMessages.length * COMPACTION_MESSAGE_FRACTION));
    let compactCount = targetCompactCount;

    // Walk forward from the target cut point to find a valid boundary.
    // A valid boundary is right before a "user" message (never between
    // an assistant tool-call and its result, or mid-assistant-turn).
    while (compactCount < realMessages.length - 2) {
      const nextMsg = realMessages[compactCount];
      if (nextMsg.role === "user") break; // Valid cut: next message starts a new turn
      compactCount++; // Skip forward past tool results / mid-turn messages
    }
    // If we couldn't find a valid cut point, fall back to the target
    if (compactCount >= realMessages.length - 2) {
      compactCount = targetCompactCount;
    }

    const messagesToCompact = realMessages.slice(0, compactCount);
    const fromMessageId = messagesToCompact[0].id;
    const toMessageId = messagesToCompact[compactCount - 1].id;

    // Check if this range is already compacted
    const existingCompactions = this.sessions.getCompactions(thinkSessionId);
    const alreadyCompacted = existingCompactions.some(
      (c) => c.from_message_id === fromMessageId || c.to_message_id === toMessageId,
    );
    if (alreadyCompacted) return;

    // ─── Cumulative file tracking (Tactic 3) ───
    // Track files read and modified across the messages being compacted.
    // Also carry forward file lists from previous compactions.
    const readFiles = new Set<string>();
    const modifiedFiles = new Set<string>();

    // Carry forward from previous compaction summaries
    for (const compaction of existingCompactions) {
      const fileMatch = compaction.summary.match(/<read-files>([\s\S]*?)<\/read-files>/);
      if (fileMatch) {
        fileMatch[1].split("\n").map(f => f.trim()).filter(Boolean).forEach(f => readFiles.add(f));
      }
      const modMatch = compaction.summary.match(/<modified-files>([\s\S]*?)<\/modified-files>/);
      if (modMatch) {
        modMatch[1].split("\n").map(f => f.trim()).filter(Boolean).forEach(f => modifiedFiles.add(f));
      }
    }

    // Extract file operations from messages being compacted.
    // UIMessage tool parts in AI SDK v5 use type "dynamic-tool" (not "tool-invocation"),
    // field "input" (not "args"), and "output" (not "result").
    for (const msg of messagesToCompact) {
      if (msg.role !== "assistant") continue;
      for (const part of msg.parts) {
        const p = part as { type: string; toolName?: string; input?: Record<string, unknown> };
        if (p.type !== "dynamic-tool" || !p.toolName) continue;
        const path = (p.input?.path as string) ?? "";
        if (!path) continue;
        if (p.toolName === "read") readFiles.add(path);
        else if (p.toolName === "write") modifiedFiles.add(path);
        else if (p.toolName === "edit") modifiedFiles.add(path);
      }
    }

    // Remove modified files from the read set (modified takes precedence)
    for (const f of modifiedFiles) readFiles.delete(f);

    // ─── Conversation serialization (Tactic 6) ───
    // Convert messages to flat [Role]: text format with 2K cap on tool results.
    // This prevents the summarizer from entering "conversation mode".
    const TOOL_RESULT_CAP = 2_000;
    const serializedParts: string[] = [];
    for (const msg of messagesToCompact) {
      const textContent = msg.parts
        ?.filter((p: { type: string }) => p.type === "text")
        .map((p: { type: string; text?: string }) => (p as { text: string }).text)
        .join("") ?? "";

      if (msg.role === "user" && textContent) {
        serializedParts.push(`[User]: ${textContent.slice(0, 2_000)}`);
      } else if (msg.role === "assistant") {
        // Extract tool calls (AI SDK v5: "dynamic-tool" parts with "input" field)
        const toolCalls = msg.parts
          ?.filter((p: { type: string }) => p.type === "dynamic-tool")
          .map((p: { type: string; toolName?: string; input?: unknown }) => {
            const tc = p as { toolName: string; input: unknown };
            return `${tc.toolName}(${JSON.stringify(tc.input ?? {}).slice(0, 500)})`;
          }) ?? [];

        if (textContent) {
          serializedParts.push(`[Assistant]: ${textContent.slice(0, 2_000)}`);
        }
        if (toolCalls.length > 0) {
          serializedParts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
        }

        // Extract tool results embedded in assistant parts
        // AI SDK v5: "dynamic-tool" parts with "output" field (state === "output-available")
        for (const part of msg.parts ?? []) {
          const p = part as { type: string; output?: unknown; toolName?: string; state?: string };
          if (p.type === "dynamic-tool" && p.output !== undefined) {
            const resultStr = typeof p.output === "string" ? p.output : JSON.stringify(p.output);
            const capped = resultStr.length > TOOL_RESULT_CAP
              ? resultStr.slice(0, TOOL_RESULT_CAP) + `\n\n[... ${resultStr.length - TOOL_RESULT_CAP} more chars truncated]`
              : resultStr;
            serializedParts.push(`[Tool result (${p.toolName ?? "unknown"})]: ${capped}`);
          }
        }
      }
    }

    if (serializedParts.length === 0) return;

    const summaryInput = serializedParts.join("\n\n");

    // ─── Iterative summary update (Tactic 2) ───
    // If there's a previous compaction, use the "update" prompt to preserve
    // accumulated context. Otherwise use the "create" prompt.
    const previousSummary = existingCompactions.length > 0
      ? existingCompactions[existingCompactions.length - 1].summary
      : null;

    // ─── Structured summary format (Tactic 3) ───
    const STRUCTURED_SUMMARY_PROMPT = [
      "Create a structured context checkpoint summary following this EXACT format:",
      "",
      "## Goal",
      "[What the user is trying to accomplish — 1-2 sentences]",
      "",
      "## Constraints & Preferences",
      "- [Requirements mentioned by user]",
      "",
      "## Progress",
      "### Done",
      "- [x] [Completed tasks with specific file paths]",
      "### In Progress",
      "- [ ] [Current work]",
      "### Blocked",
      "- [Issues preventing progress, if any]",
      "",
      "## Key Decisions",
      "- **[Decision]**: [Rationale]",
      "",
      "## Next Steps",
      "1. [What should happen next]",
      "",
      "## Critical Context",
      "- [Specific data, error messages, or configurations needed to continue]",
      "",
      "PRESERVE exact file paths, function names, error messages, and technical specifics.",
      "Be factual and concrete. No vague summaries.",
    ].join("\n");

    const UPDATE_SUMMARY_PROMPT = [
      "Update the existing structured summary with new information from the conversation.",
      "",
      "Rules:",
      "- PRESERVE all existing information that is still relevant",
      "- ADD new progress, decisions, and context",
      "- Move items from 'In Progress' to 'Done' when completed",
      "- UPDATE 'Next Steps' based on what was accomplished",
      "- PRESERVE exact file paths, function names, error messages",
      "- REMOVE items only if they are clearly no longer relevant",
      "",
      "Output the COMPLETE updated summary using the same format:",
      "",
      "## Goal",
      "## Constraints & Preferences",
      "## Progress (Done / In Progress / Blocked)",
      "## Key Decisions",
      "## Next Steps",
      "## Critical Context",
    ].join("\n");

    try {
      // Build a Workers AI provider for compaction. The AI Gateway provides an
      // OpenAI-compatible endpoint at {base}/workers-ai/v1 that accepts @cf/ model IDs.
      // Build the user message with conversation + optional previous summary
      const userParts: string[] = [];
      userParts.push("<conversation>");
      userParts.push(summaryInput.slice(0, 30_000));
      userParts.push("</conversation>");

      if (previousSummary) {
        userParts.push("");
        userParts.push("<previous-summary>");
        userParts.push(previousSummary);
        userParts.push("</previous-summary>");
      }

      userParts.push("");
      userParts.push(previousSummary ? UPDATE_SUMMARY_PROMPT : STRUCTURED_SUMMARY_PROMPT);

      const compactionMessages: Array<{ role: "system" | "user"; content: string }> = [
        {
          role: "system",
          content: "You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified. Do NOT continue the conversation. ONLY output the structured summary.",
        },
        {
          role: "user",
          content: userParts.join("\n"),
        },
      ];

      // Use the session's LLM gateway to call the compaction model.
      // Tries COMPACTION_MODEL first, falls back to the session model if it fails.
      const appConfig = this.getAppConfigFromThink();
      const provider = buildProvider(appConfig, this.env);
      let summary: string | undefined;
      let compactionModelUsed = COMPACTION_MODEL;
      try {
        const compactionLLM = provider.chatModel(COMPACTION_MODEL);
        const result = await generateText({
          model: compactionLLM,
          messages: compactionMessages,
          maxOutputTokens: 2048,
        });
        summary = result.text;
        if (summary) {
          log("info", "compaction: summary generated", {
            sessionId: this.sessionId(),
            model: COMPACTION_MODEL,
            summaryChars: summary.length,
          });
        }
      } catch (compactionErr) {
        compactionModelUsed = modelId;
        log("warn", "compaction: primary model failed, falling back to session model", {
          sessionId: this.sessionId(),
          model: COMPACTION_MODEL,
          fallback: modelId,
          error: compactionErr instanceof Error ? compactionErr.message : String(compactionErr),
        });
        const fallbackModel = provider.chatModel(modelId);
        const result = await generateText({
          model: fallbackModel,
          messages: compactionMessages,
          maxOutputTokens: 1500,
        });
        summary = result.text;
      }
      if (!summary || summary.length < 20) return;

      // Append cumulative file tracking tags
      const readFileList = [...readFiles].sort();
      const modFileList = [...modifiedFiles].sort();
      if (readFileList.length > 0) {
        summary += `\n\n<read-files>\n${readFileList.join("\n")}\n</read-files>`;
      }
      if (modFileList.length > 0) {
        summary += `\n\n<modified-files>\n${modFileList.join("\n")}\n</modified-files>`;
      }

      // Tag summary with model used (for diagnostics via debug endpoint)
      summary += `\n\n<!-- compaction-model: ${compactionModelUsed} -->`;

      this.sessions.addCompaction(thinkSessionId, summary, fromMessageId, toMessageId);
      log("info", "compaction complete", {
        sessionId: this.sessionId(),
        compactedMessages: compactCount,
        usagePercent,
        summaryChars: summary.length,
        model: compactionModelUsed,
        readFiles: readFileList.length,
        modifiedFiles: modFileList.length,
        iterative: !!previousSummary,
      });
    } catch (error) {
      console.warn(
        "[compaction:ERROR] Failed to generate summary:",
        error instanceof Error ? `${error.message}\n${error.stack}` : error,
      );
    }
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

    // Context window info
    const config = this.getConfig();
    const modelId = config?.model ?? this.env.DEFAULT_MODEL ?? "";
    const contextWindow = CONTEXT_WINDOW_TOKENS[modelId] ?? DEFAULT_CONTEXT_WINDOW;
    const contextBudget = Math.floor(contextWindow * CONTEXT_BUDGET_FACTOR);
    // Use latest assistant turn's input tokens as the best proxy for current context size
    const latestAssistant = this.db.one(
      "SELECT token_input FROM message_metadata WHERE model IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    );
    const estimatedContext = Number(latestAssistant?.token_input ?? 0);
    const contextUsagePercent = contextBudget > 0
      ? Math.round((estimatedContext / contextBudget) * 100)
      : 0;

    // Compaction info
    const thinkSid = this.getCurrentSessionId();
    const compactionCount = thinkSid ? this.sessions.getCompactions(thinkSid).length : 0;

    return {
      activePromptId,
      activeStreamCount: this.clients.size,
      compactionCount,
      contextBudget,
      contextUsagePercent,
      contextWindow,
      createdAt,
      messageCount: this.messageCount(),
      model: modelId,
      ownerEmail,
      sessionId,
      status,
      totalTokenInput,
      totalTokenOutput,
      updatedAt,
    };
  }

  /**
   * Build a token usage report for the current session.
   * Returns cumulative totals, context window info, and per-message breakdown.
   */
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

  private openEventStream(request: Request): Response {
    const stream = new TransformStream<Uint8Array>();
    const writer = stream.writable.getWriter();
    this.clients.set(writer, Promise.resolve());
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
    // Broadcast to SSE clients — chain writes per-writer to prevent
    // concurrent writer.write() calls which violate the WritableStream
    // contract and silently disconnect clients.
    for (const [writer, pending] of [...this.clients]) {
      const next = pending
        .then(() => this.writeEvent(writer, event))
        .catch(() => {
          this.clients.delete(writer);
        });
      this.clients.set(writer, next);
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

  private _artifactsRepo: ArtifactsRepo | null = null;
  private _artifactsRemote: string | null = null;
  private _artifactsTokenSecret: string | null = null;

  private sessionId(): string {
    return this.readMetadata("session_id") ?? "";
  }

  /**
   * Get or create this session's Artifacts repo. Returns null if Artifacts
   * is unavailable (network error, quota, etc.) — callers must tolerate
   * absence silently.
   */
  async getOrCreateArtifactsContext(sessionIdHint?: string): Promise<{ repo: ArtifactsRepo; remote: string; tokenSecret: string } | null> {
    if (this._artifactsRepo && this._artifactsRemote && this._artifactsTokenSecret) {
      return { repo: this._artifactsRepo, remote: this._artifactsRemote, tokenSecret: this._artifactsTokenSecret };
    }

    try {
      // Fall back to the hint if DO metadata isn't populated yet (e.g. when
      // the DO is invoked via RPC from MCP before the first HTTP request
      // sets session_id metadata).
      const resolvedSessionId = this.sessionId() || sessionIdHint || "";
      if (!resolvedSessionId) return null;
      const name = `dodo-${resolvedSessionId}`;
      let repo = await this.env.ARTIFACTS.get(name);
      let remote: string | null = null;
      let tokenSecret: string | null = null;

      if (!repo) {
        const created = await this.env.ARTIFACTS.create(name, { setDefaultBranch: "main" });
        repo = created.repo;
        remote = created.remote;
        tokenSecret = stripTokenExpiry(created.token);
      } else {
        const info = await repo.info();
        if (!info?.remote) return null;
        remote = info.remote;
        const tokenResult = await repo.createToken("write", 3600);
        tokenSecret = stripTokenExpiry(tokenResult.token);
      }

      if (!remote || !tokenSecret) return null;

      this._artifactsRepo = repo;
      this._artifactsRemote = remote;
      this._artifactsTokenSecret = tokenSecret;
      return { repo, remote, tokenSecret };
    } catch (err) {
      console.warn("[artifacts] failed to get/create repo:", err);
      return null;
    }
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

  /**
   * Connect to enabled MCP servers for this session.
   *
   * Fetches the effective MCP configs from UserControl (respecting per-session
   * overrides), resolves encrypted headers, connects each gatekeeper, and
   * pre-fetches tool listings so getTools() can read them synchronously.
   *
   * Safe to call multiple times — disconnects previous gatekeepers first.
   */
  private async connectMcpServers(): Promise<void> {
    const ownerEmail = this.readMetadata("owner_email");
    if (!ownerEmail) return;

    const sessionId = this.sessionId();
    if (!sessionId) return;

    // Disconnect any previously connected gatekeepers
    for (const gk of this.mcpGatekeepers) {
      gk.disconnect();
    }
    this.mcpGatekeepers = [];

    try {
      const stub = getUserControlStub(this.env, ownerEmail);

      // Fetch effective configs (global configs + session overrides)
      const configsRes = await stub.fetch(
        `https://user-control/sessions/${encodeURIComponent(sessionId)}/effective-mcp-configs`,
        { headers: { "x-owner-email": ownerEmail } },
      );
      if (!configsRes.ok) return;

      const { configs } = (await configsRes.json()) as {
        configs: Array<McpGatekeeperConfig & { overridden: boolean }>;
      };

      // Gate browser-rendering MCP on the per-session browser_enabled flag.
      // If browser is disabled for this session, skip the browser-rendering config
      // even if the MCP config itself is enabled.
      const browserEnabled = this.readMetadata("browser_enabled") === "true";

      // Filter to enabled HTTP configs with URLs
      const enabled = configs.filter((c) => {
        if (!c.enabled || c.type !== "http" || !c.url) return false;
        if (c.id === "browser-rendering" && !browserEnabled) return false;
        return true;
      });
      if (enabled.length === 0) return;

      // Resolve encrypted headers and connect each gatekeeper
      const connected: McpGatekeeper[] = [];
      for (const config of enabled) {
        try {
          // Resolve headers via internal secret endpoint
          let headers: Record<string, string> | undefined;
          if (config.headerKeys?.length) {
            headers = {};
            for (const headerName of config.headerKeys) {
              const secretRes = await stub.fetch(
                `https://user-control/internal/secret/mcp:${encodeURIComponent(config.id)}:${encodeURIComponent(headerName)}`,
                { headers: { "x-owner-email": ownerEmail } },
              );
              if (secretRes.ok) {
                const { value } = (await secretRes.json()) as { value: string };
                headers[headerName] = value;
              }
            }
          }

          const gk = new HttpMcpGatekeeper({
            ...config,
            headers,
          }, this.mcpDepth);

          await gk.connect();
          await gk.listTools(); // Pre-populate cache for synchronous getTools()
          connected.push(gk);
        } catch (error) {
          // Log but don't fail — one broken MCP server shouldn't block the session
          console.warn(
            `MCP connect failed for "${config.name}" (${config.id}):`,
            error instanceof Error ? error.message : error,
          );
        }
      }

      this.mcpGatekeepers = connected;
    } catch (error) {
      console.warn("connectMcpServers failed:", error instanceof Error ? error.message : error);
    }
  }

  private async readAppConfig(): Promise<AppConfig> {
    const ownerEmail = this.readMetadata("owner_email");
    if (!ownerEmail) {
      throw new Error("Session has no owner_email. Run migration (POST /api/admin/migrate) to fix legacy sessions.");
    }
    const stub = getUserControlStub(this.env, ownerEmail);
    const response = await stub.fetch("https://user-control/config");
    const appConfig = (await response.json()) as AppConfig;

    const existing = this.getConfig();
    const dodoConfig: DodoConfig = {
      sessionId: this.sessionId(),
      ownerEmail,
      createdAt: this.readMetadata("created_at") ?? new Date().toISOString(),
      browserEnabled: this.readMetadata("browser_enabled") === "true",
      activeGateway: existing?.activeGateway ?? appConfig.activeGateway,
      gitAuthorEmail: appConfig.gitAuthorEmail,
      gitAuthorName: appConfig.gitAuthorName,
      model: existing?.model ?? appConfig.model,
      opencodeBaseURL: existing?.opencodeBaseURL ?? appConfig.opencodeBaseURL,
      aiGatewayBaseURL: existing?.aiGatewayBaseURL ?? appConfig.aiGatewayBaseURL,
      // Always pull the latest prefix from UserControl so config changes
      // take effect on the next prompt without requiring a session restart.
      systemPromptPrefix: appConfig.systemPromptPrefix,
    };
    this.configure(dodoConfig);

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

  /**
   * Compute the UserControl DO ID hex string for a given owner email.
   * Used to identify the owner in outbound sandbox requests without exposing PII.
   */
  private resolveOwnerId(ownerEmail?: string): string | undefined {
    if (!ownerEmail) return undefined;
    return this.env.USER_CONTROL.idFromName(ownerEmail).toString();
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

    for (const [writer] of [...this.clients]) {
      try { void writer.close(); } catch { /* ignore */ }
      this.clients.delete(writer);
    }
  }
}

/**
 * Artifacts tokens come back as "art_v1_<secret>?expires=<unix>".
 * Git Basic auth needs just the secret.
 */
export function stripTokenExpiry(token: string): string {
  const idx = token.indexOf("?expires=");
  return idx === -1 ? token : token.slice(0, idx);
}
