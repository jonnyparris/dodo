/**
 * Subagent profile abstraction.
 *
 * Each entry in this file is the single source of truth for one
 * subagent's "contract" — its prompt, step budget, timeouts, tool-set
 * shape, and model resolution. Both the in-process subagent runner
 * (`runSubagent` in subagent-runner.ts) and the facet DO classes
 * (ExploreAgent, TaskAgent) consume profiles instead of carrying
 * duplicated copies of those constants.
 *
 * Adding a new subagent kind is therefore one new exported `AgentProfile`
 * constant plus, if it needs a separate DO for parallelism / isolation,
 * a thin Agent<Env> subclass. The runner does not need new branches.
 *
 * Profile constants are intentionally *not* held in a registry. A
 * runtime registry only earns its keep once subagents are dynamically
 * discovered (e.g. workspace-defined ones from `.claude/agents/*.md`),
 * which we don't do today.
 */

/**
 * Stable model-family routing for subagents.
 *
 * Maps the prefix of the main session's model id to the model the
 * subagent should run on by default when no explicit override comes
 * through the call or the per-session config. The pairs encode the
 * "use the same vendor as the parent, but a smaller/faster model"
 * heuristic — keeps gateway routing, key handling, and provider
 * quirks consistent between parent and child.
 *
 * The map shape is also the integration point for adding a new family
 * (e.g. mistral, qwen) without touching either subagent's runtime path.
 */
export const SUBAGENT_FAMILY_MODELS: Record<string, string> = {
  "anthropic/": "anthropic/claude-haiku-4-5",
  "openai/": "openai/gpt-4.1-mini",
  "google/": "google/gemini-2.5-flash",
  "deepseek/": "deepseek/deepseek-chat",
};

/**
 * Look up the default subagent model for a given main-session model id.
 * Falls back to the main model itself when no family prefix matches —
 * makes the function safe for non-mainstream model ids without
 * silently swapping to a wrong-vendor model.
 */
export function getSubagentFamilyModel(mainModel: string): string {
  for (const [prefix, model] of Object.entries(SUBAGENT_FAMILY_MODELS)) {
    if (mainModel.startsWith(prefix)) return model;
  }
  return mainModel;
}

/**
 * Profile-level metadata for one subagent kind. Held as a plain
 * exported constant — no class hierarchy, no registry — so unit tests
 * can snapshot the values directly and refactor diffs stay small.
 *
 * Fields:
 * - `name`        — the user-visible identity. Pluggable into log
 *                   lines, transcript rows, and tool descriptions.
 * - `systemPrompt`— the instructions the subagent's model sees.
 * - `maxSteps`    — hard step budget for `stopWhen(stepCountIs(...))`.
 * - `timeoutMs`   — wall-clock cap on in-process / shared runs.
 * - `facetTimeoutMs` — longer ceiling for facet-DO runs that escape the
 *                   parent's turn budget.
 * - `fallbackHint`— optional recovery hint appended to failure
 *                   summaries (currently only `explore`). Keeps the
 *                   orchestrator from declaring the task impossible.
 * - `resolveDefaultModel` — strategy for picking the subagent's model
 *                   when neither the call args nor the per-session
 *                   default supply one. Defaulted to the family map.
 * - `defaultResultSchemaName` — when set, the runner attempts a
 *                   structured-output call against the schema registered
 *                   under this name in `result-schema-registry.ts`.
 *                   Per-call overrides win. Stored as a name rather than
 *                   the schema object so profiles stay JSON-serialisable
 *                   for snapshot diffing and the registry is the single
 *                   source of truth.
 * - `kind`        — a stable lowercase identifier matching the keyword
 *                   `runSubagent` once used as `SubagentInvocation.kind`.
 *                   Kept so transcripts and tests can filter by kind.
 */
export interface AgentProfile {
  readonly kind: "explore" | "task";
  readonly name: string;
  readonly systemPrompt: string;
  readonly maxSteps: number;
  readonly timeoutMs: number;
  readonly facetTimeoutMs?: number;
  readonly fallbackHint?: string;
  readonly resolveDefaultModel: (mainModel: string) => string;
  readonly defaultResultSchemaName?: string;
}

// ─── EXPLORE ────────────────────────────────────────────────────────────

const EXPLORE_MAX_STEPS = 16;
const EXPLORE_TIMEOUT_MS = 60_000;

