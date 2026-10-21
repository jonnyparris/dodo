import { tool } from "ai";
import {
  WebSearchError,
  webSearchTool,
  type WebSearchProvider,
  type WebSearchToolInput,
  type WebSearchToolOutput,
} from "agents/websearch/ai-sdk";

/**
 * Built-in `web_search` tool: the Agents SDK tool (agents/websearch/ai-sdk)
 * over the Cloudflare Web Search API, called through AI Gateway via the
 * Workers AI binding (`env.AI.websearch()`).
 *
 * The SDK owns the request, response parsing, error codes, timeout and the
 * model's rendering (numbered title/URL/description, descriptions trimmed to
 * 600 chars, so a five-result search costs a few KB of context instead of
 * the ~8 KB/result Ceramic returns). Dodo adds only:
 *   - its own description (points at browser_markdown, warns about billing);
 *   - failures returned as `error-text` tool results instead of thrown, the
 *     same contract as browser_markdown, with the API detail logged.
 *
 * Billing: every call bills the gateway's account (AIG credits or BYOK).
 * That's why buildTools() only registers this for admin-owned sessions and
 * only when WEB_SEARCH_GATEWAY_ID is set — the var is the kill switch.
 */

export type { WebSearchProvider };

export const WEB_SEARCH_PROVIDERS = ["ceramic", "exa", "linkup"] as const satisfies readonly WebSearchProvider[];

/** Results per search: the default and the cap (the model may ask for fewer). */
export const WEB_SEARCH_LIMIT = 5;

/** The env.AI binding's websearch() — the SDK calls it; we only feature-detect. */
export interface WebSearchAi {
  websearch(input: {
    gatewayId: string;
    query: string;
    provider?: string;
    limit?: number;
    byokAlias?: string;
  }): Promise<Response>;
}

export function hasWebSearch(ai: unknown): ai is WebSearchAi {
  return (
    typeof ai === "object" &&
    ai !== null &&
    typeof (ai as { websearch?: unknown }).websearch === "function"
  );
}

export function parseWebSearchProvider(value: string | undefined): WebSearchProvider {
  return (WEB_SEARCH_PROVIDERS as readonly string[]).includes(value ?? "")
    ? (value as WebSearchProvider)
    : "ceramic";
}

export const WEB_SEARCH_DESCRIPTION = [
  "Search the public web for pages on a topic when you don't have a URL — current events, recent releases, docs newer than your training data.",
  "Returns a numbered list of titles, URLs and short descriptions (not full page content).",
  "To read a result, fetch its URL with `browser_markdown` if available, otherwise `fetch` in codemode.",
  "No pagination: if you need more or different results, search again with a rephrased query.",
  "Each call is billed — prefer connected MCP tools (Cloudflare API, memory, GitHub) when they can answer.",
].join(" ");

/** What web_search stores: the SDK's full response, or the model-facing failure. */
export type DodoWebSearchOutput = WebSearchToolOutput | { error: string; code: string };

export interface WebSearchToolOptions {
  ai: WebSearchAi;
  gatewayId: string;
  provider?: WebSearchProvider;
  limit?: number;
}

export function createWebSearchTool(options: WebSearchToolOptions) {
  const search = webSearchTool({
    // The pinned workers-types may lag the binding; hasWebSearch() checked it.
    binding: options.ai as unknown as Ai,
    gateway: options.gatewayId,
    provider: options.provider ?? "ceramic",
    limit: options.limit ?? WEB_SEARCH_LIMIT,
    description: WEB_SEARCH_DESCRIPTION,
  });
  return tool({
    description: search.description,
    inputSchema: search.inputSchema,
    execute: async (
      input: WebSearchToolInput,
      callOptions?: { abortSignal?: AbortSignal },
    ): Promise<DodoWebSearchOutput> => {
      try {
        return await search.execute(input, { abortSignal: callOptions?.abortSignal });
      } catch (error) {
        // The SDK's message is written for the model (retry once, fix the
        // query, or carry on without search); the API detail is the cause.
        if (error instanceof WebSearchError) {
          console.error("web_search failed", error.code, error.requestId, error.cause);
          return { error: error.message, code: error.code };
        }
        throw error;
      }
    },
    toModelOutput: ({ output }: { output: DodoWebSearchOutput }) =>
      "error" in output
        ? { type: "error-text" as const, value: output.error }
        : search.toModelOutput({ output }),
  });
}
