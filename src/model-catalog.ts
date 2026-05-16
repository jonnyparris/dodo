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

export const FALLBACK_MODELS = [
  { id: "openai/gpt-5.4", name: "GPT-5.4", provider: "OpenAI", costInput: 2, costOutput: 8, contextWindow: 1_000_000 },
  { id: "openai/gpt-4.1", name: "GPT-4.1", provider: "OpenAI", costInput: 2, costOutput: 8, contextWindow: 1_000_000 },
  { id: "openai/gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "OpenAI", costInput: 0.4, costOutput: 1.6, contextWindow: 1_000_000 },
  { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "Anthropic", costInput: 3, costOutput: 15, contextWindow: 200_000 },
  { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6", provider: "Anthropic", costInput: 15, costOutput: 75, contextWindow: 200_000 },
  { id: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "Anthropic", costInput: 0.8, costOutput: 4, contextWindow: 200_000 },
  { id: "openai/o3-mini", name: "o3-mini", provider: "OpenAI", costInput: 1.1, costOutput: 4.4, contextWindow: 200_000 },
  { id: "openai/o4-mini", name: "o4-mini", provider: "OpenAI", costInput: 1.1, costOutput: 4.4, contextWindow: 200_000 },
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "Google", costInput: 1.25, costOutput: 10, contextWindow: 1_000_000 },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "Google", costInput: 0.15, costOutput: 0.6, contextWindow: 1_000_000 },
  { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", provider: "DeepSeek", costInput: 0.27, costOutput: 1.1, contextWindow: 128_000 },
  { id: "deepseek/deepseek-reasoner", name: "DeepSeek Reasoner", provider: "DeepSeek", costInput: 0.55, costOutput: 2.19, contextWindow: 128_000 },
];

/** Workers AI chat/text models — advertised in the model picker so users can
 *  set them as their session default. Routed via AI Gateway's OpenAI-compatible
 *  endpoint. These only work when `activeGateway === "ai-gateway"`. */
export const WORKERS_AI_MODELS = [
  { id: "@cf/moonshotai/kimi-k2.6", name: "Kimi K2.6 (Workers AI)", provider: "Workers AI", costInput: null, costOutput: null, contextWindow: 262_144 },
  { id: "@cf/google/gemma-4-26b-a4b-it", name: "Gemma 4 26B A4B (Workers AI)", provider: "Workers AI", costInput: null, costOutput: null, contextWindow: 256_000 },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout 17B (Workers AI)", provider: "Workers AI", costInput: null, costOutput: null, contextWindow: 131_072 },
  { id: "@cf/qwen/qwen2.5-coder-32b-instruct", name: "Qwen 2.5 Coder 32B (Workers AI)", provider: "Workers AI", costInput: null, costOutput: null, contextWindow: 32_768 },
];

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
