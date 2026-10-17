/**
 * The session's persistent browser (agents SDK `Browser` on Browser Run) and
 * `browser_execute`, the SDK's pi-durable browser tool.
 *
 * - One browser per session DO, recorded in its storage via the agents
 *   Lifecycle. Tabs, cookies and logins carry over between calls until it
 *   sits idle past keep_alive; the next call then gets a fresh browser and
 *   the result says `restarted: true`.
 * - Each pi conversation (session, fork, subagent) gets its own active tab
 *   (`sessionId: "active"`); cookies are shared.
 * - Not rerun after an eviction (the code may have clicked or submitted
 *   something): the model gets an interrupted result.
 * - A returned screenshot is an image part in the tool result (the model sees
 *   it when it accepts images). We also upload it to R2 so the chat shows it,
 *   like every other tool attachment.
 */
import { Browser, browserRun } from "agents/browser";
import { browserTool } from "agents/browser/pi";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

/** How long an idle browser lives (Browser Run keep_alive). */
export const BROWSER_KEEP_ALIVE_MS = 180_000;

export const BROWSER_TOOL_NAME = "browser_execute";

export function createSessionBrowser(binding: Fetcher): Browser {
  return new Browser({ provider: browserRun(binding as never, { keepAliveMs: BROWSER_KEEP_ALIVE_MS }) });
}

type Content = TextContent | ImageContent;

export interface DodoBrowserToolOptions {
  ctx: DurableObjectState;
  browser: Browser;
  loader: WorkerLoader;
  /** Called with each screenshot the run returned (to store and show it). */
  onScreenshot?: (callId: string, image: { mediaType: string; data: string }) => Promise<void>;
}

export function createBrowserExecuteTool(options: DodoBrowserToolOptions): ToolRegistration {
  const tool = browserTool({ ctx: options.ctx, browser: options.browser, loader: options.loader, name: BROWSER_TOOL_NAME });
  return {
    ...(tool as unknown as ToolRegistration),
    async execute(args, api, context) {
      // agents 0.28.1 was built against pi-durable 1.0, whose tool results
      // used `content`; pi-durable >= 1.1 reads `output`. Accept both.
      const raw = (await (tool.execute as (...a: unknown[]) => Promise<unknown>)(args, api, context)) as {
        output?: Content[];
        content?: Content[];
        details?: unknown;
        isError?: boolean;
      };
      const output = raw.output ?? raw.content ?? [];
      if (options.onScreenshot) {
        for (const part of output) {
          if (part.type !== "image") continue;
          await options.onScreenshot(api.callId, { mediaType: part.mimeType, data: part.data }).catch(() => {});
        }
      }
      return {
        output,
        ...(raw.details !== undefined ? { details: raw.details as never } : {}),
        ...(raw.isError ? { isError: true } : {}),
      };
    },
  };
}
