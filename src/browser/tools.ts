import { tool } from "ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { ResolvedProvider } from "@cloudflare/codemode";
import { z } from "zod";
import { browserTool } from "agents/browser/ai-sdk";
import type { BrowserSource, BrowserToolOutput } from "agents/browser/ai-sdk";
import { truncateResponse } from "./truncate";
import { uploadAttachment, type AttachmentRef } from "../attachments";
import type { Env } from "../types";
import spec from "./data/cdp/spec.json";
import summary from "./data/cdp/summary.json";
import { CDP_DOMAINS } from "./data/cdp/domains";

export interface BrowserToolsOptions {
  /**
   * The persistent browser `browser_execute` drives: the `Browser` installed
   * on the host agent's Lifecycle (`agents/browser`). Tabs, cookies and
   * logins carry over between calls. Keep-alive is set on its provider.
   */
  browser: BrowserSource;
  /** Worker loader binding for the sandboxed executors */
  loader: WorkerLoader;
  /** Execution timeout in ms (default: 30000) */
  timeout?: number;
  /**
   * Callback fired when a tool result contained image data that was
   * extracted, uploaded to R2, and replaced with attachment references.
   * Used by the coding agent to stream image events to the chat UI
   * before the assistant message finishes persisting.
   */
  onAttachments?: (toolCallId: string, attachments: AttachmentRef[]) => void;
  /** Full worker env — required for R2 attachment uploads. */
  env?: Env;
  /**
   * Session ID — required for R2 attachment key scoping, and the
   * browserTool `scope` so each Dodo session keeps its own active tab.
   */
  sessionId?: string;
  /** Owner email — stored as R2 custom metadata for audit. */
  ownerEmail?: string;
}

const SEARCH_DESCRIPTION = `Search the Chrome DevTools Protocol spec using JavaScript code.

Source totals: ${summary.totals.domains} domains, ${summary.totals.commands} commands, ${summary.totals.events} events, ${summary.totals.types} types.
Top domains: ${CDP_DOMAINS.slice(0, 20).join(", ")}...

Available in your code:

declare const spec: {
  get(): Promise<{
    domains: Array<{
      name: string;
      description?: string;
      commands: Array<{ name: string; method: string; description?: string }>;
      events: Array<{ name: string; event: string; description?: string }>;
      types: Array<{ id: string; name: string; description?: string }>;
    }>;
  }>;
};

Write an async arrow function in JavaScript. Do NOT use TypeScript syntax.

Example:
async () => {
  const s = await spec.get();
  return s.domains
    .find(d => d.name === "Page")
    .commands.filter(c => c.name.toLowerCase().includes("screenshot"))
    .map(c => ({ method: c.method, description: c.description }));
}`;

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Walk the CDP tool result tree and find objects that look like screenshots.
 * Returns the list of matches along with a cloned tree that has the base64
 * payloads stripped — we don't want to feed megabytes of base64 back to the
 * model as tool output text.
 *
 * Shapes recognised:
 *   - agents browserTool shape: { type: "browser_screenshot", mediaType, data }
 *     (the only one that survives browserTool's base64 redaction)
 *   - Raw CDP Page.captureScreenshot response: { data: "base64...", format: "png" }
 *   - Author-returned docstring shape: { screenshot: "base64...", format: "png" }
 */
interface ExtractedImage {
  data: string;
  mediaType: string;
}
interface ExtractResult {
  images: ExtractedImage[];
  scrubbed: unknown;
}

const SCREENSHOT_FORMATS = new Set(["png", "jpeg", "webp"]);
// Base64 lower bound for treating a string as a screenshot payload. A PNG
// header is already ~24 base64 chars; 50 is safely past "accidentally looks
// like a format hint" territory without excluding tiny test fixtures.
const MIN_SCREENSHOT_BASE64_LENGTH = 50;

function extractScreenshotsInPlace(value: unknown, images: ExtractedImage[]): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => extractScreenshotsInPlace(v, images));
  }
  const obj = value as Record<string, unknown>;
  // agents browserTool shape: { type: "browser_screenshot", mediaType, data }
  if (
    obj.type === "browser_screenshot" &&
    typeof obj.mediaType === "string" && obj.mediaType.startsWith("image/") &&
    typeof obj.data === "string" && obj.data.length >= MIN_SCREENSHOT_BASE64_LENGTH
  ) {
    images.push({ data: obj.data, mediaType: obj.mediaType });
    const { data: _data, ...rest } = obj;
    return { ...rest, _attachmentPlaceholder: true };
  }
  const format = typeof obj.format === "string" ? obj.format.toLowerCase() : null;
  // Raw CDP shape: { data, format: "png"|"jpeg"|"webp" }
  if (
    format && SCREENSHOT_FORMATS.has(format) &&
    typeof obj.data === "string" && obj.data.length >= MIN_SCREENSHOT_BASE64_LENGTH
  ) {
    images.push({ data: obj.data, mediaType: `image/${format === "jpeg" ? "jpeg" : format}` });
    const { data: _data, ...rest } = obj;
    return { ...rest, _attachmentPlaceholder: true };
  }
  // Docstring shape: { screenshot, format }
  if (
    format && SCREENSHOT_FORMATS.has(format) &&
    typeof obj.screenshot === "string" && obj.screenshot.length >= MIN_SCREENSHOT_BASE64_LENGTH
  ) {
    images.push({
      data: obj.screenshot,
      mediaType: `image/${format === "jpeg" ? "jpeg" : format}`,
    });
    const { screenshot: _screenshot, ...rest } = obj;
    return { ...rest, _attachmentPlaceholder: true };
  }
  // Recurse into plain objects
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = extractScreenshotsInPlace(v, images);
  }
  return result;
}

