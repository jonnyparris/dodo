/**
 * Typed result schemas for subagent / one-shot LLM calls.
 *
 * Replaces "ask the model in JSON-ish freeform and regex-parse" with
 * a single helper that uses the AI SDK's `generateObject` against a
 * caller-supplied schema, with a one-shot validation-retry loop on
 * schema-validation failure.
 *
 * Companion to `agent-profile.ts` (Steal #1) and the workflow runner
 * (Steal #2). The runner accepts an optional `resultSchema` on each
 * profile / per-call options bag; when provided, the model is forced
 * into structured-output mode and the caller gets back the parsed
 * value alongside the conversational text.
 */
import { generateObject, type LanguageModel } from "ai";
import type { z } from "zod";

/**
 * Provider-side JSON-mode capability. The AI SDK's `generateObject`
 * works against every provider, but performance and reliability vary:
 *
 * - `native` — model has a first-class JSON / response-format mode that
 *   the SDK can wire up directly. Fast, no extra round-trips. Use this
 *   path whenever the schema is supported.
 * - `tool` — provider supports tool-calling but not response-format.
 *   The SDK simulates JSON mode by wrapping the call in a single
 *   tool call; same correctness, slightly slower.
 * - `unsupported` — neither path is reliable; callers must fall back
 *   to free-form generation + manual JSON parsing.
 *
 * We bias towards `native` and only mark a model `unsupported` when
 * we have evidence (a real production failure) that both modes drift.
 */
export type StructuredMode = "native" | "tool" | "unsupported";

/**
 * Static capability map keyed on model-id prefix. The keys are
 * prefixes so a single entry covers an entire family (e.g.
 * `anthropic/claude-` → all Claude variants). Most-specific prefix
 * wins on lookup so a per-model override can sit above its family.
 *
 * Sources for the initial classifications:
 * - Anthropic: response-format/tool-calling support for the 4.x line.
 * - OpenAI: native JSON mode via response-format on gpt-4.1+ / o-series.
 * - Google: native JSON mode on gemini-2.5; safer to drop to tool mode
 *   on smaller Flash variants where the schema-conformance regression
 *   bit us on a prior project.
 * - DeepSeek: tool-mode only — their response-format isn't reliable on
 *   nested schemas as of 2026-Q1.
 * - Workers AI: depends on the underlying provider — kimi via Moonshot
 *   supports JSON mode; the rest fall back to tool mode.
 */
const STRUCTURED_MODE_RULES: Array<{ prefix: string; mode: StructuredMode }> = [
  { prefix: "anthropic/claude-haiku-4", mode: "native" },
  { prefix: "anthropic/claude-sonnet-4", mode: "native" },
  { prefix: "anthropic/claude-opus-4", mode: "native" },
  { prefix: "anthropic/", mode: "tool" },
  { prefix: "openai/gpt-5", mode: "native" },
  { prefix: "openai/gpt-4.1", mode: "native" },
  { prefix: "openai/o3", mode: "native" },
  { prefix: "openai/o4", mode: "native" },
  { prefix: "openai/", mode: "tool" },
  { prefix: "google/gemini-2.5-pro", mode: "native" },
  { prefix: "google/gemini-2.5-flash", mode: "tool" },
  { prefix: "google/", mode: "tool" },
  { prefix: "deepseek/", mode: "tool" },
  { prefix: "@cf/moonshotai/kimi", mode: "native" },
  { prefix: "@cf/", mode: "tool" },
];

/**
 * Return the structured-output mode this model id should run in.
 * Falls back to `tool` for unknown models — `tool` mode is the most
 * compatible default the AI SDK supports across every provider.
 */
export function structuredModeFor(modelId: string): StructuredMode {
  // Sort by prefix length descending so the most-specific rule wins.
  // The static rule list is small (~16 entries) so the cost of sorting
  // on every call is negligible and the alternative — building a
  // lookup map at module load — adds load-order coupling.
  const sorted = [...STRUCTURED_MODE_RULES].sort(
    (a, b) => b.prefix.length - a.prefix.length,
  );
  for (const rule of sorted) {
    if (modelId.startsWith(rule.prefix)) return rule.mode;
  }
  return "tool";
}

/**
 * Caller-supplied options for a structured-output call. The schema is
 * mandatory; everything else has a sensible default.
 */
