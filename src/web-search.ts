import { tool } from "ai";
import { z } from "zod";

/**
 * Built-in `web_search` tool over the Cloudflare Web Search API, called
 * through AI Gateway via the existing Workers AI binding
 * (`env.AI.websearch()`, GA'd in the Agents SDK on 2026-10-12).
 *
 * Hand-rolled rather than imported from `agents/websearch/ai-sdk` because
 * that adapter needs agents >= 0.27 and Dodo is on ^0.8.x. The output shape
 * mirrors the SDK's `renderWebSearchResults()`: a numbered list of title,
 * URL and a description trimmed at a word boundary, so a five-result search
 * costs a few KB of context instead of the ~8 KB/result Ceramic returns.
 *
 * Billing: every call bills the gateway's account (AIG credits or BYOK).
 * That's why buildTools() only registers this for admin-owned sessions and
 * only when WEB_SEARCH_GATEWAY_ID is set — the var is the kill switch.
 */

export const WEB_SEARCH_PROVIDERS = ["ceramic", "exa", "linkup"] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

export const WEB_SEARCH_MAX_RESULTS = 10;
export const WEB_SEARCH_DEFAULT_RESULTS = 5;
export const WEB_SEARCH_DESCRIPTION_CHARS = 600;

export interface WebSearchItem {
  url?: string;
  title?: string;
  description?: string;
  lastModified?: string;
  [key: string]: unknown;
}

export interface WebSearchResponse {
  items?: WebSearchItem[];
  metadata?: { query?: string; requestId?: string; latencyMs?: number };
}

/** Narrow view of the AI binding — pinned workers-types predate websearch(). */
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

/** Collapse whitespace and trim to `max` chars at a word boundary. */
export function trimDescription(text: string, max = WEB_SEARCH_DESCRIPTION_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Render results the way the Agents SDK adapters show them to the model. */
export function renderWebSearchResults(query: string, response: WebSearchResponse): string {
  const items = (response.items ?? []).filter(
    (item): item is WebSearchItem & { url: string } =>
      typeof item.url === "string" && item.url.length > 0,
  );
  if (items.length === 0) {
    return `No results for "${query}". Try a broader or rephrased query.`;
  }
  const lines = [`${items.length} result${items.length === 1 ? "" : "s"} for "${query}":`, ""];
  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.title?.trim() || item.url}`);
    lines.push(item.url);
    if (typeof item.lastModified === "string" && item.lastModified) {
      lines.push(`Last modified: ${item.lastModified}`);
    }
    if (typeof item.description === "string" && item.description.trim()) {
      lines.push(trimDescription(item.description));
    }
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

export const WEB_SEARCH_DESCRIPTION = [
  "Search the public web for pages on a topic when you don't have a URL — current events, recent releases, docs newer than your training data.",
  "Returns a numbered list of titles, URLs and short descriptions (not full page content).",
  "To read a result, fetch its URL with `browser_markdown` if available, otherwise `fetch` in codemode.",
  "No pagination: if you need more or different results, search again with a rephrased query.",
  "Each call is billed — prefer connected MCP tools (Cloudflare API, memory, GitHub) when they can answer.",
].join(" ");

export interface WebSearchToolOptions {
  ai: WebSearchAi;
  gatewayId: string;
  provider?: WebSearchProvider;
  maxResults?: number;
}

export function createWebSearchTool(options: WebSearchToolOptions) {
  const maxResults = Math.min(options.maxResults ?? WEB_SEARCH_DEFAULT_RESULTS, WEB_SEARCH_MAX_RESULTS);
  const provider = options.provider ?? "ceramic";
  return tool({
    description: WEB_SEARCH_DESCRIPTION,
    inputSchema: z.object({
      query: z.string().min(1).max(1024).describe("The search query"),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`How many results to return (1-${maxResults}, default ${Math.min(WEB_SEARCH_DEFAULT_RESULTS, maxResults)})`),
    }),
    execute: async ({ query, limit }: { query: string; limit?: number }) => {
      const effectiveLimit = Math.max(1, Math.min(limit ?? WEB_SEARCH_DEFAULT_RESULTS, maxResults));
      let response: Response;
      try {
        response = await options.ai.websearch({
          gatewayId: options.gatewayId,
          query,
          provider,
          limit: effectiveLimit,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          error: `web_search failed: ${message}. Retry once with the same query; if it fails again, continue without web search.`,
        };
      }
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const hint =
          response.status === 400
            ? "Fix the query (1-1024 chars) and retry."
            : response.status === 402 || response.status === 429
              ? "Search is unavailable (billing or rate limit). Continue without web search."
              : "Retry once; if it fails again, continue without web search.";
        return { error: `web_search failed (${response.status}): ${body.slice(0, 300)}. ${hint}` };
      }
      const data = (await response.json()) as WebSearchResponse;
      return {
        results: renderWebSearchResults(query, data),
        provider,
        requestId: data.metadata?.requestId,
        latencyMs: data.metadata?.latencyMs,
      };
    },
  });
}
