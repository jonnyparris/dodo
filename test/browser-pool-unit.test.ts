import { describe, it, expect, vi, beforeEach } from "vitest";

// Ported from Signal agent (agent/src/browser/pool.test.ts, 36981d6).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const launched: any[] = [];
function fakeTarget(url: string) {
  const cdp = { url, send: vi.fn(async () => ({ result: { value: url } })) };
  return { type: () => "page", url: () => url, createCDPSession: vi.fn(async () => cdp), cdp };
}
function fakeBrowser(id: string) {
  // Mirrors live Browser Run: the tab we worked in, plus stray blank tabs.
  const targets = [fakeTarget("about:blank"), fakeTarget("https://x.test/p"), fakeTarget("about:blank")];
  const page = { url: () => "https://x.test/p", createCDPSession: async () => targets[1].cdp };
  return {
    id,
    targets: () => targets,
    targetsList: targets,
    sessionId: () => id,
    waitForTarget: vi.fn(async () => {
      throw new Error("timeout");
    }),
    newPage: vi.fn(async () => page),
    close: vi.fn(),
    disconnect: vi.fn(),
  };
}
vi.mock("@cloudflare/puppeteer", () => ({
  default: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    launch: vi.fn(async (_b: unknown, opts: any) => {
      const b = fakeBrowser(`s${launched.length}`);
      launched.push({ b, opts });
      return b;
    }),
    connect: vi.fn(async (_b: unknown, sid: string) => {
      const hit = launched.find((l) => l.b.id === sid);
      if (!hit || hit.dead) throw new Error("gone");
      return hit.b;
    }),
  },
}));

import { leaseBrowser, _resetBrowserPool, BROWSER_KEEP_ALIVE_MS } from "../src/browser/cdp-session";

describe("leaseBrowser", () => {
  beforeEach(() => {
    launched.length = 0;
    _resetBrowserPool();
  });
  const B = {} as Fetcher;

  it("launches with keep_alive, then reuses after a healthy release", async () => {
    const a = await leaseBrowser(B, "t1");
    expect(a.reused).toBe(false);
    expect(launched[0].opts).toEqual({ keep_alive: BROWSER_KEEP_ALIVE_MS });
    await a.release(true);
    expect(launched[0].b.disconnect).toHaveBeenCalled();
    expect(launched[0].b.close).not.toHaveBeenCalled();
    const b = await leaseBrowser(B, "t1");
    expect(b.reused).toBe(true);
    expect(launched).toHaveLength(1);
  });

  it("does not share across sessions, or while busy", async () => {
    const a = await leaseBrowser(B, "t1");
    const b = await leaseBrowser(B, "t1");
    expect(b.reused).toBe(false);
    const c = await leaseBrowser(B, "t2");
    expect(c.reused).toBe(false);
    expect(launched).toHaveLength(3);
    // a lost its pool slot to b, so releasing it closes rather than parks it
    await a.release(true);
    expect(launched[0].b.close).toHaveBeenCalled();
  });

  it("closes on an unhealthy release and after the idle window", async () => {
    const a = await leaseBrowser(B, "t1");
    await a.release(false);
    expect(launched[0].b.close).toHaveBeenCalled();
    expect((await leaseBrowser(B, "t1")).reused).toBe(false);
    let now = 0;
    const c = await leaseBrowser(B, "t3", () => now);
    await c.release(true);
    now = BROWSER_KEEP_ALIVE_MS;
    expect((await leaseBrowser(B, "t3", () => now)).reused).toBe(false);
  });

  it("falls back to a fresh launch when reconnect fails", async () => {
    const a = await leaseBrowser(B, "t1");
    await a.release(true);
    launched[0].dead = true;
    const b = await leaseBrowser(B, "t1");
    expect(b.reused).toBe(false);
    expect(launched).toHaveLength(2);
  });

  it("reattaches to the tab it left, not a blank one, without opening a new tab", async () => {
    const a = await leaseBrowser(B, "t1");
    await a.release(true);
    const b = launched[0].b;
    expect(b.newPage).toHaveBeenCalledTimes(1);
    await leaseBrowser(B, "t1");
    expect(b.newPage).toHaveBeenCalledTimes(1);
    expect(b.targetsList[1].createCDPSession).toHaveBeenCalled();
    expect(b.targetsList[0].createCDPSession).not.toHaveBeenCalled();
    expect(b.targetsList[2].createCDPSession).not.toHaveBeenCalled();
  });
});
