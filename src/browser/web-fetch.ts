import { tool } from "ai";
import { z } from "zod";
import { connectBrowser } from "./cdp-session";

/**
 * Read-only web tools backed by Browser Run quick actions + Jev evaluation.
 *
 * Two tools:
 *   browser_markdown — fetch a page as markdown (cheap, ~2s, no browser
 *     session), optionally verified against a query with a calibrated Jev
 *     `noul` verdict so the agent can decide whether to keep browsing.
 *   browser_triage — rank candidate URLs by how likely each answers a
 *     question BEFORE spending any fetch. Pure Jev evaluation on metadata.
 *
 * Both complement (not replace) browser_execute: interactive pages
 * (login, clicks, screenshots, DOM inspection) still need full CDP.
 */

interface JevNoulAnswer {
  type: "noul";
  noul: number;
}

interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

function isJevNoul(value: unknown): value is JevNoulAnswer {
  return (
    typeof value === "object" &&
    value !== null &&
    "noul" in value &&
    typeof value.noul === "number"
  );
}

function isJevChoice(value: unknown): value is JevChoiceAnswer {
  return (
    typeof value === "object" &&
    value !== null &&
    "choice" in value &&
    typeof value.choice === "string" &&
    "probabilities" in value &&
    typeof value.probabilities === "object" &&
    value.probabilities !== null
  );
}

function jevAnswers(response: Record<string, unknown>): Record<string, unknown> {
  const answers = response.answers;
  return typeof answers === "object" && answers !== null
    ? (answers as Record<string, unknown>)
    : {};
}

/** Extract the `noul` probability from a Jev response, or null on mismatch. */
export function extractJevNoul(
  response: Record<string, unknown>,
  key: string,
): number | null {
  const answer = jevAnswers(response)[key];
  return isJevNoul(answer) ? answer.noul : null;
}

/** Extract the choice probabilities from a Jev response, or null on mismatch. */
export function extractJevChoice(
  response: Record<string, unknown>,
  key: string,
): JevChoiceAnswer | null {
  const answer = jevAnswers(response)[key];
  return isJevChoice(answer) ? answer : null;
}

/**
 * Browser Run quick-action binding. @cloudflare/workers-types doesn't ship
 * a type for the `browser` binding yet, so we declare the one shape we use
 * and verify it exists at runtime before calling.
 */
interface BrowserQuickActionBinding {
  quickAction(
    action: "markdown",
    params: { url: string },
  ): Promise<Response>;
}

function quickActionBinding(browser: Fetcher): BrowserQuickActionBinding | null {
  const candidate = browser as Partial<BrowserQuickActionBinding>;
  return typeof candidate.quickAction === "function"
    ? { quickAction: candidate.quickAction.bind(browser) }
    : null;
}

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /\.local$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

/** Validate a fetch target: http(s) only, no private hosts. */
export function validateTargetUrl(raw: string): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `Invalid URL: ${raw}` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { error: `Only http/https URLs are supported, got: ${url.protocol}` };
  }
  if (PRIVATE_HOST_PATTERNS.some((p) => p.test(url.hostname))) {
    return { error: `Refusing to fetch private host: ${url.hostname}` };
  }
  return { url };
}

/** Cap page markdown for tool output; explains how to get the rest. */
export function capMarkdown(markdown: string, maxChars: number): string {
  if (markdown.length <= maxChars) {
    return markdown;
  }
  return `${markdown.slice(0, maxChars)}\n\n--- TRUNCATED ---\nPage was ${markdown.length.toLocaleString()} chars, showing the first ${maxChars.toLocaleString()}. Pass a more specific query, or use browser_execute with Runtime.evaluate to extract a specific section.`;
}

const MARKDOWN_STATE_CHAR_LIMIT = 18000;

/** Ask Jev whether the page content answers the query. */
async function verifyPageAnswers(
  ai: JevAi,
  markdown: string,
  query: string,
): Promise<{ hasAnswer: number | null; note?: string }> {
  try {
    const response = await ai.run("typesafe/jev", {
      state: { query, page: markdown.slice(0, MARKDOWN_STATE_CHAR_LIMIT) },
      questions: {
        has_answer: {
          type: "noul",
          instructions: "Does `page` contain information that answers `query`?",
          criteria: {
            true: "The page contains facts, data, or an explanation that directly addresses the query",
            false: "The page does not address the query — different topic, error page, paywall, or placeholder content",
          },
        },
      },
    });
    const noul = extractJevNoul(response, "has_answer");
    return noul === null
      ? { hasAnswer: null, note: "Jev returned an unexpected shape" }
      : { hasAnswer: noul };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Jev page verification failed:", message);
    return {
      hasAnswer: null,
      note: `Jev verification unavailable: ${message}`,
    };
  }
}

