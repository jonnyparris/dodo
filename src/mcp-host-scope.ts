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
 * A failed lookup at connect time reuses this isolate's last answer for the
 * host, however old, so a revocation this isolate has already seen holds
 * through a SharedIndex outage while the isolate stays warm. A cold isolate
 * has no earlier answer and allows the connection (fail open): the config
 * passed its check when it was written, and an outage should not take
 * every MCP tool down with it.
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
export async function lookupMcpHostScope(env: Env, hostname: string, timeoutMs?: number): Promise<McpHostScope> {
  const controller = new AbortController();
  const read = async (): Promise<McpHostScope> => {
    const res = await getSharedIndexStub(env).fetch(
      `https://shared-index/allowlist/check?scope=mcp&hostname=${encodeURIComponent(hostname)}`,
      { signal: controller.signal },
    );
    if (!res.ok) throw new Error(`allowlist check HTTP ${res.status}`);
    const body = (await res.json()) as { allowed?: boolean; listed?: boolean };
    return { allowed: body.allowed === true, listed: body.listed === true };
  };
  if (timeoutMs === undefined) return read();
  // The race bounds the whole read, body included; abort() is best effort.
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    read(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`allowlist check timed out after ${timeoutMs}ms`);
        controller.abort(err);
        reject(err);
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Per-isolate cache of connect-time answers. Session DOs re-check on every
 * turn and the OAuth hub on every tool call, so without it each turn pays
 * a round-trip to the single global SharedIndex. 30s bounds how long a
 * revocation (or a re-enable) takes to apply. Entries outlive the TTL so a
 * failed lookup can fall back to them. A failed lookup is remembered for
 * 5s so a slow or down SharedIndex costs each host one timeout per 5s, not
 * one per turn.
 */
const REVOKED_CACHE_TTL_MS = 30_000;
const FAILED_LOOKUP_TTL_MS = 5_000;
const LOOKUP_TIMEOUT_MS = 2_000;
/** Hosts come from user configs, so this is a backstop against unbounded growth. */
const MAX_CACHED_HOSTS = 1_000;
const revokedCache = new Map<string, { revoked: boolean; at: number; failedAt?: number }>();
/** One lookup per host at a time; concurrent callers share it. */
const inFlight = new Map<string, Promise<boolean>>();

/** Test hook: forget cached answers. */
export function clearMcpHostScopeCache(): void {
  revokedCache.clear();
  inFlight.clear();
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
 * False for unlisted hosts and unparseable URLs. A failed lookup returns
 * the last answer for the host, or false if there is none.
 */
export async function isMcpHostRevoked(env: Env, url: string): Promise<boolean> {
  const hostname = hostnameOf(url);
  if (!hostname) return false;
  const cached = revokedCache.get(hostname);
  const now = Date.now();
  if (cached && now - cached.at < REVOKED_CACHE_TTL_MS) return cached.revoked;
  if (cached?.failedAt !== undefined && now - cached.failedAt < FAILED_LOOKUP_TTL_MS) return cached.revoked;
  const pending = inFlight.get(hostname);
  if (pending) return pending;
  const lookup = refreshRevoked(env, hostname).finally(() => {
    if (inFlight.get(hostname) === lookup) inFlight.delete(hostname);
  });
  inFlight.set(hostname, lookup);
  return lookup;
}

async function refreshRevoked(env: Env, hostname: string): Promise<boolean> {
  try {
    const scope = await lookupMcpHostScope(env, hostname, LOOKUP_TIMEOUT_MS);
    const revoked = scope.listed && !scope.allowed;
    remember(hostname, { revoked, at: Date.now() });
    return revoked;
  } catch (err) {
    // Last known answer for this host, however old; else allow. Read after
    // the await: no other lookup for this host ran meanwhile (inFlight).
    const cached = revokedCache.get(hostname);
    const known = cached !== undefined && cached.at > 0;
    const revoked = known ? cached.revoked : false;
    remember(hostname, { revoked, at: known ? cached.at : 0, failedAt: Date.now() });
    log("warn", "mcp connect-time allowlist check failed", {
      hostname,
      fallback: known ? (revoked ? "last answer: revoked" : "last answer: allowed") : "no earlier answer: allowed",
      error: err instanceof Error ? err.message : String(err),
    });
    return revoked;
  }
}

function remember(hostname: string, entry: { revoked: boolean; at: number; failedAt?: number }): void {
  if (revokedCache.size >= MAX_CACHED_HOSTS && !revokedCache.has(hostname)) {
    // Evict the oldest allowed host; keep known revocations so the outage
    // fallback still has them. Only revocations left: evict the oldest.
    let victim: string | undefined;
    for (const [host, e] of revokedCache) {
      if (!e.revoked) { victim = host; break; }
    }
    revokedCache.delete(victim ?? revokedCache.keys().next().value!);
  }
  revokedCache.set(hostname, entry);
}

/** Error text shown in MCP status / tool errors for a revoked host. */
export function mcpHostRevokedMessage(url: string): string {
  const hostname = hostnameOf(url) ?? url;
  return `MCP is turned off for host "${hostname}" in the admin allowlist`;
}