export interface GenerateStructuredOptions<T> {
  /** Resolved model id, e.g. `anthropic/claude-haiku-4-5`. */
  modelId: string;
  /** Language model handle from the AI SDK (provider's `chatModel(id)`). */
  model: LanguageModel;
  /** Validation + shape schema for the result. */
  schema: z.ZodType<T>;
  /** The prompt the model should answer. */
  prompt: string;
  /** Optional system prompt. */
  system?: string;
  /** Wall-clock cap. Defaults to 60s — structured calls should be fast. */
  timeoutMs?: number;
  /** Abort signal — wins over `timeoutMs` when both are set. */
  signal?: AbortSignal;
  /**
   * Maximum retries on schema-validation failure. The retry feeds the
   * validation error back into the prompt so the model can self-correct.
   * Default 1 (one initial attempt + one retry); set to 0 to fail fast.
   */
  maxRetries?: number;
}

/**
 * Outcome of a structured-output call.
 *
 * - `ok: true` — `data` validated cleanly against the schema.
 * - `ok: false` — every retry failed. `lastError` carries the final
 *   validation issue (or upstream provider error) and `rawText` carries
 *   whatever the model emitted on the last attempt so the caller can
 *   log / surface it.
 *
 * The caller decides how to handle the failure — there is no implicit
 * fallback to free-form generation. That keeps the type contract
 * honest: a `data: T` in the success branch is genuinely T.
 */
export type GenerateStructuredResult<T> =
  | {
      ok: true;
      data: T;
      mode: StructuredMode;
      attempts: number;
      tokenInput: number;
      tokenOutput: number;
    }
  | {
      ok: false;
      lastError: string;
      rawText: string;
      mode: StructuredMode;
      attempts: number;
      tokenInput: number;
      tokenOutput: number;
    };

/**
 * Run a structured-output generation against a schema.
 *
 * The function is small on purpose — it owns the retry loop and the
 * provider-mode selection, and delegates everything else to the AI SDK.
 *
 * Why not surface `generateObject`'s raw `mode` argument? Because the
 * mode is a function of the model id (which the caller already passes
 * in) and a fixed capability map. Letting callers override the mode
 * leaks provider knowledge into every call site for no real win — the
 * cases we'd want to flip mode for are the ones where the capability
 * map itself is wrong, and the right fix is to update the map.
 */
export async function generateStructured<T>(
  options: GenerateStructuredOptions<T>,
): Promise<GenerateStructuredResult<T>> {
  const mode = structuredModeFor(options.modelId);
  const maxRetries = options.maxRetries ?? 1;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const signal =
    options.signal ?? (timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined);

  let attempts = 0;
  let tokenInput = 0;
  let tokenOutput = 0;
  let lastError = "";
  let rawText = "";
  let prompt = options.prompt;

  while (attempts <= maxRetries) {
    attempts += 1;
    try {
      // AI SDK v6 dropped the explicit `mode` arg from generateObject —
      // the provider's structured-output path is selected automatically
      // from the model's reported capabilities. Our own `mode` value
      // stays useful as metadata on the result (it tells callers what
      // path was *expected*, useful when triaging cross-provider
      // regressions), and we use it to fail fast on `unsupported`
      // before paying the network round-trip.
      if (mode === "unsupported") {
        return {
          ok: false,
          lastError: `model ${options.modelId} has no reliable structured-output path`,
          rawText: "",
          mode,
          attempts,
          tokenInput,
          tokenOutput,
        };
      }
      const result = await generateObject({
        model: options.model,
        schema: options.schema,
        prompt,
        system: options.system,
        abortSignal: signal,
      });
      tokenInput += result.usage?.inputTokens ?? 0;
      tokenOutput += result.usage?.outputTokens ?? 0;
      // generateObject already runs the schema parser; reaching here
      // means validation passed. Surface the typed object directly.
      return {
        ok: true,
        data: result.object as T,
        mode,
        attempts,
        tokenInput,
        tokenOutput,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      lastError = message;
      rawText = extractRawText(error);
      if (attempts > maxRetries) break;
      // Append the validation error to the prompt so the model can
      // self-correct on the next attempt. Limit to ~1KB so a wall of
      // diagnostic text doesn't blow the prompt cache.
      prompt = [
        options.prompt,
        "",
        "Previous attempt failed to produce a valid response:",
        truncate(message, 800),
        "",
        "Try again, this time matching the requested schema exactly.",
      ].join("\n");
    }
  }

  return {
    ok: false,
    lastError,
    rawText,
    mode,
    attempts,
    tokenInput,
    tokenOutput,
  };
}

/**
 * Pull the raw model output out of an AI SDK error. The SDK throws a
 * `NoObjectGeneratedError` (or similar) on validation failure with a
 * `text` field containing what the model actually emitted; surfacing
 * that lets callers log the model's free-form output for debugging
 * without re-running the call.
 */
function extractRawText(error: unknown): string {
  if (error && typeof error === "object" && "text" in error) {
    const text = (error as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
