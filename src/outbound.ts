import { WorkerEntrypoint } from "cloudflare:workers";
import { getSharedIndexStub } from "./auth";
import type { Env } from "./types";

export const OWNER_ID_HEADER = "x-dodo-owner-id";

/**
 * WorkerEntrypoint that intercepts all outbound fetch() calls from sandboxed
 * dynamic workers. Checks the hostname against the SharedIndex allowlist and
 * blocks requests to hosts that are not explicitly allowed.
 *
 * **Sandbox scope.** Each allowlist entry has two scopes: `mcp` (MCP server
 * configs may point there) and `sandbox` (this entrypoint lets sandbox code
 * reach it). Adding a host for an MCP server does not have to open it to
 * sandbox code: set `sandbox: false`. An entry can also limit sandbox
 * egress to some methods (`methods: ["GET", "HEAD"]`); other methods get a
 * 405. That closes the write routes stripping cannot see on read-only
 * hosts: a token in the query string or body, and unauthenticated writes.
 *
 * **Per-user token injection is currently disabled.** The duck-typed wrapper
 * that injected `x-dodo-owner-id` broke `globalOutbound` (workerd rejects
 * non-ServiceStub Fetchers). Three fix attempts (PR #52/#54/#55) all failed.
 * Sandbox fetches run without Dodo's tokens, and credential headers the
 * sandbox sets itself are stripped unless the host has `allowCredentials`
 * (see below). The sandbox should not have direct token access. Git operations remain authenticated because
 * tokens resolve in the parent DO via resolveRemoteToken() and are passed
 * directly to isomorphic-git.
 *
 * MCP catalog hosts get no bypass here. src/index.ts:isHostAllowed lets
 * catalog knownHosts skip the allowlist when a user adds or edits an MCP
 * server or starts OAuth. Every MCP connection then runs outside the
 * sandbox: OAuth through the Agents SDK MCP manager on the per-user hub
 * CodingAgent, static_headers and refresh_token through HttpMcpClient in
 * the session DO (or UserControl / ChatMonitorAgent). The sandbox never
 * talks to an MCP server, so it has no reason to reach those hosts. An earlier bypass did
 * let it, which meant a prompt-injected script could call, for example,
 * browser.mcp.cloudflare.com with an attacker's own bearer token and send
 * workspace data to the attacker's account.
 *
 * **Credential headers are stripped by default.** The same attack works on
 * any allowlisted host: a script calls api.github.com with an attacker's
 * own token and writes workspace data into the attacker's gist or repo.
 * So unless an admin has set `allowCredentials` on the host's allowlist
 * entry, `sanitizeEgressRequest` removes Authorization, Cookie and every
 * header whose name looks like a credential (token, key, secret, auth,
 * session, ...), plus any user:password in the URL. The sandbox never holds
 * Dodo's own secrets, so the only tokens it can send are ones that reached
 * the model's context: a token the user pasted, or one planted by injected
 * content. For a host that really needs sandbox auth, an admin opts it in:
 * `POST /api/allowlist {"hostname": "...", "allowCredentials": true}`.
 * The response carries `x-dodo-stripped-headers` so the agent can see why
 * an upstream answered 401.
 *
 * Not covered by stripping: tokens in the query string (e.g. GitLab
 * `?private_token=`) or the request body (Slack `token=`, OAuth
 * `client_secret`), and data sent without auth to a host that stores it
 * publicly. Use the method limit for read-only hosts, `sandbox: false`
 * for MCP-only hosts, and keep the sandbox scope short. A GET can still
 * leak data in its URL to a host that logs it.
 *
 * Configured as a self-referencing service binding (OUTBOUND) in wrangler.jsonc
 * and passed as `globalOutbound` to DynamicWorkerExecutor.
 */
