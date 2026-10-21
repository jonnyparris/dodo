/**
 * Token counts from AI Gateway log entries, made comparable across providers.
 *
 * AI Gateway copies the provider's own input count into `tokens_in`, and the
 * providers disagree on what that number means:
 *
 * - OpenAI-style APIs (Workers AI, OpenAI): input counts the whole prompt.
 *   `input_cached_tokens` is the cached part of it. Anthropic via /compat
 *   chat/completions is treated the same way. AI Gateway's /compat endpoint
 *   strips `cache_control` markers (see src/pi/models.ts), so those logs
 *   carry no cache fields today.
 * - Anthropic Messages API (native /anthropic, `v1/messages`): input counts
 *   only the uncached tail after the last cache breakpoint. Cache reads and
 *   cache writes come as separate fields. A cached 24k prompt logs
 *   `tokens_in: 3`.
 *
 * So for Anthropic Messages we add the cache fields back to get the full
 * prompt size. Adding them for OpenAI-style logs would count the cached part
 * twice.
 */

export interface GatewayUsageLog {
  provider?: string;
  path?: string;
  tokens_in: number | null;
  usage_metadata?: {
    input_tokens?: number;
    input_cached_tokens?: number;
    input_cache_creation_tokens?: number;
  } | null;
}

/** True when the log uses Anthropic's "uncached input only" convention. */
export function isAnthropicMessages(l: GatewayUsageLog): boolean {
  return l.provider === "anthropic" && /(^|\/)v1\/messages(\?|$)/.test(l.path ?? "");
}

/**
 * Full prompt size, the part read from the provider's cache, and (Anthropic
 * only) the part written to it. Cache reads and writes price differently
 * from plain input, so they are kept apart.
 */
export function inputTokens(l: GatewayUsageLog): { total: number; cached: number; cacheWrite: number } {
  const base = l.tokens_in ?? l.usage_metadata?.input_tokens ?? 0;
  const cached = l.usage_metadata?.input_cached_tokens ?? 0;
  if (!isAnthropicMessages(l)) return { total: base, cached, cacheWrite: 0 };
  const cacheWrite = l.usage_metadata?.input_cache_creation_tokens ?? 0;
  return { total: base + cached + cacheWrite, cached, cacheWrite };
}