/** browser_execute output after Dodo has lifted screenshots into R2. */
type DodoBrowserOutput = BrowserToolOutput & { attachments?: AttachmentRef[] };

export function extractScreenshots(value: unknown): ExtractResult {
  const images: ExtractedImage[] = [];
  const scrubbed = extractScreenshotsInPlace(value, images);
  return { images, scrubbed };
}

/**
 * Create AI SDK tools for browser automation via CDP code mode.
 *
 * Returns `browser_search` (query the CDP spec) and `browser_execute`
 * (the agents SDK browserTool against the session's persistent browser,
 * with screenshots lifted into R2 attachments). The ~1.7MB CDP spec stays
 * server-side — only query results enter the context window.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createBrowserTools(options: BrowserToolsOptions): Record<string, any> {
  // No globalOutbound — the sandbox doesn't need network access.
  // All CDP traffic goes through host-side providers (cdp.send etc.),
  // not through the sandbox's fetch.
  const executor = new DynamicWorkerExecutor({
    loader: options.loader,
    timeout: options.timeout ?? 30_000,
  });

  const specData = spec;

  const sdkBrowser = browserTool({
    browser: options.browser,
    loader: options.loader,
    timeoutMs: options.timeout ?? 30_000,
    scope: options.sessionId,
  });

  return {
    browser_search: tool({
      description: SEARCH_DESCRIPTION,
      inputSchema: z.object({
        code: z.string().describe("JavaScript async arrow function that queries the CDP spec"),
      }),
      execute: async ({ code }: { code: string }) => {
        try {
          const providers: ResolvedProvider[] = [
            { name: "spec", fns: { get: async () => specData } },
          ];
          const result = await executor.execute(code, providers);
          if (result.error) {
            return { error: result.error };
          }
          return truncateResponse(result.result);
        } catch (error) {
          return { error: formatError(error) };
        }
      },
    }),

    // browser_execute is the agents SDK browserTool (agents/browser/ai-sdk):
    // a persistent Browser Run browser, scoped per Dodo session. Wrapped only
    // to keep Dodo's screenshot path: the SDK adapter hands the model a text
    // summary but leaves the base64 on the persisted tool part, so we lift
    // screenshots into R2 attachments and strip the payload first.
    browser_execute: {
      description: sdkBrowser.description,
      inputSchema: sdkBrowser.inputSchema,
      execute: async (input: { code: string }, execOptions: { toolCallId: string }) => {
        let output: BrowserToolOutput;
        try {
          output = await sdkBrowser.execute(input, execOptions);
        } catch (error) {
          return { error: formatError(error) };
        }
        if (output.status !== "completed" || !options.env || !options.sessionId) return output;
        const { images, scrubbed } = extractScreenshots(output.result);
        if (images.length === 0) return output;
        const uploaded: AttachmentRef[] = [];
        for (const img of images) {
          const ref = await uploadAttachment(options.env, {
            sessionId: options.sessionId,
            // toolCallId buckets attachments per tool invocation, so they are
            // linkable before the assistant message has finished persisting.
            messageId: `toolcall-${execOptions.toolCallId}`,
            mediaType: img.mediaType,
            data: img.data,
            ownerEmail: options.ownerEmail,
            source: "tool",
            toolName: "browser_execute",
          });
          if (ref) uploaded.push(ref);
        }
        if (uploaded.length === 0) return output;
        options.onAttachments?.(execOptions.toolCallId, uploaded);
        return { ...output, result: scrubbed, attachments: uploaded } as DodoBrowserOutput;
      },
      toModelOutput: ({ output }: { output: DodoBrowserOutput | { error: string } }) => {
        if ("error" in output && !("status" in output)) {
          return { type: "text" as const, value: `Error: ${output.error}` };
        }
        const o = output as DodoBrowserOutput;
        if (!o.attachments?.length) return sdkBrowser.toModelOutput({ output: o });
        const refs = o.attachments
          .map((r, i) => `  ${i + 1}. ${r.mediaType} (${Math.round(r.size / 1024)}KB) — ${r.url}`)
          .join("\n");
        const notes = [o.notice, o.newTabs?.length ? `New tabs opened by the page: ${JSON.stringify(o.newTabs)}` : undefined]
          .filter(Boolean)
          .join(" ");
        const n = o.attachments.length;
        return {
          type: "text" as const,
          value: [
            `[${n} screenshot${n === 1 ? "" : "s"} captured and rendered inline in the chat — base64 data stripped to conserve context. The user sees the image${n === 1 ? "" : "s"} above.]`,
            refs,
            notes,
          ].filter(Boolean).join("\n"),
        };
      },
    },
  };
}
