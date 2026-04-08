import { tool } from "ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { ResolvedProvider } from "@cloudflare/codemode";
import { z } from "zod";
import { CdpSession, connectBrowser } from "./cdp-session";
import { truncateResponse } from "./truncate";
import spec from "./data/cdp/spec.json";
import summary from "./data/cdp/summary.json";
import { CDP_DOMAINS } from "./data/cdp/domains";

export interface BrowserToolsOptions {
  /** Browser Rendering binding (Fetcher) */
  browser: Fetcher;
  /** Worker loader binding for DynamicWorkerExecutor */
  loader: WorkerLoader;
  /** Optional outbound fetcher for gated network access from sandbox */
  outbound?: Fetcher | null;
  /** Execution timeout in ms (default: 30000) */
  timeout?: number;
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

Common patterns:
// Navigate and screenshot
async () => {
  const targets = await cdp.send("Target.getTargets");
  const page = targets.targetInfos.find(t => t.type === "page");
  const sid = await cdp.attachToTarget(page.targetId);
  await cdp.send("Page.enable", {}, { sessionId: sid });
  await cdp.send("Page.navigate", { url: "https://example.com" }, { sessionId: sid });
  await new Promise(r => setTimeout(r, 3000));
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, { sessionId: sid });
  return { screenshot: data, format: "png", encoding: "base64" };
}

// Get browser version
async () => {
  return await cdp.send("Browser.getVersion");
}`;

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const executor = new DynamicWorkerExecutor({
    loader: options.loader,
    globalOutbound: options.outbound ?? null,
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
      execute: async ({ code }: { code: string }) => {
        let session: CdpSession | undefined;
        try {
          session = await connectBrowser(options.browser, options.timeout);

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
          return truncateResponse(result.result);
        } catch (error) {
          return { error: formatError(error) };
        } finally {
          session?.close();
        }
      },
    }),
  };
}
