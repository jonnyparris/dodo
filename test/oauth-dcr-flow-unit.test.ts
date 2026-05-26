/**
 * Unit tests for the Dodo-owned DCR OAuth flow.
 *
 * Dodo runs DCR + token exchange server-side; a local helper handles only
 * the browser-side authorize step on a loopback callback. The two-step
 * dance is keyed by an opaque `state` nonce, persisted (encrypted) in
 * UserControl between the two calls.
 *
 * These tests exercise UserControl directly. Outbound fetches (discovery,
 * DCR, token exchange) are mocked via `globalThis.fetch`.
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
const OWNER = "dcr-flow-tester@dodo.test";

const MCP_URL = "https://dcr-target.example.com/mcp";
const AUTH_SERVER = "https://dcr-auth.example.com";
const REGISTRATION = `${AUTH_SERVER}/oauth/registration`;
const AUTHORIZE = `${AUTH_SERVER}/oauth/authorize`;
const TOKEN_ENDPOINT = `${AUTH_SERVER}/oauth/token`;

function userControlStub() {
  return typedEnv.USER_CONTROL.get(typedEnv.USER_CONTROL.idFromName(OWNER));
}

async function userControlFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("x-owner-email", OWNER);
  return userControlStub().fetch(`https://user-control${path}`, { ...init, headers });
}

async function initPasskeyIfNeeded(): Promise<void> {
  await userControlFetch("/passkey/init", {
    method: "POST",
    body: JSON.stringify({ passkey: "dcr-flow-tester-passkey" }),
    headers: { "content-type": "application/json" },
  }).catch(() => undefined);
}

/** Mock fetch impl that routes based on URL. Returns a mock that lets each
 *  test set per-call behaviour for the well-known + DCR + token endpoints. */
function makeRoutingFetch(responses: Record<string, () => Response>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    for (const [pattern, factory] of Object.entries(responses)) {
      if (requestUrl.includes(pattern)) return factory();
    }
    throw new Error(`Unmocked fetch to ${requestUrl}`);
  });
}

