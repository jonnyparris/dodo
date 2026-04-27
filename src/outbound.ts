import { WorkerEntrypoint } from "cloudflare:workers";
import { getSharedIndexStub } from "./auth";
import { OWNER_ID_HEADER } from "./executor";
import { MCP_CATALOG } from "./mcp-catalog";
import type { Env } from "./types";

// Catalog knownHosts are implicitly allowed at runtime so codemode fetches
// to (e.g.) `api.githubcopilot.com` don't require an admin to also add
// the host to the SharedIndex allowlist. Mirrors the config-time check
// in src/index.ts:isHostAllowed. (audit follow-up F6)
const CATALOG_HOSTNAMES = new Set(
  MCP_CATALOG.flatMap((entry) => entry.knownHosts ?? []).map((h) => h.toLowerCase()),
);

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
 * Configured as a self-referencing service binding (OUTBOUND) in wrangler.jsonc
 * and passed as `globalOutbound` to DynamicWorkerExecutor.
 */
export class AllowlistOutbound extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const hostname = url.hostname.toLowerCase();

    // Static catalog hosts are always allowed — admins shouldn't have to
    // duplicate well-known MCP catalog entries into the SharedIndex
    // allowlist for runtime sandbox fetches. (audit follow-up F6)
    if (!CATALOG_HOSTNAMES.has(hostname)) {
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
