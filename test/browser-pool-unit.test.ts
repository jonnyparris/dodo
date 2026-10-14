import { describe, it, expect, vi, beforeEach } from "vitest";

// Ported from Signal agent (agent/src/browser/pool.test.ts, 36981d6).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const launched: any[] = [];
// Mirrors live Browser Run after puppeteer.connect: puppeteer sees no
// targets, but raw CDP lists the tab we worked in plus stray blank tabs.
function fakeBrowser(id: string) {
  const tabs = [
    { targetId: "blank-0", type: "page", url: "about:blank" },
    { targetId: "work", type: "page", url: "https://x.test/p" },
  ];
  const attached = new Map<string, unknown>();
  const closed: string[] = [];
  let tmpCount = 0;
  const conn = {
    send: vi.fn(async (method: string, params?: { targetId?: string }) => {
      if (method === "Target.getTargets") return { targetInfos: tabs };
      if (method === "Target.attachToTarget") {
        const sid = `sess-${params!.targetId}`;
        attached.set(sid, { attachedTo: params!.targetId, send: vi.fn(async () => ({ result: { value: "https://x.test/p" } })) });
        return { sessionId: sid };
      }
      if (method === "Target.closeTarget") {
        closed.push(params!.targetId!);
        return {};
      }
      throw new Error(`unexpected ${method}`);
    }),
    session: (sid: string) => attached.get(sid) ?? null,
  };
  const newPage = vi.fn(async () => {
    const targetId = `tmp-${tmpCount++}`;
    tabs.push({ targetId, type: "page", url: "about:blank" });
    const session = {
      connection: () => conn,
      send: vi.fn(async (method: string) => {
        if (method === "Target.getTargetInfo") return { targetInfo: { targetId } };
        // First call navigates this fresh tab; currentUrl() reads it back.
        return { result: { value: "https://x.test/p" } };
      }),
    };
    return { createCDPSession: async () => session };
  });
  return { id, sessionId: () => id, newPage, conn, attached, closed, close: vi.fn(), disconnect: vi.fn() };
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

  it("reattaches to the tab it left via raw CDP and closes the temp tab", async () => {
    const a = await leaseBrowser(B, "t1");
    await a.release(true);
    const b = await leaseBrowser(B, "t1");
    expect(b.reused).toBe(true);
    const br = launched[0].b;
    expect([...br.attached.values()].map((s: { attachedTo: string }) => s.attachedTo)).toEqual(["work"]);
    expect(br.closed).toEqual(["tmp-1"]);
  });

  it("keeps the temp tab as a fresh page when the old tab is gone", async () => {
    const a = await leaseBrowser(B, "t1");
    await a.release(true);
    const br = launched[0].b;
    br.conn.send.mockImplementationOnce(async () => ({ targetInfos: [] }));
    const b = await leaseBrowser(B, "t1");
    expect(b.reused).toBe(true);
    expect(br.attached.size).toBe(0);
    expect(br.closed).toEqual([]);
  });
});
