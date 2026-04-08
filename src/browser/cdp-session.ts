import puppeteer from "@cloudflare/puppeteer";
import type { Browser, CDPSession as PuppeteerCDPSession } from "@cloudflare/puppeteer";

interface DebugEntry {
  at: string;
  type: string;
  [key: string]: unknown;
}

export interface CdpSendOptions {
  timeoutMs?: number;
  sessionId?: string;
}

export interface CdpAttachOptions {
  timeoutMs?: number;
}

const MAX_DEBUG_ENTRIES = 400;

/**
 * A CDP session backed by @cloudflare/puppeteer.
 *
 * The Browser Rendering binding doesn't expose raw CDP WebSocket access,
 * so we use Puppeteer to launch the browser and then use its CDPSession
 * to proxy raw CDP commands. This gives us full CDP access (screenshots,
 * DOM, network, etc.) while working within the binding's constraints.
 *
 * Used host-side (not in the sandbox) — the sandbox calls into this
 * via DynamicWorkerExecutor's provider RPC.
 */
export class CdpSession {
  #browser: Browser;
  #cdpSession: PuppeteerCDPSession;
  #debugLog: DebugEntry[] = [];
  /** Map of sessionId → CDPSession for attached targets */
  #targetSessions = new Map<string, PuppeteerCDPSession>();

  constructor(browser: Browser, cdpSession: PuppeteerCDPSession) {
    this.#browser = browser;
    this.#cdpSession = cdpSession;
  }

  async send(
    method: string,
    params?: unknown,
    options: CdpSendOptions = {},
  ): Promise<unknown> {
    const sessionId = typeof options.sessionId === "string" && options.sessionId.length > 0
      ? options.sessionId
      : undefined;

    this.#recordDebug("send", { method, sessionId });

    try {
      // Use the target-specific session if a sessionId is provided
      const session = sessionId
        ? this.#targetSessions.get(sessionId) ?? this.#cdpSession
        : this.#cdpSession;

      const result = await session.send(method as any, params as any);
      this.#recordDebug("receive", { method, sessionId, success: true });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#recordDebug("error", { method, sessionId, error: message });
      throw new Error(`CDP error: ${message} for ${method}`);
    }
  }

  async attachToTarget(
    targetId: string,
    _options: CdpAttachOptions = {},
  ): Promise<string> {
    if (typeof targetId !== "string" || !targetId) {
      throw new Error("attachToTarget requires a targetId");
    }

    this.#recordDebug("attach-request", { targetId });

    // Use the browser-level CDP session to attach to the target
    const result = await this.#cdpSession.send("Target.attachToTarget" as any, {
      targetId,
      flatten: true,
    } as any) as { sessionId?: string };

    const sessionId = result?.sessionId ?? "";
    if (!sessionId) {
      throw new Error(
        `Target.attachToTarget did not return a sessionId for target ${targetId}`,
      );
    }

    // Create a new CDPSession for this target using Puppeteer's internal API
    // The flattened session mode means commands with the sessionId go through
    // the same connection. We track the sessionId and use the browser-level
    // session with manual sessionId routing.
    this.#targetSessions.set(sessionId, this.#cdpSession);

    this.#recordDebug("attach", { targetId, sessionId });
    return sessionId;
  }

  getDebugLog(limit = 50): DebugEntry[] {
    const normalized = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 50;
    return this.#debugLog.slice(-normalized);
  }

  clearDebugLog(): void {
    this.#debugLog = [];
  }

  async close(): Promise<void> {
    try {
      await this.#browser.close();
    } catch {
      // browser may already be closed
    }
  }

  #recordDebug(type: string, data: Record<string, unknown>): void {
    this.#debugLog.push({ at: new Date().toISOString(), type, ...data });
    if (this.#debugLog.length > MAX_DEBUG_ENTRIES) {
      this.#debugLog.splice(0, this.#debugLog.length - MAX_DEBUG_ENTRIES);
    }
  }
}

/**
 * Connect to a browser via the Browser Rendering binding using Puppeteer.
 * Launches a browser, opens a page, and creates a CDP session for raw
 * protocol access. The caller gets full CDP command access while Puppeteer
 * handles the connection protocol with the Browser Rendering binding.
 */
export async function connectBrowser(
  browserBinding: Fetcher,
): Promise<CdpSession> {
  const browser = await puppeteer.launch(browserBinding);
  const page = await browser.newPage();
  const cdpSession = await page.createCDPSession();
  return new CdpSession(browser, cdpSession);
}
