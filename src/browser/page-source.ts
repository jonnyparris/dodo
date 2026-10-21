/**
 * The page source behind browser_markdown: the Agents SDK direct fetch
 * (`agents/webfetch`), with a per-isolate cache and a Browser Run fallback.
 *
 * The SDK does the fetching: `Accept: text/markdown` first (Markdown for
 * Agents), Workers AI `toMarkdown` for HTML and documents, pretty JSON,
 * redirects followed by hand with every hop checked against its private-host
 * policy, a streamed size cap. Dodo adds two things on top:
 *   1. Browser Run fallback when a plain fetch can't get the page: a bot
 *      challenge, 401/403/429/5xx, or HTML that converts to almost nothing
 *      (a client-rendered shell).
 *   2. A small cache, so reading window 2..n of a long page doesn't fetch it
 *      again (or spend Browser Run time again).
 */

import {
  createDirectWebFetch,
  WebFetchError,
  type WebFetchCallOptions,
  type WebFetchPage,
  type WebFetchRequest,
  type WebFetchSource,
} from "agents/webfetch";

/** A page plus Dodo's notes on how it was got. Extra fields survive the SDK's windowing. */
export type DodoWebFetchPage = WebFetchPage & {
  /** How the page was got when it wasn't a plain fetch, or why it may be incomplete. */
  notes?: string[];
};

/** Fetches a URL in a real browser and returns Markdown, or null with reasons pushed to `errors`. */
export type BrowserMarkdownFetcher = (
  url: string,
  errors: string[],
) => Promise<{ markdown: string; via: string } | null>;

export interface DodoPageSourceOptions {
  /** Workers AI binding, for `toMarkdown`. */
  ai: Ai;
  /** Browser Run fallback. Without it, reads are fetch-only. */
  browser?: BrowserMarkdownFetcher;
  /** Test seam; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Deadline for the plain fetch, before any browser fallback. */
  directTimeoutMs?: number;
  /** Defaults to a shared per-isolate cache. */
  cache?: PageCache;
}

export const DIRECT_FETCH_TIMEOUT_MS = 15_000;
/** Below this many chars of converted HTML, assume a JS-rendered shell. */
export const THIN_MARKDOWN_CHARS = 200;
const USER_AGENT = "Dodo/1.0 (read-only web fetch; +https://github.com/jonnyparris/dodo)";

/** Statuses a real browser may get past: auth walls, bot blocks, rate limits, flaky origins. */
function browserMayHelp(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

/** Body text without the YAML frontmatter (title, description, og tags) toMarkdown puts on top. */
function bodyText(markdown: string): string {
  return markdown.replace(/^\s*---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, "").trim();
}

function isThinHtml(page: WebFetchPage): boolean {
  return (
    page.via === "converted" &&
    (page.contentType === "text/html" || page.contentType === "application/xhtml+xml") &&
    bodyText(page.content).length < THIN_MARKDOWN_CHARS
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build the source: cache → SDK direct fetch → Browser Run. A thin or
 * blocked direct result is kept as a last resort if the browser also fails.
 */
export function createDodoPageSource(options: DodoPageSourceOptions): WebFetchSource {
  const direct = createDirectWebFetch({
    binding: options.ai,
    fetch: options.fetch,
    userAgent: USER_AGENT,
  });
  const cache = options.cache ?? sharedPageCache;
  const directTimeoutMs = options.directTimeoutMs ?? DIRECT_FETCH_TIMEOUT_MS;

  return {
    async fetch(request: WebFetchRequest, call: WebFetchCallOptions = {}): Promise<DodoWebFetchPage> {
      const format = request.format ?? "auto";
      const key = `${format} ${typeof request.url === "string" ? request.url.trim() : ""}`;
      const cached = cache.get(key);
      if (cached) return cached;

      const deadline = AbortSignal.timeout(directTimeoutMs);
      const signal = call.signal ? AbortSignal.any([call.signal, deadline]) : deadline;
      let page: WebFetchPage | null = null;
      let reason: string;
      try {
        page = await direct.fetch(request, { signal });
        if (browserMayHelp(page.status)) reason = `plain fetch got HTTP ${page.status}`;
        else if (isThinHtml(page)) {
          reason = `HTML converted to only ${bodyText(page.content).length} chars of body text (likely client-rendered)`;
        } else {
          cache.set(key, page);
          return page;
        }
      } catch (error) {
        if (call.signal?.aborted) throw call.signal.reason;
        if (deadline.aborted) {
          throw new WebFetchError(`Fetching ${request.url} timed out after ${directTimeoutMs} ms.`, {
            status: 504,
            code: "web_fetch_timeout",
            url: request.url,
            timeoutMs: directTimeoutMs,
            cause: error,
          });
        }
        const fallback =
          error instanceof WebFetchError &&
          (error.code === "web_fetch_blocked" ||
            (error.code === "web_fetch_http_error" && browserMayHelp(error.status)));
        // Bad input, disallowed hosts, 404s, oversize and binary bodies won't improve in a browser.
        if (!fallback) throw error;
        reason = `plain fetch failed: ${describe(error)}`;
      }

      const errors: string[] = [];
      if (options.browser && format === "auto") {
        const rendered = await options.browser(page?.finalUrl ?? request.url.trim(), errors);
        if (rendered) {
          const url = request.url.trim();
          const result: DodoWebFetchPage = {
            url,
            finalUrl: page?.finalUrl ?? url,
            status: 200,
            contentType: "text/html",
            via: "rendered",
            content: rendered.markdown,
            totalChars: rendered.markdown.length,
            headers: {},
            bytes: new TextEncoder().encode(rendered.markdown).byteLength,
            redirects: page?.redirects ?? [],
            // Keep earlier fallback errors (e.g. a failed /markdown quick action
            // before CDP succeeded) so the slower path is explainable.
            notes: [`Rendered with Browser Run (${rendered.via}) because the ${reason}.`, ...errors],
          };
          cache.set(key, result);
          return result;
        }
      } else {
        errors.push(options.browser ? `browser: not used for format "${format}"` : "browser: no Browser Run binding available");
      }

      if (page) {
        return {
          ...page,
          notes: [`The ${reason} and the browser fallback failed; content may be incomplete.`, ...errors],
        };
      }
      throw new WebFetchError(`All fetch paths failed for ${request.url}: ${reason}; ${errors.join("; ")}`, {
        status: 502,
        code: "web_fetch_blocked",
        url: request.url,
      });
    },
  };
}

/**
 * Per-isolate cache so window 2..n of a page doesn't refetch. Small and
 * short-lived on purpose. Only pages that read cleanly are kept.
 */
export class PageCache {
  private entries = new Map<string, { page: DodoWebFetchPage; at: number }>();

  constructor(
    private readonly maxEntries = 16,
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): DodoWebFetchPage | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (this.now() - hit.at > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return hit.page;
  }

  set(key: string, page: DodoWebFetchPage): void {
    this.entries.delete(key);
    this.entries.set(key, { page, at: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

const sharedPageCache = new PageCache();
