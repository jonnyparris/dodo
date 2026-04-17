import { tool } from "ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { ResolvedProvider } from "@cloudflare/codemode";
import { z } from "zod";
import { CdpSession, connectBrowser } from "./cdp-session";
import { truncateResponse } from "./truncate";
import { uploadAttachment, type AttachmentRef } from "../attachments";
import type { Env } from "../types";
import spec from "./data/cdp/spec.json";
import summary from "./data/cdp/summary.json";
import { CDP_DOMAINS } from "./data/cdp/domains";

export interface BrowserToolsOptions {
  /** Browser Rendering binding (Fetcher) */
  browser: Fetcher;
  /** Worker loader binding for DynamicWorkerExecutor */
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
  /** Session ID — required for R2 attachment key scoping. */
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

const EXECUTE_DESCRIPTION = `Execute CDP commands against a live browser session using JavaScript code.

A fresh browser with one blank page is launched per call. The CDP session is already
attached to that page — you can send page-scoped commands directly without attaching.

Available in your code:

declare const cdp: {
  send(method: string, params?: unknown, options?: {
    timeoutMs?: number;
    sessionId?: string;
  }): Promise<unknown>;
  attachToTarget(targetId: string, options?: {
    timeoutMs?: number;
  }): Promise<string>;
  getDebugLog(limit?: number): Promise<unknown[]>;
  clearDebugLog(): Promise<void>;
};

Write an async arrow function in JavaScript. Do NOT use TypeScript syntax.

The default viewport is 800×600. For most user-visible work (reviewing a
page, capturing a UI bug, etc.) you should override this to a desktop
resolution before navigating — otherwise screenshots look cramped and
mobile-styled. Set deviceScaleFactor:2 for crisp images on HiDPI displays.

Common patterns:
// Desktop screenshot (recommended default for most tasks)
async () => {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 900, deviceScaleFactor: 2, mobile: false
  });
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: "https://example.com" });
  await new Promise(r => setTimeout(r, 3000));
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  return { screenshot: data, format: "png", encoding: "base64" };
}

// Full-page screenshot (captures the entire scrollable page, not just the viewport)
async () => {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 900, deviceScaleFactor: 2, mobile: false
  });
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: "https://example.com" });
  await new Promise(r => setTimeout(r, 3000));
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true
  });
  return { screenshot: data, format: "png", encoding: "base64" };
}

// Mobile screenshot (only when the user specifically asks for a mobile view)
async () => {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true
  });
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: "https://example.com" });
  await new Promise(r => setTimeout(r, 3000));
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  return { screenshot: data, format: "png", encoding: "base64" };
}

// Get page text content
async () => {
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: "https://example.com" });
  await new Promise(r => setTimeout(r, 2000));
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: "document.body.innerText",
    returnByValue: true
  });
  return result.value;
}

// Get browser version
async () => {
  return await cdp.send("Browser.getVersion");
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

export function extractScreenshots(value: unknown): ExtractResult {
  const images: ExtractedImage[] = [];
  const scrubbed = extractScreenshotsInPlace(value, images);
  return { images, scrubbed };
}

/**
 * Create AI SDK tools for browser automation via CDP code mode.
 *
 * Returns `browser_search` (query the CDP spec) and `browser_execute`
 * (run CDP commands against a live browser). The ~1.7MB CDP spec stays
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

    browser_execute: tool({
      description: EXECUTE_DESCRIPTION,
      inputSchema: z.object({
        code: z.string().describe("JavaScript async arrow function that uses the cdp helper"),
      }),
      execute: async ({ code }: { code: string }, execOptions: { toolCallId: string }) => {
        let session: CdpSession | undefined;
        try {
          session = await connectBrowser(options.browser);

          const providers: ResolvedProvider[] = [
            {
              name: "cdp",
              fns: {
                send: async (method: unknown, params: unknown, opts: unknown) =>
                  session!.send(
                    method as string,
                    params,
                    opts as { timeoutMs?: number; sessionId?: string },
                  ),
                attachToTarget: async (targetId: unknown, opts: unknown) =>
                  session!.attachToTarget(
                    targetId as string,
                    opts as { timeoutMs?: number },
                  ),
                getDebugLog: async (limit: unknown) =>
                  session!.getDebugLog(limit as number | undefined),
                clearDebugLog: async () => session!.clearDebugLog(),
              },
              positionalArgs: true,
            },
          ];

          const result = await executor.execute(code, providers);
          if (result.error) {
            return { error: result.error };
          }

          // Pull screenshots out of the result before stringifying — base64
          // blobs should not go back to the LLM as tool-output text (wastes
          // context) nor get persisted in the message row (Think's compaction
          // would replace them with placeholder text anyway).
          const { images, scrubbed } = extractScreenshots(result.result);
          if (images.length > 0 && options.env && options.sessionId) {
            const uploaded: AttachmentRef[] = [];
            for (const img of images) {
              const ref = await uploadAttachment(options.env, {
                sessionId: options.sessionId,
                // toolCallId buckets attachments per tool invocation. Using
                // this instead of a messageId means they are linkable before
                // the assistant message has finished persisting.
                messageId: `toolcall-${execOptions.toolCallId}`,
                mediaType: img.mediaType,
                data: img.data,
                ownerEmail: options.ownerEmail,
                source: "tool",
                toolName: "browser_execute",
              });
              if (ref) uploaded.push(ref);
            }
            if (uploaded.length > 0) {
              options.onAttachments?.(execOptions.toolCallId, uploaded);
              // Give the model a short, useful summary — it knows a screenshot
              // exists and is rendered in the chat, but doesn't burn tokens
              // re-reading the base64.
              const scrubbedText = truncateResponse(scrubbed);
              const refs = uploaded
                .map((r, i) =>
                  `  ${i + 1}. ${r.mediaType} (${Math.round(r.size / 1024)}KB) — ${r.url}`,
                )
                .join("\n");
              return [
                scrubbedText,
                "",
                `[${uploaded.length} screenshot${uploaded.length === 1 ? "" : "s"} captured and rendered inline in the chat — base64 data stripped from this tool output to conserve context. The user sees the image${uploaded.length === 1 ? "" : "s"} above.]`,
                refs,
              ].join("\n");
            }
          }
          return truncateResponse(result.result);
        } catch (error) {
          return { error: formatError(error) };
        } finally {
          await session?.close();
        }
      },
    }),
  };
}
