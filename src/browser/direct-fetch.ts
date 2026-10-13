/**
 * Fetch-first page reading for browser_markdown.
 *
 * Mirrors the Agents SDK `web_fetch` tool (agents >= 0.28) without the
 * agents/think/ai major upgrade Dodo would need to import it:
 *   1. Plain GET with `Accept: text/markdown` first — sites with Markdown
 *      for Agents return Markdown and skip conversion.
 *   2. HTML, PDF and Office bodies → Workers AI `toMarkdown`.
 *   3. JSON → pretty-printed.
 *   4. Bot challenges / 403 / 429 / thin JS-rendered shells → "blocked" or
 *      "thin", and the caller falls back to Browser Run.
 * Long pages come back in windows with `nextOffset`, and the converted
 * Markdown is cached per isolate so reading window 2..n doesn't refetch.
 *
 * When Dodo moves to agents >= 0.28, swap this for `agents/webfetch/ai-sdk`.
 */

export interface MarkdownConverter {
  toMarkdown(
    files: MarkdownDocument,
    options?: ConversionRequestOptions,
  ): Promise<ConversionResponse>;
}

export type DirectFetchResult =
  | { kind: "ok"; markdown: string; finalUrl: string; contentType: string }
  /** Bot challenge, 401/403/429 — a real browser may get through. */
  | { kind: "blocked"; reason: string }
  /** Converted fine but almost empty — likely a client-rendered SPA shell. */
  | { kind: "thin"; markdown: string; finalUrl: string; reason: string }
  /** Hard failure (404, unsupported type, too large, network). */
  | { kind: "error"; reason: string };

export interface DirectFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  /** Re-checks the post-redirect URL (e.g. private-host guard). */
  validateUrl?: (url: string) => string | null;
}

export const DIRECT_FETCH_TIMEOUT_MS = 15_000;
export const DIRECT_FETCH_MAX_BYTES = 5 * 1024 * 1024;
/** Below this many chars of converted HTML, assume a JS-rendered shell. */
export const THIN_MARKDOWN_CHARS = 200;

const ACCEPT_HEADER =
  "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, application/pdf;q=0.8, application/json;q=0.7, text/plain;q=0.6, */*;q=0.1";

const CONVERTIBLE_TYPES: Record<string, string> = {
  "text/html": "page.html",
  "application/xhtml+xml": "page.html",
  "application/pdf": "document.pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document.docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "document.xlsx",
  "application/vnd.ms-excel": "document.xls",
  "application/vnd.oasis.opendocument.text": "document.odt",
  "application/vnd.oasis.opendocument.spreadsheet": "document.ods",
  "text/csv": "document.csv",
  "application/xml": "document.xml",
  "text/xml": "document.xml",
};

function mimeOf(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

function isChallenge(response: Response): boolean {
  if (response.headers.get("cf-mitigated") === "challenge") return true;
  return response.status === 401 || response.status === 403 || response.status === 429;
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return new Uint8Array(new ArrayBuffer(0));
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.byteLength;
  }
  return out;
}

