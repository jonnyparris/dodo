/**
 * MCP host scope checks against the SharedIndex host allowlist.
 *
 * Two questions, two rules:
 *
 * - Config time (add/edit/test a config, start OAuth): is the host allowed?
 *   Listed with `mcp` on, or a catalog host an admin hasn't turned off.
 *   See `isHostAllowed` in src/index.ts.
 *
 * - Connect time (session DO gatekeepers, the OAuth hub, the chat monitor):
 *   has an admin turned `mcp` off for this host? Only an explicit
 *   `mcp: off` entry blocks. An unlisted host keeps connecting, because
 *   configs on unlisted hosts are legitimate: the Dodo MCP `add_mcp_config`
 *   tool skips the allowlist on purpose, and removing a host from the list
 *   has never broken existing configs.
 *
 * A failed lookup at connect time allows the connection (fail open). The
 * config passed its check when it was written; a SharedIndex outage should
 * not take every MCP tool down with it. The cost is that a revocation
 * doesn't apply during an outage.
 */
import { getSharedIndexStub } from "./auth";
import { log } from "./logger";
import type { Env } from "./types";

export interface McpHostScope {
  /** Listed with mcp on. */
  allowed: boolean;
  /** Listed at all. */
  listed: boolean;
}

/** One SharedIndex lookup for `scope=mcp`. Throws when SharedIndex fails. */
export async function lookupMcpHostScope(env: Env, hostname: string): Promise<McpHostScope> {
  const res = await getSharedIndexStub(env).fetch(
    `https://shared-index/allowlist/check?scope=mcp&hostname=${encodeURIComponent(hostname)}`,
  );
  if (!res.ok) throw new Error(`allowlist check HTTP ${res.status}`);
  const body = (await res.json()) as { allowed?: boolean; listed?: boolean };
  return { allowed: body.allowed === true, listed: body.listed === true };
}

/**
 * Per-isolate cache of connect-time answers. Session DOs re-check on every
 * turn and the OAuth hub on every tool call, so without it each turn pays
 * a round-trip to the single global SharedIndex. 30s bounds how long a
 * revocation (or a re-enable) takes to apply. Failed lookups are not cached.
 */
const REVOKED_CACHE_TTL_MS = 30_000;
const revokedCache = new Map<string, { revoked: boolean; at: number }>();

/** Test hook: forget cached answers. */
export function clearMcpHostScopeCache(): void {
  revokedCache.clear();
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when an admin has explicitly turned `mcp` off for this URL's host.
 * False for unlisted hosts, unparseable URLs and failed lookups.
 */
export async function isMcpHostRevoked(env: Env, url: string): Promise<boolean> {
  const hostname = hostnameOf(url);
  if (!hostname) return false;
  const cached = revokedCache.get(hostname);
  if (cached && Date.now() - cached.at < REVOKED_CACHE_TTL_MS) return cached.revoked;
  try {
    const scope = await lookupMcpHostScope(env, hostname);
    const revoked = scope.listed && !scope.allowed;
    revokedCache.set(hostname, { revoked, at: Date.now() });
    return revoked;
  } catch (err) {
    log("warn", "mcp connect-time allowlist check failed; allowing", {
      hostname,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Error text shown in MCP status / tool errors for a revoked host. */
export function mcpHostRevokedMessage(url: string): string {
  const hostname = hostnameOf(url) ?? url;
  return `MCP is turned off for host "${hostname}" in the admin allowlist`;
}
