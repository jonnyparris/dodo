/**
 * Mid-session OAuth re-authorization for SDK-managed (OAuth) MCP servers.
 *
 * The problem (agents 0.28 + @modelcontextprotocol/client 2.3):
 *
 * - A tool call gets `403 insufficient_scope` (step-up, e.g. the Cloudflare
 *   API MCP at mcp.cloudflare.com granted with Minimal/Read only), or a 401
 *   whose refresh fails. The client transport runs `auth()`, which builds a
 *   new authorize URL (union of granted + challenged scopes), stores it on
 *   the DO OAuth provider and throws `UnauthorizedError`.
 * - `MCPClientManager` only turns that into `authenticating` + `authUrl` at
 *   connect time. Mid-session, `callTool` just throws: nobody sees the URL.
 * - Worse, if the person did open it, the OAuth callback finds the
 *   connection `ready`, treats the callback as stale, and drops the code.
 *   The new scopes are never saved.
 *
 * The fix (hub DO, `CodingAgent.callOAuthTool`): when a call fails with an
 * unauthorized error and the provider holds a *new* authorize URL, move the
 * connection to `authenticating` and persist the URL (same as the connect
 * path), so the existing callback route finishes the exchange and
 * reconnects. Then return a marker the session turns into a needs-input card
 * (server id only; the owner's browser fetches the link, see
 * `stepUpToolResult`). The model retries the call after the person replies.
 * A restart while parked is handled by `planStepUpRecovery`.
 *
 * This module is pure (no DO, no SDK imports) so it unit-tests cheaply.
 * Belongs upstream in `agents` (MCPClientManager.callTool, filed as
 * https://github.com/cloudflare/agents/issues/2658); delete
 * once the SDK surfaces mid-session auth itself.
 */

export const OAUTH_STEP_UP_KEY = "dodoOAuthReauth" as const;

export interface OAuthStepUp {
  serverId: string;
  serverName?: string;
  authUrl: string;
  /** Scopes the authorize URL asks for (granted ∪ challenged), if any. */
  scope?: string;
}

export type OAuthStepUpMarker = { [OAUTH_STEP_UP_KEY]: OAuthStepUp };

/**
 * Same test agents uses at connect time (`isUnauthorized` in
 * client-*.js): HTTP 401 status, `UnauthorizedError`, or an
 * "Unauthorized"/"401" message, also through `cause`.
 */
export function isUnauthorizedError(err: unknown, depth = 0): boolean {
  if (!err || depth > 3) return false;
  if (typeof err === "object") {
    const e = err as { name?: unknown; status?: unknown; code?: unknown; data?: { status?: unknown; cause?: unknown }; cause?: unknown; message?: unknown };
    if (e.name === "UnauthorizedError") return true;
    if (e.status === 401 || e.data?.status === 401) return true;
    const cause = e.cause ?? e.data?.cause;
    if (cause && cause !== err && isUnauthorizedError(cause, depth + 1)) return true;
    const msg = typeof e.message === "string" ? e.message : "";
    return msg.includes("Unauthorized") || msg.includes("401");
  }
  const msg = String(err);
  return msg.includes("Unauthorized") || msg.includes("401");
}

/** `scope` query parameter of an authorize URL, or undefined. */
export function scopeFromAuthUrl(authUrl: string): string | undefined {
  try {
    return new URL(authUrl).searchParams.get("scope") ?? undefined;
  } catch {
    return undefined;
  }
}

/** Origin of a URL for logs (never log the full link: it carries state). */
export function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Hosts where a plain-http authorize URL is fine (local dev servers). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackHttp(u: URL): boolean {
  return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
}

/**
 * SEP-2352 issuer comparison, same rule as the MCP client SDK
 * (`issuersMatch`): equal, or equal up to one trailing slash.
 */
export function issuersMatch(a: string, b: string): boolean {
  return a === b || (a.endsWith("/") && a.slice(0, -1) === b) || (b.endsWith("/") && b.slice(0, -1) === a);
}

/**
 * Is `authUrl` a link we are willing to show as an Approve access button?
 * - https only. Plain http only for loopback, and only when the grant's
 *   own issuer is loopback too (local dev), so a production server can't
 *   point the card at http://localhost.
 * - The authorization server behind the link (`linkIssuer`, from the
 *   discovery the failed `auth()` just saved) must be the one that issued
 *   the current grant (`grantIssuer`, see below). That
 *   stops a server from swapping `authorization_servers` mid-session to
 *   send the person to another host. Its endpoints may live on any https
 *   origin: the metadata comes from the issuer itself.
 * `grantIssuer` is Dodo's pin from the last code exchange
 * (`DodoOAuthClientProvider`), not the SDK's stamp on the tokens: the SDK
 * stamps pre-upgrade tokens with whatever AS its next auth() discovers.
 * No grant issuer (no code exchange since the pin shipped) → refused until
 * the server is reconnected.
 */