const EXPLORE_SYSTEM_PROMPT = [
  "You are a search assistant. Your job is to find files and code relevant to the user's query.",
  "",
  "## Rules",
  "- Use grep, find, list, and read to search the workspace.",
  "- Be thorough: try multiple search terms if the first doesn't find results.",
  `- You have a hard budget of ${EXPLORE_MAX_STEPS} steps. **Reserve the last 2 steps for your summary** — at step ${EXPLORE_MAX_STEPS - 2} or earlier, stop calling tools and write your findings.`,
  "- Return a concise summary when done: file paths, relevant line numbers, and key observations.",
  "- Do NOT return full file contents — only the relevant snippets (max 10 lines per file).",
  "- If you find too many results, narrow your search with more specific patterns.",
  "- Focus on answering the user's specific question, not cataloguing everything.",
  "- Emitting SOME summary beats hitting the step limit silent. A rough summary is recoverable; no summary wastes the caller's retry budget.",
].join("\n");

/**
 * Standard hint appended to every explore failure summary. Tells the
 * orchestrator that the failure is transient and points it at the
 * direct read-only tools so it can complete the task without explore.
 *
 * Why this exists: we saw three real sessions where explore returned
 * "internal API error" and the orchestrator (small model, no recovery
 * heuristic) declared the task impossible and stopped — instead of
 * just running `list` + `grep` directly. The hint short-circuits that
 * dead-end.
 */
const EXPLORE_FALLBACK_HINT = [
  "",
  "Recovery: explore is unavailable on this call. Continue the task using `list`,",
  "`find`, `grep`, and `read` directly — they are always available. If the",
  "workspace appears empty, the repo has not been cloned yet; use `git_clone`",
  "or `git_clone_known` first. Do NOT report the task as impossible just",
  "because explore failed.",
].join("\n");

export const EXPLORE_PROFILE: AgentProfile = {
  kind: "explore",
  name: "Explore",
  systemPrompt: EXPLORE_SYSTEM_PROMPT,
  maxSteps: EXPLORE_MAX_STEPS,
  timeoutMs: EXPLORE_TIMEOUT_MS,
  fallbackHint: EXPLORE_FALLBACK_HINT,
  resolveDefaultModel: getSubagentFamilyModel,
};

// ─── TASK ───────────────────────────────────────────────────────────────

const TASK_MAX_STEPS = 20;
const TASK_TIMEOUT_MS = 180_000;
const TASK_FACET_TIMEOUT_MS = 600_000;

const TASK_SYSTEM_PROMPT = [
  "You are a focused subagent dispatched by the main Dodo agent to handle one bounded task.",
  "",
  "## Rules",
  "- You have a subset of the main agent's tools. Use them to complete the task and ONLY the task.",
  "- Do not ask clarifying questions — make a best-effort attempt with the info given.",
  `- You have a hard budget of ${TASK_MAX_STEPS} steps. **Reserve the last 2 steps for your summary** — at step ${TASK_MAX_STEPS - 2} or earlier, stop calling tools and write your summary.`,
  "- Return a compact text summary when done. Include: what you did, paths/line numbers touched, test results if any.",
  "- Do NOT dump large tool outputs into your final message — summarize in 5-15 lines.",
  "- If you hit your step budget without finishing, report what was done and what remains. Your caller will retry.",
  "- Emitting SOME summary beats hitting the step limit silent. A rough summary is recoverable; no summary wastes the caller's retry budget.",
].join("\n");

export const TASK_PROFILE: AgentProfile = {
  kind: "task",
  name: "Task",
  systemPrompt: TASK_SYSTEM_PROMPT,
  maxSteps: TASK_MAX_STEPS,
  timeoutMs: TASK_TIMEOUT_MS,
  facetTimeoutMs: TASK_FACET_TIMEOUT_MS,
  resolveDefaultModel: getSubagentFamilyModel,
};

// ─── Shared helpers ─────────────────────────────────────────────────────

/**
 * Resolve which model to use for a subagent call.
 *
 * Precedence (highest first):
 *   1. Per-call `args.model` (explicit override from the orchestrator).
 *   2. Per-session default (`AppConfig.exploreModel` / `taskModel`).
 *   3. Profile's `resolveDefaultModel` against the main model id.
 *
 * Centralising this here so neither `runSubagent` nor the facet DOs
 * need to know the precedence rules — they pass their profile + a
 * thin context and get a string back.
 */
export function resolveProfileModel(
  profile: AgentProfile,
  args: { model?: unknown },
  sessionDefault: string | undefined,
  mainModel: string,
): string {
  const rawArgModel = args.model;
  if (typeof rawArgModel === "string" && rawArgModel.trim().length > 0) {
    return rawArgModel.trim();
  }
  if (typeof sessionDefault === "string" && sessionDefault.trim().length > 0) {
    return sessionDefault.trim();
  }
  return profile.resolveDefaultModel(mainModel);
}
