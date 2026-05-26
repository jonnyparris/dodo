/**
 * Unit tests for the refresh-token MCP path.
 *
 * The refresh-token auth type is used for MCP servers whose OAuth authorize
 * endpoint only accepts loopback redirect URIs (e.g. cf-portal). A local
 * helper performs the DCR + browser auth flow and pushes the resulting
 * tokens to Dodo via `set_refresh_token_mcp`. UserControl then refreshes
 * the access token against the OAuth token endpoint as it expires.
 *
 * These tests exercise the storage + refresh paths directly against
 * UserControl. They mock the outbound token-endpoint fetch so the test
 * doesn't need network. The single-flight refresh property (no two
 * parallel refreshes for the same user) falls out of UserControl being a
 * single-threaded Durable Object — we don't bother re-testing that here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../src/types";

vi.mock("@cloudflare/codemode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cloudflare/codemode")>();
  return {
    ...actual,
    DynamicWorkerExecutor: vi.fn(function () {
      return { execute: vi.fn().mockResolvedValue({ logs: [], result: null }) };
    }) as unknown as typeof import("@cloudflare/codemode").DynamicWorkerExecutor,
  };
});
vi.mock("../src/agentic", async () => await import("./helpers/agentic-mock"));
vi.mock("../src/notify", () => ({ dispatchNotification: vi.fn() }));

const typedEnv = env as Env;

const OWNER = "refresh-token-tester@dodo.test";
const MCP_URL = "https://refresh-target.example.com/mcp";
const TOKEN_ENDPOINT = "https://refresh-issuer.example.com/oauth/token";

function userControlStub() {
  return typedEnv.USER_CONTROL.get(typedEnv.USER_CONTROL.idFromName(OWNER));
}

async function userControlFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("x-owner-email", OWNER);
  return userControlStub().fetch(`https://user-control${path}`, { ...init, headers });
}

async function initPasskeyIfNeeded(): Promise<void> {
  // Refresh-token storage uses envelope encryption which requires the
  // passkey envelope. Initialise once with a deterministic passkey so
  // setSecret works.
  await userControlFetch("/passkey/init", {
    method: "POST",
    body: JSON.stringify({ passkey: "refresh-token-tester-passkey" }),
    headers: { "content-type": "application/json" },
  }).catch(() => undefined);
}

describe("refresh-token MCP — storage", () => {
  beforeEach(async () => {
    await initPasskeyIfNeeded();
  });

  it("upserting tokens for a new URL creates a refresh-token config", async () => {
    const res = await userControlFetch("/refresh-token-mcp", {
      method: "POST",
      body: JSON.stringify({
        name: "Refresh Target",
        url: MCP_URL,
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: "client-abc",
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; url: string; updated: boolean };
    expect(body.url).toBe(MCP_URL);
    expect(body.updated).toBe(false);

    // The config appears in /mcp-configs with auth_type = refresh_token
    const listRes = await userControlFetch("/mcp-configs");
    const list = (await listRes.json()) as { configs: Array<{ id: string; auth_type: string; url?: string }> };
    const entry = list.configs.find((c) => c.url === MCP_URL);
    expect(entry).toBeDefined();
    expect(entry?.auth_type).toBe("refresh_token");
  });

  it("upserting tokens for the same URL updates in place", async () => {
    const first = await userControlFetch("/refresh-token-mcp", {
      method: "POST",
      body: JSON.stringify({
        name: "Refresh Target Updatable",
        url: "https://refresh-target-update.example.com/mcp",
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: "client-xyz",
        accessToken: "access-v1",
        refreshToken: "refresh-v1",
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      }),
      headers: { "content-type": "application/json" },
    });
    const firstBody = (await first.json()) as { id: string; updated: boolean };
    expect(firstBody.updated).toBe(false);

    const second = await userControlFetch("/refresh-token-mcp", {
      method: "POST",
      body: JSON.stringify({
        name: "Refresh Target Updatable",
        url: "https://refresh-target-update.example.com/mcp",
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: "client-xyz",
        accessToken: "access-v2",
        refreshToken: "refresh-v2",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
      headers: { "content-type": "application/json" },
    });
    const secondBody = (await second.json()) as { id: string; updated: boolean };
    expect(secondBody.updated).toBe(true);
    expect(secondBody.id).toBe(firstBody.id);
  });
});

describe("refresh-token MCP — access token retrieval", () => {
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    await initPasskeyIfNeeded();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns the cached access token when not yet expired", async () => {
    const url = "https://refresh-target-cached.example.com/mcp";
    await userControlFetch("/refresh-token-mcp", {
      method: "POST",
      body: JSON.stringify({
        name: "Cached Target",
        url,
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: "client-cached",
        accessToken: "still-valid-token",
        refreshToken: "still-valid-refresh",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
      headers: { "content-type": "application/json" },
    });

    const list = (await (await userControlFetch("/mcp-configs")).json()) as {
      configs: Array<{ id: string; url?: string }>;
    };
    const id = list.configs.find((c) => c.url === url)!.id;

    // No fetch should be made — the token is still valid.
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const tokenRes = await userControlFetch(`/mcp-configs/${encodeURIComponent(id)}/access-token`);
    expect(tokenRes.status).toBe(200);
    const body = (await tokenRes.json()) as { accessToken: string };
    expect(body.accessToken).toBe("still-valid-token");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes against the token endpoint when the cached token is expired", async () => {
    const url = "https://refresh-target-expired.example.com/mcp";
    await userControlFetch("/refresh-token-mcp", {
      method: "POST",
      body: JSON.stringify({
        name: "Expired Target",
        url,
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: "client-expired",
        accessToken: "expired-token",
        refreshToken: "old-refresh",
        // Expired an hour ago — guarantees a refresh on next read.
        expiresAt: Math.floor(Date.now() / 1000) - 3600,
      }),
      headers: { "content-type": "application/json" },
    });

    const list = (await (await userControlFetch("/mcp-configs")).json()) as {
      configs: Array<{ id: string; url?: string }>;
    };
    const id = list.configs.find((c) => c.url === url)!.id;

    // Mock the refresh response: rotated refresh token + new access token.
    // Capture the request for post-call assertions — putting `expect`s
    // inside the mock function turns assertion failures into rejected
    // promises, which surface as opaque 502s from the DO endpoint.
    type Captured = { url: string; method?: string; body: string };
    const capturedHolder: { value: Captured | null } = { value: null };
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      let bodyStr = "";
      if (typeof init?.body === "string") bodyStr = init.body;
      else if (init?.body instanceof URLSearchParams) bodyStr = init.body.toString();
      capturedHolder.value = { url: requestUrl, method: init?.method, body: bodyStr };
      return new Response(
        JSON.stringify({
          access_token: "fresh-token",
          refresh_token: "rotated-refresh",
          expires_in: 900,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const tokenRes = await userControlFetch(`/mcp-configs/${encodeURIComponent(id)}/access-token`);
    expect(tokenRes.status).toBe(200);
    const body = (await tokenRes.json()) as { accessToken: string };
    expect(body.accessToken).toBe("fresh-token");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(capturedHolder.value?.url).toBe(TOKEN_ENDPOINT);
    expect(capturedHolder.value?.method).toBe("POST");
    expect(capturedHolder.value?.body).toContain("grant_type=refresh_token");
    expect(capturedHolder.value?.body).toContain("refresh_token=old-refresh");
    expect(capturedHolder.value?.body).toContain("client_id=client-expired");
  });

  it("force=1 refreshes even if the cached token has not yet expired", async () => {
    const url = "https://refresh-target-force.example.com/mcp";
    await userControlFetch("/refresh-token-mcp", {
      method: "POST",
      body: JSON.stringify({
        name: "Force Target",
        url,
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: "client-force",
        accessToken: "cached-token",
        refreshToken: "cached-refresh",
        expiresAt: Math.floor(Date.now() / 1000) + 3600, // still valid
      }),
      headers: { "content-type": "application/json" },
    });

    const list = (await (await userControlFetch("/mcp-configs")).json()) as {
      configs: Array<{ id: string; url?: string }>;
    };
    const id = list.configs.find((c) => c.url === url)!.id;

    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "force-refreshed-token",
          refresh_token: "force-refreshed-refresh",
          expires_in: 900,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const tokenRes = await userControlFetch(`/mcp-configs/${encodeURIComponent(id)}/access-token?force=1`);
    expect(tokenRes.status).toBe(200);
    const body = (await tokenRes.json()) as { accessToken: string };
    expect(body.accessToken).toBe("force-refreshed-token");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces a 502 when the token endpoint rejects the refresh", async () => {
    const url = "https://refresh-target-broken.example.com/mcp";
    await userControlFetch("/refresh-token-mcp", {
      method: "POST",
      body: JSON.stringify({
        name: "Broken Target",
        url,
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: "client-broken",
        accessToken: "irrelevant",
        refreshToken: "dead-refresh",
        expiresAt: Math.floor(Date.now() / 1000) - 1, // already expired
      }),
      headers: { "content-type": "application/json" },
    });

    const list = (await (await userControlFetch("/mcp-configs")).json()) as {
      configs: Array<{ id: string; url?: string }>;
    };
    const id = list.configs.find((c) => c.url === url)!.id;

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const tokenRes = await userControlFetch(`/mcp-configs/${encodeURIComponent(id)}/access-token`);
    expect(tokenRes.status).toBe(502);
  });

  it("/mcp-configs/:id/test injects the refreshed bearer for refresh_token configs", async () => {
    // Regression: before the audit fix, /test used resolveMcpConfigHeaders
    // which doesn't know about refresh_token configs, so it built the
    // HttpMcpClient with no Authorization header and every Test click on
    // a refresh_token config returned a 401.
    const url = "https://refresh-target-testable.example.com/mcp";
    await userControlFetch("/refresh-token-mcp", {
      method: "POST",
      body: JSON.stringify({
        name: "Testable Target",
        url,
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: "client-testable",
        accessToken: "tok-testable",
        refreshToken: "rt-testable",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
      headers: { "content-type": "application/json" },
    });
    const list = (await (await userControlFetch("/mcp-configs")).json()) as {
      configs: Array<{ id: string; url?: string }>;
    };
    const id = list.configs.find((c) => c.url === url)!.id;

    // Mock fetch to capture the Authorization header used on the MCP
    // connection attempt. We return an unparseable response so the MCP
    // client fails fast — we don't care about the connection success,
    // only about the request shape.
    let authHeader: string | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? {});
      if (headers.has("authorization")) authHeader = headers.get("authorization");
      return new Response("not-mcp", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await userControlFetch(`/mcp-configs/${encodeURIComponent(id)}/test`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    // Whatever the connection result, the request must have carried the
    // bearer pulled from encrypted_secrets.
    expect(authHeader).toBe("Bearer tok-testable");
  });

  it("PUT /mcp-configs/:id refuses to mutate headers/url/auth_type on a refresh_token config", async () => {
    // Regression: before the audit fix, updateMcpConfigEncrypted treated
    // refresh_token rows the same as static_headers, so a PUT with
    // `headers` would wipe encrypted_secrets (destroying the token chain)
    // and a PUT with `auth_type: "static_headers"` would silently downgrade.
    const url = "https://refresh-target-protected.example.com/mcp";
    await userControlFetch("/refresh-token-mcp", {
      method: "POST",
      body: JSON.stringify({
        name: "Protected Target",
        url,
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: "client-protected",
        accessToken: "tok-protected",
        refreshToken: "rt-protected",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
      headers: { "content-type": "application/json" },
    });
    const list = (await (await userControlFetch("/mcp-configs")).json()) as {
      configs: Array<{ id: string; url?: string }>;
    };
    const id = list.configs.find((c) => c.url === url)!.id;

    // PUT headers — must be rejected.
    const res1 = await userControlFetch(`/mcp-configs/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ headers: { Authorization: "Bearer evil" } }),
      headers: { "content-type": "application/json" },
    });
    expect(res1.status).toBeGreaterThanOrEqual(400);

    // PUT auth_type downgrade — must be rejected.
    const res2 = await userControlFetch(`/mcp-configs/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ auth_type: "static_headers" }),
      headers: { "content-type": "application/json" },
    });
    expect(res2.status).toBeGreaterThanOrEqual(400);

    // PUT enabled — must be ALLOWED. This is the one mutation a UI
    // toggle has to work for.
    const res3 = await userControlFetch(`/mcp-configs/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
      headers: { "content-type": "application/json" },
    });
    expect(res3.status).toBe(200);

    // Token chain still intact — a follow-up access-token read works
    // without needing a refresh (no fetch should be called since the
    // cached token is still valid).
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const tokenRes = await userControlFetch(`/mcp-configs/${encodeURIComponent(id)}/access-token`);
    expect(tokenRes.status).toBe(200);
    expect(((await tokenRes.json()) as { accessToken: string }).accessToken).toBe("tok-protected");
    expect(fetchCalled).toBe(false);
  });

  it("rotates the stored refresh token — second refresh uses the rotated value", async () => {
    // Regression test for the audit's blind spot: the original suite mocked
    // a rotated refresh token in the first response but never asserted that
    // the rotated value was what got sent on the next refresh. If
    // refreshMcpAccessToken accidentally re-used the *original* refresh
    // token, a real provider would return invalid_grant on the second
    // refresh (because rotation invalidates the previous token).
    const url = "https://refresh-target-rotation.example.com/mcp";
    await userControlFetch("/refresh-token-mcp", {
      method: "POST",
      body: JSON.stringify({
        name: "Rotation Target",
        url,
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: "client-rotation",
        accessToken: "access-v0",
        refreshToken: "refresh-v0",
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      }),
      headers: { "content-type": "application/json" },
    });
    const list = (await (await userControlFetch("/mcp-configs")).json()) as {
      configs: Array<{ id: string; url?: string }>;
    };
    const id = list.configs.find((c) => c.url === url)!.id;

    let call = 0;
    const sentRefreshTokens: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const bodyStr = typeof init?.body === "string"
        ? init.body
        : init?.body instanceof URLSearchParams
          ? init.body.toString()
          : "";
      const match = bodyStr.match(/refresh_token=([^&]+)/);
      if (match) sentRefreshTokens.push(decodeURIComponent(match[1]));
      call += 1;
      const responses = [
        { access_token: "access-v1", refresh_token: "refresh-v1", expires_in: -1 },
        { access_token: "access-v2", refresh_token: "refresh-v2", expires_in: 900 },
      ];
      const payload = responses[call - 1] ?? responses[responses.length - 1];
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    // First refresh — should send refresh-v0 and rotate to refresh-v1.
    const first = await userControlFetch(`/mcp-configs/${encodeURIComponent(id)}/access-token`);
    expect(first.status).toBe(200);
    expect((await first.json() as { accessToken: string }).accessToken).toBe("access-v1");

    // Second refresh — should send refresh-v1 (the rotated value), not v0.
    // expires_in=-1 on the first response means the cached token is already
    // expired, so the access-token endpoint forces another refresh.
    const second = await userControlFetch(`/mcp-configs/${encodeURIComponent(id)}/access-token`);
    expect(second.status).toBe(200);
    expect((await second.json() as { accessToken: string }).accessToken).toBe("access-v2");

    expect(sentRefreshTokens).toEqual(["refresh-v0", "refresh-v1"]);
  });
});