export function isTrustedAuthUrl(authUrl: string, issuers: { grantIssuer?: string; linkIssuer?: string } = {}): boolean {
  let u: URL;
  try {
    u = new URL(authUrl);
  } catch {
    return false;
  }
  const { grantIssuer, linkIssuer } = issuers;
  if (!grantIssuer || !linkIssuer || !issuersMatch(grantIssuer, linkIssuer)) return false;
  if (u.protocol !== "https:") {
    if (!isLoopbackHttp(u)) return false;
    try {
      if (!isLoopbackHttp(new URL(grantIssuer))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Decide whether a failed OAuth tool call needs the person to re-authorize.
 * `authUrlBefore` is the provider's URL before the call: an unchanged URL is
 * left over from the original connect and must not be shown again (every
 * fresh `auth()` redirect has a new random `state`, so a real one differs).
 * `grantIssuer` / `linkIssuer`: see `isTrustedAuthUrl`.
 */
export function detectOAuthStepUp(input: {
  serverId: string;
  serverName?: string;
  error: unknown;
  authUrlBefore: string | undefined;
  authUrlAfter: string | undefined;
  grantIssuer?: string;
  linkIssuer?: string;
}): OAuthStepUp | null {
  const { error, authUrlBefore, authUrlAfter } = input;
  if (!authUrlAfter || authUrlAfter === authUrlBefore) return null;
  if (!isUnauthorizedError(error)) return null;
  if (!isTrustedAuthUrl(authUrlAfter, { grantIssuer: input.grantIssuer, linkIssuer: input.linkIssuer })) return null;
  return {
    serverId: input.serverId,
    serverName: input.serverName,
    authUrl: authUrlAfter,
    scope: scopeFromAuthUrl(authUrlAfter),
  };
}

/**
 * How long a step-up park may outlive a hub restart. Matches the agents
 * OAuth provider's state/verifier lifetime (STATE_EXPIRATION_MS, 10 min):
 * after that the approval link can't complete anyway.
 */
export const STEP_UP_PARK_TTL_MS = 10 * 60 * 1000;

/** One step-up park: when, and the link it saved as the server's auth_url. */
export interface StepUpPark {
  at: number;
  authUrl: string;
}

/** Parks by serverId, kept in hub metadata (never shown to sessions). */
export type StepUpParks = Record<string, StepUpPark>;

export function parseStepUpParks(raw: string | null): StepUpParks {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: StepUpParks = {};
    for (const [k, p] of Object.entries(v as Record<string, unknown>)) {
      const park = p as Partial<StepUpPark> | null;
      if (park && typeof park.at === "number" && Number.isFinite(park.at) && typeof park.authUrl === "string") out[k] = { at: park.at, authUrl: park.authUrl };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * What to do with each step-up park when the hub DO wakes. agents 0.28
 * `restoreConnectionsFromStorage` restores any server with a saved
 * `auth_url` as `authenticating` and never connects it, so it has no
 * tools: ignoring the card would cut off access the old grant still gives.
 * - `drop`: the server's auth_url is no longer the parked link (approved,
 *   removed, or the SDK started its own re-auth). Not ours: leave it.
 * - `unpark`: the park is older than the link lifetime. Clear auth_url and
 *   reconnect with the old grant.
 * - `keep`: the link can still complete. Reconnect with the old grant for
 *   the tools, then park again so the callback still exchanges the code.
 */
export function planStepUpRecovery(
  parks: StepUpParks,
  authUrlByServer: Record<string, string | null | undefined>,
  now: number,
): Array<{ serverId: string; action: "drop" | "unpark" | "keep" }> {
  return Object.entries(parks).map(([serverId, park]) => {
    if (!authUrlByServer[serverId] || authUrlByServer[serverId] !== park.authUrl) return { serverId, action: "drop" as const };
    return { serverId, action: now - park.at >= STEP_UP_PARK_TTL_MS ? ("unpark" as const) : ("keep" as const) };
  });
}

/**
 * Drop a server-supplied `dodoOAuthReauth` key from a real tool result.
 * The session treats that key as "show an Approve access card with this
 * link", so a malicious MCP server could otherwise forge the card in-band.
 * Only the hub's catch path should create the marker. This does not make
 * the link trustworthy: on the catch path the URL still comes from the
 * server's own OAuth discovery.
 */
export function stripStepUpMarker(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  if (!(OAUTH_STEP_UP_KEY in result)) return result;
  const { [OAUTH_STEP_UP_KEY]: _forged, ...rest } = result as Record<string, unknown>;
  return rest;
}

export function isOAuthStepUpMarker(value: unknown): value is OAuthStepUpMarker {
  if (!value || typeof value !== "object") return false;
  const inner = (value as Record<string, unknown>)[OAUTH_STEP_UP_KEY];
  if (!inner || typeof inner !== "object") return false;
  const s = inner as Partial<OAuthStepUp>;
  return typeof s.serverId === "string" && typeof s.authUrl === "string";
}

/** One line for the needs-input card. The UI renders the link as a button. */
export function stepUpReason(s: OAuthStepUp): string {
  const who = s.serverName || s.serverId;
  const scopes = s.scope ? ` (asks for: ${s.scope})` : "";
  return `${who} needs you to approve more access${scopes}. Open the approval link, approve, then reply "done".`;
}

/**
 * Tool result the model sees. It never carries the approval link: tool
 * results are saved in the transcript, which read-only share viewers can
 * read, and anyone holding the link can finish OAuth for the owner's hub.
 * The owner opens it from the needs-input card (`oauthServerId`, resolved
 * through the owner-scoped GET /api/mcp/oauth-servers).
 * `cardShown` = the session raised that card. If raising it failed, the
 * model just reports it: reconnecting from Settings would not help, since
 * that flow asks only for the server's default scopes.
 */
export function stepUpToolResult(s: OAuthStepUp, cardShown: boolean): { error: string; requiredScope?: string; next: string } {
  const who = s.serverName || s.serverId;
  return {
    error: `${who} refused this call until the person approves more access (OAuth re-authorization).`,
    requiredScope: s.scope,
    next: cardShown
      ? "The person has been shown an Approve access button (session marked 'needs input'). End your turn now with one short line asking them to approve and reply done. When they reply, retry this exact call once. If it fails the same way again, stop and say so."
      : `Dodo could not show the person the Approve access button. Tell them ${who} needs them to approve more access before this call can work, then stop. Do not retry this call in this turn.`,
  };
}
