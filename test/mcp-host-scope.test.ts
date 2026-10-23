/**
 * Connect-time MCP host scope: an admin's explicit `mcp: off` revokes
 * existing configs, OAuth hub tools and Dodo MCP config tools, not just
 * add/edit (src/mcp-host-scope.ts). Unlisted hosts keep working.
 */
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

vi.mock("../src/agentic", async () => await import("./helpers/agentic-mock"));
vi.mock("../src/pi/models", async () => await import("./helpers/pi-models-mock"));
vi.mock("../src/notify", () => ({ dispatchNotification: vi.fn() }));

// Record which URLs the session DO actually connects to, without network.
const connectedUrls: string[] = [];
vi.mock("../src/mcp-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mcp-client")>();
  class FakeHttpMcpClient {
    constructor(private readonly config: { id: string; url?: string }) {}
    async connect() { connectedUrls.push(this.config.url ?? ""); }
    async listTools() { return [{ name: `${this.config.id}__ping`, description: "ping", inputSchema: { type: "object" } }]; }
    disconnect() {}
  }
  return { ...actual, HttpMcpClient: FakeHttpMcpClient };
});

const { clearMcpHostScopeCache, isMcpHostRevoked } = await import("../src/mcp-host-scope");
const worker = (await import("../src/index")).default;

