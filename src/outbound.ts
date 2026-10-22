import { WorkerEntrypoint } from "cloudflare:workers";
import { getSharedIndexStub } from "./auth";
import type { Env } from "./types";

export const OWNER_ID_HEADER = "x-dodo-owner-id";

/**
 * WorkerEntrypoint that intercepts all outbound fetch() calls from sandboxed
 * dynamic workers. Checks the hostname against the SharedIndex allowlist and
 * blocks requests to hosts that are not explicitly allowed.
 *
 * **Per-user token injection is currently disabled.** The duck-typed wrapper
 * that injected `x-dodo-owner-id` broke `globalOutbound` (workerd rejects
 * non-ServiceStub Fetchers). Three fix attempts (PR #52/#54/#55) all failed.
 * Sandbox fetches now run unauthenticated against remote hosts; codemode
 * authors must include their own auth headers when needed. The allowlist
 * is the only perimeter guard, which is intentional — the sandbox should
 * not have direct token access. Git operations remain authenticated because
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
 * workspace data to the attacker's account. That closes one route only:
 * any host on the SharedIndex allowlist still receives whatever headers
 * the sandbox sets.
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
      `https://shared-index/allowlist/check?hostname=${encodeURIComponent(hostname)}`,
    );
    const { allowed } = (await checkResponse.json()) as { allowed: boolean };

    if (!allowed) {
      return new Response(
        JSON.stringify({ error: `Outbound request to ${hostname} blocked — not in allowlist` }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }

    // Strip the owner-id header in case any caller still sets it — the
    // sandbox shouldn't be able to forge identity even if the wrapper
    // returns one day. The header carries no auth value today.
    const headers = new Headers(request.headers);
    headers.delete(OWNER_ID_HEADER);

    // Clone via the original request to preserve all properties (cf, signal, etc.)
    const outboundRequest = new Request(request, { headers });

    return fetch(outboundRequest);
  }
}