export interface TriageCandidate {
  url: string;
  title?: string;
  snippet?: string;
}

export interface TriageResult {
  ranking: Array<{ url: string; probability: number }>;
  picked: string;
}

/**
 * Rank candidate URLs by likely relevance to the query. Judges metadata
 * only (url, title, snippet) — no fetching. Returns ranking sorted
 * best-first, or null when Jev fails (caller falls back to its own order).
 */
export async function triageUrls(
  ai: JevAi,
  query: string,
  candidates: TriageCandidate[],
): Promise<TriageResult | null> {
  const criteria: Record<string, string> = {};
  candidates.forEach((c, i) => {
    criteria[String(i)] = `${c.url}${c.title ? ` — ${c.title}` : ""}`;
  });

  try {
    const response = await ai.run("typesafe/jev", {
      state: { query, candidates },
      questions: {
        best_source: {
          type: "choice",
          instructions:
            "Which candidate URL is most likely to contain a direct, authoritative answer to the query? Judge only by the URL, title, and snippet metadata in `state.candidates` — you cannot see the page contents.",
          criteria,
        },
      },
    });

    const choice = extractJevChoice(response, "best_source");
    if (!choice) {
      console.error("Jev triage returned an unexpected shape for best_source");
      return null;
    }

    const ranking = candidates
      .map((c, i) => ({
        url: c.url,
        probability: choice.probabilities[String(i)] ?? 0,
      }))
      .sort((a, b) => b.probability - a.probability);

    return { ranking, picked: ranking[0]?.url ?? candidates[0]?.url };
  } catch (error) {
    console.error(
      "Jev triage failed:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms),
    ),
  ]);
}

const CDP_SETTLE_MS = 3000;

/**
 * Fallback markdown fetch via the CDP binding path: launch a browser,
 * navigate, grab the rendered HTML, convert with AI.toMarkdown(). Works on
 * any compatibility date — used when the quickAction() binding method is
 * unavailable (it needs compatibility date >= 2026-03-24).
 */