export class AllowlistOutbound extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const hostname = url.hostname.toLowerCase();

    const stub = getSharedIndexStub(this.env);
    const checkResponse = await stub.fetch(
      `https://shared-index/allowlist/check?scope=sandbox&hostname=${encodeURIComponent(hostname)}`,
    );
    const { allowed, allowCredentials, methods } = (await checkResponse.json()) as {
      allowed: boolean;
      allowCredentials?: boolean;
      methods?: string[] | null;
    };

    if (!allowed) {
      return blocked(`Outbound request to ${hostname} blocked — not in allowlist`);
    }
    const method = request.method.toUpperCase();
    if (methods && !methods.includes(method)) {
      return blocked(`Outbound ${method} to ${hostname} blocked — host allows only ${methods.join(", ")}`, methods);
    }

    const { request: outboundRequest, stripped } = sanitizeEgressRequest(request, { allowCredentials: allowCredentials === true });
    if (stripped.length === 0) {
      const upstream = await fetch(outboundRequest);
      if (!upstream.headers.has(BLOCKED_HEADER)) return upstream;
      // Upstream must not be able to fake a Dodo policy block.
      const response = new Response(upstream.body, upstream);
      response.headers.delete(BLOCKED_HEADER);
      return response;
    }

    console.warn(
      JSON.stringify({ level: "warn", msg: "Sandbox egress: stripped credential headers", hostname, stripped }),
    );
    const upstream = await fetch(outboundRequest);
    const response = new Response(upstream.body, upstream);
    response.headers.delete(BLOCKED_HEADER);
    response.headers.set(STRIPPED_HEADERS_HEADER, stripped.join(", "));
    return response;
  }
}

/** Set on responses Dodo blocked itself, so the agent can tell them from upstream errors. */
export const BLOCKED_HEADER = "x-dodo-blocked";

function blocked(error: string, allowedMethods?: string[]): Response {
  const headers: Record<string, string> = { "content-type": "application/json", [BLOCKED_HEADER]: allowedMethods ? "method" : "host" };
  if (allowedMethods) headers.allow = allowedMethods.join(", ");
  return new Response(JSON.stringify({ error }), { status: allowedMethods ? 405 : 403, headers });
}

/** Response header listing the request headers AllowlistOutbound removed. */
export const STRIPPED_HEADERS_HEADER = "x-dodo-stripped-headers";

/** Exact header names that carry credentials. */
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "cookie"]);

/** Names that match the patterns below but carry no credential. */
const NON_CREDENTIAL_HEADERS = new Set(["sec-websocket-key", "idempotency-key", "x-idempotency-key"]);

/**
 * Header names that look like credentials. Deliberately broad: a missed
 * custom auth header (GitLab's `PRIVATE-TOKEN`, `X-Api-Key`, ...) is the
 * whole attack, while a stripped harmless header only costs an admin
 * opt-in. Substrings for unambiguous words, whole words for short ones.
 * `auth` matches unless it is the start of `author` (but `authoriz` /
 * `authoris` still match), so `x-authorization` is caught and
 * `author-name` is not.
 */
const CREDENTIAL_HEADER_PATTERN =
  /token|secret|passw|passphrase|pwd|key|cred|cookie|sess(ion|id)|signature|auth(?!or(?!i[sz]))|(^|[-_])(pass|pat|sid|sig|otp|totp|jwt|bearer)([-_]|$)/;

export function isCredentialHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (NON_CREDENTIAL_HEADERS.has(lower)) return false;
  return CREDENTIAL_HEADERS.has(lower) || CREDENTIAL_HEADER_PATTERN.test(lower);
}

/**
 * Build the request AllowlistOutbound forwards. Always removes the
 * owner-id header (the sandbox must not forge identity). Unless
 * allowCredentials is true, also removes credential headers and URL
 * userinfo. Returns the names of the credential headers it removed.
 */
export function sanitizeEgressRequest(
  request: Request,
  options: { allowCredentials: boolean },
): { request: Request; stripped: string[] } {
  const headers = new Headers(request.headers);
  headers.delete(OWNER_ID_HEADER);

  const stripped: string[] = [];
  let url = request.url;
  if (!options.allowCredentials) {
    headers.forEach((_value, name) => {
      if (isCredentialHeader(name)) stripped.push(name);
    });
    for (const name of stripped) headers.delete(name);
    const parsed = new URL(request.url);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      url = parsed.toString();
      stripped.push("url-userinfo");
    }
  }

  // Clone via the original request to preserve all properties (cf, signal, etc.).
  // redirect: "manual" hands any 3xx back to the sandbox, so the next hop
  // re-enters AllowlistOutbound for a fresh allowlist check and strip,
  // instead of this fetch following it to an unlisted host.
  return { request: new Request(url, new Request(request, { headers, redirect: "manual" })), stripped };
}