const typedEnv = env as unknown as Env;
const inDO = runInDurableObject as unknown as <T>(stub: unknown, fn: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
const shared = () => typedEnv.SHARED_INDEX.get(typedEnv.SHARED_INDEX.idFromName("global"));

async function setHost(hostname: string, extra: Record<string, unknown>): Promise<void> {
  await shared().fetch("https://shared-index/allowlist", {
    body: JSON.stringify({ hostname, ...extra }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  clearMcpHostScopeCache();
}

const uniqueHost = (label: string) => `${label}-${crypto.randomUUID().slice(0, 8)}.example.com`;

beforeEach(() => {
  connectedUrls.length = 0;
  clearMcpHostScopeCache();
});

describe("isMcpHostRevoked", () => {
  it("is true only for an explicit mcp: off entry", async () => {
    const unlisted = uniqueHost("unlisted");
    const on = uniqueHost("on");
    const off = uniqueHost("off");
    await setHost(on, {});
    await setHost(off, { mcp: false });
    expect(await isMcpHostRevoked(typedEnv, `https://${unlisted}/mcp`)).toBe(false);
    expect(await isMcpHostRevoked(typedEnv, `https://${on}/mcp`)).toBe(false);
    expect(await isMcpHostRevoked(typedEnv, `https://${off}/mcp`)).toBe(true);
    expect(await isMcpHostRevoked(typedEnv, `https://${off.toUpperCase()}/mcp`)).toBe(true);
    expect(await isMcpHostRevoked(typedEnv, "not a url")).toBe(false);
  });

  it("fails open when SharedIndex is down", async () => {
    const brokenEnv = {
      ...typedEnv,
      SHARED_INDEX: {
        idFromName: () => ({}),
        get: () => ({ fetch: async () => { throw new Error("SharedIndex down"); } }),
      },
    } as unknown as Env;
    expect(await isMcpHostRevoked(brokenEnv, `https://${uniqueHost("down")}/mcp`)).toBe(false);
    const http500Env = {
      ...typedEnv,
      SHARED_INDEX: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response("no", { status: 500 }) }) },
    } as unknown as Env;
    expect(await isMcpHostRevoked(http500Env, `https://${uniqueHost("down")}/mcp`)).toBe(false);
  });
});

describe("isMcpHostRevoked cache", () => {
  it("holds an answer for 30s, then re-reads", async () => {
    const host = uniqueHost("ttl");
    const url = `https://${host}/mcp`;
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      expect(await isMcpHostRevoked(typedEnv, url)).toBe(false);
      // Toggle without clearing the cache.
      await shared().fetch("https://shared-index/allowlist", {
        body: JSON.stringify({ hostname: host, mcp: false }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      now.mockReturnValue(t0 + 29_000);
      expect(await isMcpHostRevoked(typedEnv, url)).toBe(false);
      now.mockReturnValue(t0 + 31_000);
      expect(await isMcpHostRevoked(typedEnv, url)).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it("keeps a known revocation through a SharedIndex outage and backs off failed lookups", async () => {
    const host = uniqueHost("stale");
    const url = `https://${host}/mcp`;
    await setHost(host, { mcp: false });
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    let calls = 0;
    const brokenEnv = {
      ...typedEnv,
      SHARED_INDEX: { idFromName: () => ({}), get: () => ({ fetch: async () => { calls++; throw new Error("down"); } }) },
    } as unknown as Env;
    try {
      expect(await isMcpHostRevoked(typedEnv, url)).toBe(true);
      now.mockReturnValue(t0 + 60_000); // cache expired
      expect(await isMcpHostRevoked(brokenEnv, url)).toBe(true);
      expect(calls).toBe(1);
      now.mockReturnValue(t0 + 62_000); // within the 5s failure back-off
      expect(await isMcpHostRevoked(brokenEnv, url)).toBe(true);
      expect(calls).toBe(1);
      now.mockReturnValue(t0 + 66_000); // back-off over: tries again
      expect(await isMcpHostRevoked(brokenEnv, url)).toBe(true);
      expect(calls).toBe(2);
      // SharedIndex back and mcp turned on during the outage: the stale
      // answer holds through the back-off, then the fresh answer wins.
      await shared().fetch("https://shared-index/allowlist", {
        body: JSON.stringify({ hostname: host, mcp: true }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      now.mockReturnValue(t0 + 68_000);
      expect(await isMcpHostRevoked(typedEnv, url)).toBe(true);
      now.mockReturnValue(t0 + 72_000);
      expect(await isMcpHostRevoked(typedEnv, url)).toBe(false);
    } finally {
      now.mockRestore();
    }
  });

  it("keeps known revocations when the host cap evicts", async () => {
    const revokedHost = uniqueHost("keep");
    const answerEnv = {
      ...typedEnv,
      SHARED_INDEX: {
        idFromName: () => ({}),
        get: () => ({
          fetch: async (u: string) => {
            const host = new URL(u).searchParams.get("hostname");
            return Response.json(host === revokedHost ? { allowed: false, listed: true } : { allowed: false, listed: false });
          },
        }),
      },
    } as unknown as Env;
    expect(await isMcpHostRevoked(answerEnv, `https://${revokedHost}/mcp`)).toBe(true);
    for (let i = 0; i < 1_100; i++) await isMcpHostRevoked(answerEnv, `https://filler-${i}.example.com/mcp`);
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0 + 60_000);
    const brokenEnv = {
      ...typedEnv,
      SHARED_INDEX: { idFromName: () => ({}), get: () => ({ fetch: async () => { throw new Error("down"); } }) },
    } as unknown as Env;
    try {
      expect(await isMcpHostRevoked(brokenEnv, `https://${revokedHost}/mcp`)).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it("shares one lookup between concurrent callers", async () => {
    let calls = 0;
    const countingEnv = {
      ...typedEnv,
      SHARED_INDEX: {
        idFromName: () => ({}),
        get: () => ({ fetch: async () => { calls++; return Response.json({ allowed: false, listed: true }); } }),
      },
    } as unknown as Env;
    const url = `https://${uniqueHost("dedupe")}/mcp`;
    const results = await Promise.all([1, 2, 3].map(() => isMcpHostRevoked(countingEnv, url)));
    expect(results).toEqual([true, true, true]);
    expect(calls).toBe(1);
  });

  it("times out a hung lookup and allows", async () => {
    const hungEnv = {
      ...typedEnv,
      SHARED_INDEX: { idFromName: () => ({}), get: () => ({ fetch: () => new Promise(() => {}) }) },
    } as unknown as Env;
    const started = Date.now();
    expect(await isMcpHostRevoked(hungEnv, `https://${uniqueHost("hung")}/mcp`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("times out a response whose body never arrives", async () => {
    const stalledEnv = {
      ...typedEnv,
      SHARED_INDEX: {
        idFromName: () => ({}),
        get: () => ({ fetch: async () => new Response(new ReadableStream({ start() {} }), { status: 200 }) }),
      },
    } as unknown as Env;
    const started = Date.now();
    expect(await isMcpHostRevoked(stalledEnv, `https://${uniqueHost("stall")}/mcp`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("session DO connectMcpServers", () => {
  async function seedConfigs(owner: string, urls: string[]): Promise<void> {
    const uc = typedEnv.USER_CONTROL.get(typedEnv.USER_CONTROL.idFromName(owner));
    for (const [i, url] of urls.entries()) {
      const res = await uc.fetch("https://user-control/mcp-configs", {
        body: JSON.stringify({ name: `cfg-${i}`, type: "http", url, enabled: true }),
        headers: { "content-type": "application/json", "x-owner-email": owner },
        method: "POST",
      });
      expect(res.status).toBe(201);
    }
  }

  it("skips configs on an mcp: off host and picks up a change without waiting for the TTL", async () => {
    const owner = `scope-${crypto.randomUUID().slice(0, 8)}@test.local`;
    const okHost = uniqueHost("ok");
    const offHost = uniqueHost("revoked");
    await setHost(offHost, { mcp: false });
    await seedConfigs(owner, [`https://${okHost}/mcp`, `https://${offHost}/mcp`]);

    const sessionId = crypto.randomUUID();
    const stub = await getAgentByName(typedEnv.CODING_AGENT as never, sessionId);
    await inDO(stub, async (instance, state) => {
      const setMeta = (k: string, v: string) =>
        state.storage.sql.exec("INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, 1)", k, v);
      setMeta("owner_email", owner);
      setMeta("session_id", sessionId);
      const statusFor = (host: string) =>
        Array.from((instance.mcpStatus as Map<string, { url?: string; ok: boolean; error?: string }>).values()).find((s) => s.url?.includes(host));

      await instance.connectMcpServers({ forceReconnect: true });
      expect(connectedUrls).toEqual([`https://${okHost}/mcp`]);
      expect(statusFor(okHost)?.ok).toBe(true);
      expect(statusFor(offHost)).toMatchObject({ ok: false, error: expect.stringContaining(`"${offHost}"`) });

      // Admin turns mcp back on: next call rebuilds even inside the TTL.
      await setHost(offHost, { mcp: true });
      connectedUrls.length = 0;
      await instance.connectMcpServers();
      expect(connectedUrls.sort()).toEqual([`https://${offHost}/mcp`, `https://${okHost}/mcp`].sort());
      expect(statusFor(offHost)?.ok).toBe(true);

      // And off again: the live gatekeeper is dropped, not kept for 5 minutes.
      await setHost(offHost, { mcp: false });
      connectedUrls.length = 0;
      await instance.connectMcpServers();
      expect(connectedUrls).toEqual([`https://${okHost}/mcp`]);
      expect(instance.mcpGatekeepers).toHaveLength(1);
      expect(statusFor(offHost)?.ok).toBe(false);

      // Every config revoked: gatekeepers emptied, status still explains why.
      await setHost(okHost, { mcp: false });
      const loadOAuth = vi.spyOn(instance, "loadOAuthToolsFromHub");
      await instance.connectMcpServers();
      expect(instance.mcpGatekeepers).toHaveLength(0);
      // OAuth hub tools still load with no HTTP configs left.
      expect(loadOAuth).toHaveBeenCalledWith(owner);
      expect(statusFor(okHost)).toMatchObject({ ok: false, error: expect.stringContaining("turned off") });
      expect(statusFor(offHost)).toMatchObject({ ok: false, error: expect.stringContaining("turned off") });
    });
  });
});

describe("OAuth hub", () => {
  it("hides tools from mcp: off hosts and refuses calls to them", async () => {
    const okHost = uniqueHost("oauth-ok");
    const offHost = uniqueHost("oauth-off");
    await setHost(offHost, { mcp: false });
    const stub = await getAgentByName(typedEnv.CODING_AGENT as never, `hub-${crypto.randomUUID().slice(0, 8)}@test.local`);
    await inDO(stub, async (instance) => {
      const callTool = vi.fn().mockResolvedValue({ content: [] });
      instance.getMcpServers = () => ({
        servers: {
          s_ok: { name: "ok", server_url: `https://${okHost}/mcp` },
          s_off: { name: "off", server_url: `https://${offHost}/mcp` },
        },
      });
      Object.defineProperty(instance, "mcp", {
        configurable: true,
        value: {
          listTools: () => [
            { name: "a", serverId: "s_ok", inputSchema: {} },
            { name: "b", serverId: "s_off", inputSchema: {} },
          ],
          callTool,
        },
      });

      const tools = await instance.listOAuthTools();
      expect(tools.map((t: { name: string }) => t.name)).toEqual(["a"]);

      await expect(instance.callOAuthTool("s_off", "b", {})).rejects.toThrow(`"${offHost}"`);
      expect(callTool).not.toHaveBeenCalled();
      await instance.callOAuthTool("s_ok", "a", {});
      expect(callTool).toHaveBeenCalledTimes(1);
    });
  });
});

describe("Dodo MCP config tools", () => {
  async function mcpCall(name: string, args: Record<string, unknown>): Promise<string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      Authorization: "Bearer test-mcp-token",
      Accept: "application/json, text/event-stream",
    };
    const post = async (body: unknown) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request("https://dodo.example/mcp", { body: JSON.stringify(body), headers, method: "POST" }), typedEnv, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    const init = await post({ jsonrpc: "2.0", method: "initialize", id: 1, params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } } });
    const sid = init.headers.get("mcp-session-id");
    if (sid) headers["mcp-session-id"] = sid;
    await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    const res = await post({ jsonrpc: "2.0", method: "tools/call", id: 2, params: { name, arguments: args } });
    expect(res.status).toBe(200);
    return res.text();
  }

  it("add_mcp_config still skips the allowlist for unlisted hosts but refuses mcp: off", async () => {
    const offHost = uniqueHost("tool-off");
    await setHost(offHost, { mcp: false });
    const refused = await mcpCall("add_mcp_config", { name: "off", url: `https://${offHost}/mcp` });
    expect(refused).toContain("turned off");
    expect(refused).toContain('"isError":true');

    const unlisted = uniqueHost("tool-unlisted");
    const added = await mcpCall("add_mcp_config", { name: "unlisted", url: `https://${unlisted}/mcp` });
    expect(added).not.toContain('"isError":true');
    expect(added).toContain(unlisted);
  });

  it("set_refresh_token_mcp and start_dcr_oauth_flow refuse mcp: off hosts", async () => {
    const offHost = uniqueHost("rt-off");
    await setHost(offHost, { mcp: false });
    const rt = await mcpCall("set_refresh_token_mcp", {
      name: "rt",
      url: `https://${offHost}/mcp`,
      tokenEndpoint: `https://${offHost}/token`,
      clientId: "c",
      accessToken: "a",
      refreshToken: "r",
    });
    expect(rt).toContain("turned off");
    const dcr = await mcpCall("start_dcr_oauth_flow", { mcpUrl: `https://${offHost}/mcp`, mcpName: "dcr" });
    expect(dcr).toContain("turned off");
  });
});

describe("ChatMonitorAgent cf-portal read", () => {
  it("refuses an mcp: off host before connecting or force-refreshing the token", async () => {
    const { ChatMonitorAgent } = await import("../src/chat-monitor-agent");
    const offHost = uniqueHost("portal-off");
    const okHost = uniqueHost("portal-ok");
    await setHost(offHost, { mcp: false });
    const fetchMessages = (ChatMonitorAgent.prototype as any).fetchMessages as (owner: string, space: string, after: string | null) => Promise<unknown>;
    const fakeThis = (host: string) => ({
      env: typedEnv,
      tokenCache: null,
      cfgCache: null,
      getCfPortalConfig: vi.fn().mockResolvedValue({ id: "p", name: "portal", type: "http", url: `https://${host}/mcp`, enabled: true }),
      fetchMessagesOnce: vi.fn().mockResolvedValue([]),
    });

    const off = fakeThis(offHost);
    await expect(fetchMessages.call(off, "o@test.local", "spaces/x", null)).rejects.toThrow(`"${offHost}"`);
    expect(off.fetchMessagesOnce).not.toHaveBeenCalled();

    const ok = fakeThis(okHost);
    await expect(fetchMessages.call(ok, "o@test.local", "spaces/x", null)).resolves.toEqual([]);
    expect(ok.fetchMessagesOnce).toHaveBeenCalledTimes(1);
  });
});
