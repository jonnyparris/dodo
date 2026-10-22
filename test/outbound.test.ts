/**
 * Regression tests for the codemode `globalOutbound` wiring.
 *
 * History:
 *   - PR #52 wrapped OUTBOUND with a `LOADER.get()` proxy → reverted in #53
 *     (entrypoints to dynamic workers can't be transferred to other workers).
 *   - PR #54 used per-call props via ctx.exports → reverted in #55
 *     (callable signature only available in main fetch handler, not DOs).
 *   - This commit removes the duck-typed wrapper entirely. globalOutbound is
 *     now the raw `env.OUTBOUND` ServiceStub, which workerd accepts. The
 *     allowlist is still enforced by AllowlistOutbound; per-user token
 *     injection for raw sandbox `fetch()` is intentionally unavailable so
 *     the sandbox has no direct access to user secrets.
 *
 * It also checks the sandbox egress policy: MCP catalog hosts must go
 * through the SharedIndex allowlist like any other host.
 *
 * The failure mode this guards against: passing a plain `{ fetch: ... }`
 * object cast `as Fetcher` to `DynamicWorkerExecutor`'s `globalOutbound`
 * fails at WorkerCode construction time with:
 *
 *   Incorrect type for the 'globalOutbound' field on 'WorkerCode':
 *   the provided value is not of type 'Fetcher'.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getSharedIndexStub } from "../src/auth";
import { AllowlistOutbound, isCredentialHeader, OWNER_ID_HEADER, sanitizeEgressRequest, STRIPPED_HEADERS_HEADER } from "../src/outbound";
import { MCP_CATALOG } from "../src/mcp-catalog";
import type { Env } from "../src/types";

describe("OWNER_ID_HEADER", () => {
  it("constant is preserved for compatibility / future reuse", () => {
    expect(OWNER_ID_HEADER).toBe("x-dodo-owner-id");
  });
});

describe("AllowlistOutbound — MCP catalog hosts get no sandbox bypass", () => {
  // Goes through the real OUTBOUND service binding (the same Fetcher the
  // codemode sandbox gets as globalOutbound). The test SharedIndex has an
  // empty allowlist, so a 403 proves no catalog host skips the check.
  // MCP connections run outside the sandbox (OAuth on the per-user hub
  // CodingAgent, the rest via HttpMcpClient), so it never needs these.
  it("returns 403 for every catalog knownHost, OAuth or not", async () => {
    const e = env as Env;
    if (!e.OUTBOUND) throw new Error("OUTBOUND binding missing");
    const hosts = MCP_CATALOG.flatMap((x) => x.knownHosts ?? []);
    expect(hosts).toContain("browser.mcp.cloudflare.com");
    // Precondition: none of these hosts is on the admin allowlist, so a 200
    // can only mean a bypass, not test setup.
    const list = await getSharedIndexStub(e).fetch("https://shared-index/allowlist");
    const allowlisted = JSON.stringify(await list.json());
    for (const host of hosts) expect(allowlisted, host).not.toContain(`"${host}"`);
    for (const host of hosts) {
      const res = await e.OUTBOUND.fetch(`https://${host}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer attacker-token" },
        body: "{}",
      });
      expect(res.status, host).toBe(403);
      expect(await res.text()).toContain("not in allowlist");
    }
  });
});

describe("sanitizeEgressRequest", () => {
  const attackerHeaders = {
    authorization: "Bearer attacker-token",
    "proxy-authorization": "Basic eA==",
    cookie: "session=attacker",
    "x-api-key": "attacker-key",
    "PRIVATE-TOKEN": "glpat-attacker",
    "x-goog-api-key": "attacker",
    "x-amz-security-token": "attacker",
    "x-auth-token": "attacker",
    "x-session-id": "attacker",
    [OWNER_ID_HEADER]: "forged-owner",
  };
  const harmlessHeaders = {
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": "dodo-test",
    "x-github-api-version": "2022-11-28",
    "if-none-match": "\"etag\"",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  };

  it("strips credential headers and URL userinfo by default", async () => {
    const req = new Request("https://user:pass@api.github.com/gists", {
      method: "POST",
      headers: { ...attackerHeaders, ...harmlessHeaders },
      body: JSON.stringify({ files: { "x.txt": { content: "workspace data" } } }),
    });
    const { request: out, stripped } = sanitizeEgressRequest(req, { allowCredentials: false });

    for (const name of Object.keys(attackerHeaders)) expect(out.headers.has(name), name).toBe(false);
    for (const [name, value] of Object.entries(harmlessHeaders)) expect(out.headers.get(name), name).toBe(value);
    expect(new URL(out.url).username).toBe("");
    expect(new URL(out.url).password).toBe("");
    expect(out.url).toBe("https://api.github.com/gists");
    expect(out.method).toBe("POST");
    expect(out.redirect).toBe("manual");
    expect(await out.text()).toContain("workspace data");
    // Owner-id is always removed but is not a credential, so not reported.
    expect(stripped).not.toContain(OWNER_ID_HEADER);
    expect(stripped).toContain("authorization");
    expect(stripped).toContain("private-token");
    expect(stripped).toContain("url-userinfo");
  });

  it("keeps credentials for hosts with allowCredentials, still drops owner-id", () => {
    const req = new Request("https://api.github.com/user", { headers: attackerHeaders });
    const { request: out, stripped } = sanitizeEgressRequest(req, { allowCredentials: true });
    expect(stripped).toEqual([]);
    expect(out.headers.get("authorization")).toBe("Bearer attacker-token");
    expect(out.headers.get("x-api-key")).toBe("attacker-key");
    expect(out.headers.has(OWNER_ID_HEADER)).toBe(false);
  });

  it("reports nothing for a request without credentials", () => {
    const req = new Request("https://raw.githubusercontent.com/a/b/main/README.md", { headers: harmlessHeaders });
    expect(sanitizeEgressRequest(req, { allowCredentials: false }).stripped).toEqual([]);
  });

  it("isCredentialHeader keeps common non-auth headers", () => {
    for (const name of ["accept", "accept-encoding", "content-length", "keep-alive", "x-github-api-version", "author-name", "x-request-id", "idempotency-key", "sec-websocket-key"]) {
      expect(isCredentialHeader(name), name).toBe(false);
    }
    for (const name of [
      "Authorization", "x-authorization", "x-forwarded-authorization", "x-authorisation", "X-API-KEY", "apikey",
      "x-accesskey", "x-clientkey", "x-sessid", "x-passphrase", "x-pass", "x-pat", "x-csrf-token",
      "x-client-secret", "x-hub-signature", "x-password", "x-pwd", "x-cred", "x-creds", "x-otp", "x-totp", "x-sig",
    ]) {
      expect(isCredentialHeader(name), name).toBe(true);
    }
  });
});

describe("AllowlistOutbound.fetch — credential stripping end to end", () => {
  // Calls the real entrypoint with the real SharedIndex. Only the final
  // upstream fetch is stubbed, so the test needs no network.
  const HOST = "egress-creds-test.example.org";
  const post = (body: Record<string, unknown>) =>
    getSharedIndexStub(env as Env).fetch("https://shared-index/allowlist", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await getSharedIndexStub(env as Env).fetch(`https://shared-index/allowlist/${HOST}`, { method: "DELETE" });
  });

  async function send(): Promise<{ res: Response; upstream: Request }> {
    let upstream: Request | undefined;
    vi.stubGlobal("fetch", async (req: Request) => {
      upstream = req;
      return new Response("upstream body", { status: 401, headers: { "x-upstream": "1" } });
    });
    const outbound = new AllowlistOutbound(createExecutionContext(), env as Env);
    const res = await outbound.fetch(
      new Request(`https://${HOST}/data`, {
        method: "POST",
        headers: { authorization: "Bearer attacker", "x-authorization": "Bearer attacker", accept: "application/json" },
        body: "workspace data",
      }),
    );
    if (!upstream) throw new Error("upstream fetch not called");
    return { res, upstream };
  }

  it("strips credentials for a host without allowCredentials and reports them", async () => {
    await post({ hostname: HOST });
    const { res, upstream } = await send();
    expect(upstream.headers.has("authorization")).toBe(false);
    expect(upstream.headers.has("x-authorization")).toBe(false);
    expect(upstream.headers.get("accept")).toBe("application/json");
    expect(await upstream.text()).toBe("workspace data");
    expect(res.status).toBe(401);
    expect(res.headers.get("x-upstream")).toBe("1");
    expect(res.headers.get(STRIPPED_HEADERS_HEADER)).toBe("authorization, x-authorization");
    expect(await res.text()).toBe("upstream body");
  });

  it("forwards credentials unchanged for an opted-in host", async () => {
    await post({ hostname: HOST, allowCredentials: true });
    const { res, upstream } = await send();
    expect(upstream.headers.get("authorization")).toBe("Bearer attacker");
    expect(res.headers.has(STRIPPED_HEADERS_HEADER)).toBe(false);
    // A redirect is handed back to the sandbox, not followed here.
    expect(upstream.redirect).toBe("manual");
  });
});