async function fetchMarkdownViaCdp(
  browser: Fetcher,
  ai: JevAi,
  url: string,
): Promise<string> {
  const session = await withTimeout(connectBrowser(browser), 15_000, "Browser launch");
  try {
    await session.send("Page.enable");
    await session.send("Page.navigate", { url });
    await new Promise((r) => setTimeout(r, CDP_SETTLE_MS));
    const evalResult = (await session.send("Runtime.evaluate", {
      expression: "document.documentElement.outerHTML",
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    const html = evalResult.result?.value;
    if (typeof html !== "string" || !html.trim()) {
      throw new Error("page rendered no HTML (client-rendered SPA or load failure)");
    }
    const conversion = await ai.toMarkdown({
      name: "page.html",
      blob: new Blob([html], { type: "text/html" }),
    });
    if (conversion.format === "error") {
      throw new Error(`AI.toMarkdown failed: ${conversion.error}`);
    }
    return conversion.data;
  } finally {
    await session.close().catch(() => {});
  }
}

export interface WebFetchToolsOptions {
  browser: Fetcher;
  ai: JevAi;
}

/**
 * Minimal AI surface for Jev calls. Dodo's pinned workers-types only types
 * catalog models via `run<Name extends keyof AiModels>`; third-party models
 * like typesafe/jev aren't keys, so callers pass env.AI through JevAi (the
 * runtime accepts arbitrary model names — verified against this account).
 */
export interface JevAi {
  run(
    model: "typesafe/jev",
    inputs: { state: unknown; questions: Record<string, unknown> },
  ): Promise<Record<string, unknown>>;
  toMarkdown(
    files: MarkdownDocument,
    options?: ConversionRequestOptions,
  ): Promise<ConversionResponse>;
}

const MARKDOWN_DESCRIPTION = `Fetch a webpage's content as markdown via Cloudflare Browser Run (read-only, ~2s, no browser session).

The fast path for read-only browsing: docs pages, articles, search results, changelogs, any page where you only need the text. Pass \`query\` to also get a calibrated \`hasAnswer\` probability (Jev) telling you whether the page actually answers your question — use it to decide whether to keep browsing or move on.

Use browser_execute instead when you need to interact with the page (login, clicks, forms), take screenshots, or inspect the DOM.

Example: { "url": "https://developers.cloudflare.com/workers/", "query": "how do Durable Objects persist state" }`;

const TRIAGE_DESCRIPTION = `Rank candidate URLs by how likely each one answers a question — BEFORE spending any fetches or browser sessions.

Pass the query plus up to 8 candidates (url, title, and any snippet you have, e.g. from search results). Returns a calibrated probability per candidate, sorted best-first. Fetch only the top pick with browser_markdown; if its hasAnswer probability comes back low, try the runner-up.

Pure evaluation on metadata — no page is fetched. Judge quality improves with titles and snippets, so include them when you have them.`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createWebFetchTools(
  options: WebFetchToolsOptions,
): Record<string, any> {
  return {
    browser_markdown: tool({
      description: MARKDOWN_DESCRIPTION,
      inputSchema: z.object({
        url: z.string().min(1).describe("The page URL to fetch"),
        query: z
          .string()
          .optional()
          .describe("What you're looking for — enables the calibrated hasAnswer verdict"),
      }),
      execute: async ({ url, query }: { url: string; query?: string }) => {
        const validated = validateTargetUrl(url);
        if ("error" in validated) {
          return { error: validated.error };
        }

        const binding = quickActionBinding(options.browser);
        const errors: string[] = [];
        let markdown: string | null = null;
        let via: "quickAction" | "cdp" | null = null;

        if (binding) {
          try {
            const response = await withTimeout(
              binding.quickAction("markdown", { url: validated.url.href }),
              45_000,
              "Browser Run /markdown",
            );
            if (!response.ok) {
              const body = await response.text().catch(() => "");
              errors.push(`quickAction /markdown (${response.status}): ${body.slice(0, 200)}`);
            } else {
              const contentType = response.headers.get("content-type") ?? "";
              if (contentType.includes("application/json")) {
                const data = (await response.json()) as { result?: unknown };
                markdown = typeof data.result === "string" ? data.result : "";
              } else {
                markdown = await response.text();
              }
              via = "quickAction";
            }
          } catch (error) {
            errors.push(`quickAction: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else {
          errors.push(
            "quickAction: browser binding does not expose the method (compatibility date < 2026-03-24)",
          );
        }

        if (!markdown || !markdown.trim()) {
          // quickAction unavailable or returned nothing — take the CDP path.
          try {
            markdown = await withTimeout(
              fetchMarkdownViaCdp(options.browser, options.ai, validated.url.href),
              45_000,
              "CDP markdown fetch",
            );
            via = "cdp";
          } catch (error) {
            errors.push(`cdp: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        if (!markdown || !markdown.trim()) {
          console.error("browser_markdown failed for", validated.url.href, errors);
          return { error: `Both fetch paths failed: ${errors.join("; ")}` };
        }

        const result: Record<string, unknown> = {
          url: validated.url.href,
          via,
          markdown: capMarkdown(markdown, 24000),
        };
        if (query) {
          result.verdict = await verifyPageAnswers(options.ai, markdown, query);
        }
        return result;
      },
    }),

    browser_triage: tool({
      description: TRIAGE_DESCRIPTION,
      inputSchema: z.object({
        query: z.string().min(1).describe("What you're looking for"),
        candidates: z
          .array(
            z.object({
              url: z.string().min(1),
              title: z.string().optional(),
              snippet: z.string().optional(),
            }),
          )
          .min(2)
          .max(8)
          .describe("Candidate URLs from search results or your own list"),
      }),
      execute: async ({
        query,
        candidates,
      }: {
        query: string;
        candidates: TriageCandidate[];
      }) => {
        const result = await triageUrls(options.ai, query, candidates);
        if (!result) {
          return { error: "Jev triage unavailable (see worker logs) — fall back to your own judgement of the URLs." };
        }
        return {
          query,
          picked: result.picked,
          ranking: result.ranking,
          nextStep: `Fetch the top pick with browser_markdown (with query set) to verify it actually answers before treating it as the answer.`,
        };
      },
    }),
  };
}