/** Plain-GET a URL and turn the body into Markdown. Never throws. */
export async function fetchMarkdownDirect(
  ai: MarkdownConverter,
  url: string,
  options: DirectFetchOptions = {},
): Promise<DirectFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? DIRECT_FETCH_MAX_BYTES;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: { Accept: ACCEPT_HEADER, "User-Agent": "Dodo/1.0 (read-only web fetch)" },
      signal: AbortSignal.timeout(options.timeoutMs ?? DIRECT_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: "error", reason: `fetch: ${error instanceof Error ? error.message : String(error)}` };
  }

  const finalUrl = response.url || url;
  const redirectError = finalUrl !== url ? options.validateUrl?.(finalUrl) : null;
  if (redirectError) {
    await response.body?.cancel().catch(() => {});
    return { kind: "error", reason: `redirected to a refused URL: ${redirectError}` };
  }

  if (isChallenge(response)) {
    await response.body?.cancel().catch(() => {});
    return { kind: "blocked", reason: `HTTP ${response.status}${response.headers.get("cf-mitigated") ? " (bot challenge)" : ""}` };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    // 5xx may be transient or bot-protection pages; let the browser try.
    return response.status >= 500
      ? { kind: "blocked", reason: `HTTP ${response.status}` }
      : { kind: "error", reason: `HTTP ${response.status}` };
  }

  const contentType = response.headers.get("content-type") ?? "";
  const mime = mimeOf(contentType);
  const body = await readCapped(response, maxBytes);
  if (body === null) {
    return { kind: "error", reason: `body larger than ${Math.round(maxBytes / 1024 / 1024)} MB` };
  }
  const text = () => new TextDecoder().decode(body);

  if (mime === "text/markdown" || mime === "text/x-markdown" || mime === "text/plain") {
    return { kind: "ok", markdown: text(), finalUrl, contentType: mime };
  }
  if (mime === "application/json" || mime.endsWith("+json")) {
    try {
      return {
        kind: "ok",
        markdown: `\`\`\`json\n${JSON.stringify(JSON.parse(text()), null, 2)}\n\`\`\``,
        finalUrl,
        contentType: mime,
      };
    } catch {
      return { kind: "ok", markdown: text(), finalUrl, contentType: mime };
    }
  }

  const name = CONVERTIBLE_TYPES[mime];
  if (!name) {
    return { kind: "error", reason: `unsupported content-type: ${mime || "(none)"}` };
  }
  let markdown: string;
  try {
    const conversion = await ai.toMarkdown({ name, blob: new Blob([body], { type: mime }) });
    if (conversion.format === "error") {
      return { kind: "error", reason: `toMarkdown: ${conversion.error}` };
    }
    markdown = conversion.data;
  } catch (error) {
    return { kind: "error", reason: `toMarkdown: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (name === "page.html" && markdown.trim().length < THIN_MARKDOWN_CHARS) {
    return {
      kind: "thin",
      markdown,
      finalUrl,
      reason: `HTML converted to only ${markdown.trim().length} chars (likely client-rendered)`,
    };
  }
  return { kind: "ok", markdown, finalUrl, contentType: mime };
}

export interface MarkdownWindow {
  content: string;
  offset: number;
  /** Pass back as `offset` for the next window; null at end of page. */
  nextOffset: number | null;
  totalChars: number;
}

export const WINDOW_CHARS = 20_000;

/**
 * Slice `markdown` from `offset`. Prefers to end on a paragraph or line
 * break in the last 10% of the window so the next window starts clean.
 */
export function windowMarkdown(
  markdown: string,
  offset = 0,
  maxChars = WINDOW_CHARS,
): MarkdownWindow {
  const totalChars = markdown.length;
  const start = Math.min(Math.max(0, Math.floor(offset)), totalChars);
  let end = Math.min(start + maxChars, totalChars);
  if (end < totalChars) {
    const floor = start + Math.floor(maxChars * 0.9);
    const para = markdown.lastIndexOf("\n\n", end);
    const line = markdown.lastIndexOf("\n", end);
    if (para > floor) end = para + 2;
    else if (line > floor) end = line + 1;
  }
  return {
    content: markdown.slice(start, end),
    offset: start,
    nextOffset: end < totalChars ? end : null,
    totalChars,
  };
}

/** Mark fetched text as data, not instructions. */
export function wrapUntrusted(content: string, url: string): string {
  const safe = content.replace(/<\/?untrusted_web_content[^>]*>/gi, "");
  return `<untrusted_web_content source="${url.replace(/"/g, "%22")}">\n${safe}\n</untrusted_web_content>`;
}

/**
 * Per-isolate cache so window 2..n of a page doesn't refetch (and doesn't
 * spend Browser Run time again). Small and short-lived on purpose.
 */
export class PageCache {
  private entries = new Map<string, { markdown: string; via: string; at: number }>();

  constructor(
    private readonly maxEntries = 16,
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(url: string): { markdown: string; via: string } | null {
    const hit = this.entries.get(url);
    if (!hit) return null;
    if (this.now() - hit.at > this.ttlMs) {
      this.entries.delete(url);
      return null;
    }
    return { markdown: hit.markdown, via: hit.via };
  }

  set(url: string, markdown: string, via: string): void {
    this.entries.delete(url);
    this.entries.set(url, { markdown, via, at: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
