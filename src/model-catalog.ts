import { CLOUDFLARE_WORKERS_AI_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai.models";

/** Canonical /generate slash command regex. Shared by the server entry points
 *  (handleMessage/handlePrompt) and the browser client so all paths agree on
 *  what qualifies as an image-generation request. `[\s\S]+` (not `.+`) preserves
 *  multi-line prompts — dot-any-char would clip at the first newline. */
export const GENERATE_SLASH_REGEX = /^\/generate\s+([\s\S]+)$/i;

/** Extract the image prompt from a message if it's a /generate slash command.
 *  Returns null for normal messages. The returned prompt is trimmed; callers
 *  should reject empty strings (whitespace-only user input). */
export function extractGeneratePrompt(content: string): string | null {
  const match = content.match(GENERATE_SLASH_REGEX);
  if (!match) return null;
  const prompt = match[1].trim();
  return prompt.length > 0 ? prompt : null;
}

/** costInput/costOutput are USD per million tokens, base tier only. They must
 *  match pi-ai's bundled vendor catalogs: test/model-catalog-prices-unit.test.ts
 *  fails on drift (2026-10: Haiku, Opus, GPT-5.4 and Gemini Flash had drifted).
 *  Per-turn cost in the agent loop takes cache prices and long-context tiers
 *  (GPT-5.4 >272k, Gemini 2.5 Pro >200k) from pi-ai directly: src/pi/models.ts
 *  modelCost(). contextWindow drives compaction and the token budget; the same
 *  test checks it against pi-ai, except GPT-5.4 (pi-ai lists the 272k pricing
 *  threshold; the API window is 1.05M). DeepSeek prices are the peak rate
 *  (off-peak is half). deepseek-chat/-reasoner were retired 2026-07-24. */
export const FALLBACK_MODELS = [
  { id: "openai/gpt-5.4", name: "GPT-5.4", provider: "OpenAI", costInput: 2.5, costOutput: 15, contextWindow: 1_000_000 },
  { id: "openai/gpt-4.1", name: "GPT-4.1", provider: "OpenAI", costInput: 2, costOutput: 8, contextWindow: 1_047_576 },
  { id: "openai/gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "OpenAI", costInput: 0.4, costOutput: 1.6, contextWindow: 1_047_576 },
  { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "Anthropic", costInput: 3, costOutput: 15, contextWindow: 1_000_000 },
  { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6", provider: "Anthropic", costInput: 5, costOutput: 25, contextWindow: 1_000_000 },
  { id: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "Anthropic", costInput: 1, costOutput: 5, contextWindow: 200_000 },
  { id: "openai/o3-mini", name: "o3-mini", provider: "OpenAI", costInput: 1.1, costOutput: 4.4, contextWindow: 200_000 },
  { id: "openai/o4-mini", name: "o4-mini", provider: "OpenAI", costInput: 1.1, costOutput: 4.4, contextWindow: 200_000 },
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "Google", costInput: 1.25, costOutput: 10, contextWindow: 1_048_576 },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "Google", costInput: 0.3, costOutput: 2.5, contextWindow: 1_048_576 },
  { id: "deepseek/deepseek-flash", name: "DeepSeek V4.1 Flash", provider: "DeepSeek", costInput: 0.3, costOutput: 1.2, contextWindow: 1_000_000 },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", provider: "DeepSeek", costInput: 1.32, costOutput: 3.96, contextWindow: 1_000_000 },
];

/** Workers AI chat/text models — advertised in the model picker so users can
 *  set them as their session default. Routed via AI Gateway's OpenAI-compatible
 *  endpoint. These only work when `activeGateway === "ai-gateway"`. */
export const WORKERS_AI_MODELS = [
  { id: "@cf/zai-org/glm-5.3-flash", name: "GLM-5.3 Flash (Workers AI)", provider: "Workers AI", costInput: 0.15, costOutput: 0.5, contextWindow: 1_048_576 },
  { id: "@cf/moonshotai/kimi-k2.6", name: "Kimi K2.6 (Workers AI)", provider: "Workers AI", costInput: null, costOutput: null, contextWindow: 262_144 },
  { id: "@cf/google/gemma-4-26b-a4b-it", name: "Gemma 4 26B A4B (Workers AI)", provider: "Workers AI", costInput: null, costOutput: null, contextWindow: 256_000 },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout 17B (Workers AI)", provider: "Workers AI", costInput: null, costOutput: null, contextWindow: 131_072 },
  { id: "@cf/qwen/qwen2.5-coder-32b-instruct", name: "Qwen 2.5 Coder 32B (Workers AI)", provider: "Workers AI", costInput: null, costOutput: null, contextWindow: 32_768 },
];

/** Context window for ids neither list has: 128k is a guess that suits most
 *  vendor chat models. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

const CATALOG_CONTEXT_WINDOWS = new Map<string, number>([...FALLBACK_MODELS, ...WORKERS_AI_MODELS].map((m) => [m.id, m.contextWindow]));

/** Context window (tokens) for a Dodo model id: Dodo's catalog, then pi-ai's
 *  Workers AI catalog for `@cf/` ids Dodo doesn't advertise, then the default.
 *  Without the pi-ai step a session set to e.g. `@cf/qwen/qwen3-30b-a3b-fp8`
 *  (32,768 window) got 128k, so pi-ai sent `max_tokens` 32000 on top of the
 *  prompt and Workers AI rejected the first turn with a 400 (2026-10-22). */
export function contextWindowFor(modelId: string): number {
  return CATALOG_CONTEXT_WINDOWS.get(modelId) ?? CLOUDFLARE_WORKERS_AI_MODELS[modelId as keyof typeof CLOUDFLARE_WORKERS_AI_MODELS]?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

/** Workers AI image-generation models. Not surfaced in the chat model picker —
 *  they're invoked via dedicated endpoints (e.g. POST /session/:id/generate).
 *  Kept here so the catalog is documented in one place. */
export const WORKERS_AI_IMAGE_MODELS = [
  { id: "@cf/black-forest-labs/flux-1-schnell", name: "FLUX.1 Schnell", provider: "Workers AI", kind: "text-to-image" },
];

/** Default model for /generate. Central constant so tests and handlers stay in sync. */
export const FLUX_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
export const FLUX_IMAGE_MEDIA_TYPE = "image/jpeg";
/** FLUX-1-schnell API limit per the model schema (developers.cloudflare.com/workers-ai/models/flux-1-schnell). */
export const FLUX_MAX_PROMPT_LENGTH = 2048;

/** Default Replicate image model — Google's nano-banana-2 (Gemini 3.1 Flash
 *  Image): fast text-to-image plus conversational editing / multi-image
 *  fusion. Overridable per-user via `replicateImageModel` config. */
export const DEFAULT_REPLICATE_IMAGE_MODEL = "google/nano-banana-2";
/** Prompt ceiling for the Replicate image path. Generous vs FLUX — nano-banana
 *  handles long instruction prompts — but bounded to avoid abuse. */
export const REPLICATE_MAX_PROMPT_LENGTH = 5000;
/** Max input images accepted per edit request. nano-banana-2 supports up to 14
 *  reference images. */
export const REPLICATE_MAX_EDIT_IMAGES = 14;

/** Model ID prefixes that support image/vision input. Used to decide whether
 *  to pass image `file` parts to the model or replace them with a text note.
 *  When in doubt, return false — a text note is always safe; an image part
 *  sent to a non-vision model causes the model to hallucinate or reject the
 *  request. */
const VISION_CAPABLE_MODEL_PATTERNS = [
  /^openai\//,
  /^anthropic\//,
  /^google\//,
  /^@cf\/meta\/llama-4-/,
  // Workers AI models whose catalog entry has `vision: true` (checked 2026-10-17).
  /^@cf\/zai-org\/glm-5\.3-flash$/,
  /^@cf\/moonshotai\/kimi-k2\.6$/,
  /^@cf\/google\/gemma-4-/,
];

export function modelSupportsVision(modelId: string): boolean {
  return VISION_CAPABLE_MODEL_PATTERNS.some((p) => p.test(modelId));
}