describe("DCR OAuth flow — start", () => {
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    await initPasskeyIfNeeded();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("discovers endpoints, runs DCR, and returns an authorize URL with PKCE + state", async () => {
    const fetchSpy = makeRoutingFetch({
      "/.well-known/oauth-protected-resource": () =>
        new Response(JSON.stringify({ authorization_servers: [AUTH_SERVER] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      "/.well-known/oauth-authorization-server": () =>
        new Response(
          JSON.stringify({
            registration_endpoint: REGISTRATION,
            authorization_endpoint: AUTHORIZE,
            token_endpoint: TOKEN_ENDPOINT,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      "/oauth/registration": () =>
        new Response(JSON.stringify({ client_id: "issued-client-id" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await userControlFetch("/oauth-dcr/start", {
      method: "POST",
      body: JSON.stringify({
        mcpUrl: MCP_URL,
        mcpName: "DCR Target",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; authUrl: string; redirectUri: string };
    expect(body.state).toMatch(/^[0-9a-f]{64}$/);
    expect(body.redirectUri).toBe("http://127.0.0.1:19876/callback");

    const parsed = new URL(body.authUrl);
    expect(parsed.origin + parsed.pathname).toBe(AUTHORIZE);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("issued-client-id");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    // code_challenge is base64-url with no padding
    expect(parsed.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:19876/callback");
    expect(parsed.searchParams.get("state")).toBe(body.state);
    expect(parsed.searchParams.get("resource")).toBe(MCP_URL);
  });

  it("honours explicit endpoint overrides and skips discovery", async () => {
    const fetchSpy = makeRoutingFetch({
      "/oauth/registration": () =>
        new Response(JSON.stringify({ client_id: "no-discovery-client" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await userControlFetch("/oauth-dcr/start", {
      method: "POST",
      body: JSON.stringify({
        mcpUrl: MCP_URL,
        mcpName: "Override Target",
        registrationEndpoint: REGISTRATION,
        authorizationEndpoint: AUTHORIZE,
        tokenEndpoint: TOKEN_ENDPOINT,
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    // Only the DCR endpoint should have been called — no well-known fetch.
    const calls = (fetchSpy as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls).toHaveLength(1);
    const firstArg = calls[0][0];
    const firstUrl = typeof firstArg === "string" ? firstArg : (firstArg as { url?: string }).url ?? String(firstArg);
    expect(firstUrl).toBe(REGISTRATION);
  });

  it("surfaces 502 when DCR fails", async () => {
    const fetchSpy = makeRoutingFetch({
      "/oauth/registration": () =>
        new Response(JSON.stringify({ error: "invalid_request" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await userControlFetch("/oauth-dcr/start", {
      method: "POST",
      body: JSON.stringify({
        mcpUrl: MCP_URL,
        mcpName: "Failing Target",
        registrationEndpoint: REGISTRATION,
        authorizationEndpoint: AUTHORIZE,
        tokenEndpoint: TOKEN_ENDPOINT,
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(502);
  });
});

describe("DCR OAuth flow — complete", () => {
  let originalFetch: typeof fetch;
  let pendingState: string;

  beforeEach(async () => {
    await initPasskeyIfNeeded();
    originalFetch = globalThis.fetch;

    // Set up a pending dance the complete-step can finish.
    const startFetchSpy = makeRoutingFetch({
      "/oauth/registration": () =>
        new Response(JSON.stringify({ client_id: "completable-client" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    globalThis.fetch = startFetchSpy as unknown as typeof fetch;

    const startRes = await userControlFetch("/oauth-dcr/start", {
      method: "POST",
      body: JSON.stringify({
        mcpUrl: "https://dcr-complete-target.example.com/mcp",
        mcpName: "Complete Target",
        registrationEndpoint: REGISTRATION,
        authorizationEndpoint: AUTHORIZE,
        tokenEndpoint: TOKEN_ENDPOINT,
      }),
      headers: { "content-type": "application/json" },
    });
    const startBody = (await startRes.json()) as { state: string };
    pendingState = startBody.state;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("exchanges the auth code and persists tokens via the refresh-token path", async () => {
    type Captured = { url: string; body: string };
    const capturedHolder: { value: Captured | null } = { value: null };
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      let bodyStr = "";
      if (typeof init?.body === "string") bodyStr = init.body;
      else if (init?.body instanceof URLSearchParams) bodyStr = init.body.toString();
      capturedHolder.value = { url: requestUrl, body: bodyStr };
      return new Response(
        JSON.stringify({
          access_token: "ac-token-1",
          refresh_token: "rf-token-1",
          expires_in: 900,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await userControlFetch("/oauth-dcr/complete", {
      method: "POST",
      body: JSON.stringify({ state: pendingState, code: "auth-code-1" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; name: string; url: string };
    expect(body.name).toBe("Complete Target");
    expect(body.url).toBe("https://dcr-complete-target.example.com/mcp");

    // The token exchange request must include redirect_uri, code_verifier,
    // and grant_type=authorization_code.
    expect(capturedHolder.value?.url).toBe(TOKEN_ENDPOINT);
    expect(capturedHolder.value?.body).toContain("grant_type=authorization_code");
    expect(capturedHolder.value?.body).toContain("code=auth-code-1");
    expect(capturedHolder.value?.body).toContain("client_id=completable-client");
    expect(capturedHolder.value?.body).toContain("code_verifier=");
    // redirect_uri is URL-encoded so check the encoded form
    expect(capturedHolder.value?.body).toContain("redirect_uri=http%3A%2F%2F127.0.0.1%3A19876%2Fcallback");

    // The new config is listed with auth_type=refresh_token.
    const listRes = await userControlFetch("/mcp-configs");
    const list = (await listRes.json()) as { configs: Array<{ id: string; auth_type: string; url?: string }> };
    const entry = list.configs.find((c) => c.url === "https://dcr-complete-target.example.com/mcp");
    expect(entry).toBeDefined();
    expect(entry?.auth_type).toBe("refresh_token");
  });

  it("rejects an unknown state with 502", async () => {
    globalThis.fetch = (async () => {
      throw new Error("Should not be called");
    }) as unknown as typeof fetch;

    const res = await userControlFetch("/oauth-dcr/complete", {
      method: "POST",
      body: JSON.stringify({ state: "bogus-state", code: "any" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(502);
  });

  it("rejects when the token endpoint returns an error", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const res = await userControlFetch("/oauth-dcr/complete", {
      method: "POST",
      body: JSON.stringify({ state: pendingState, code: "bad-code" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(502);
  });
});
