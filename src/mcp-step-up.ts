/**
 * Mid-session OAuth re-authorization for SDK-managed (OAuth) MCP servers.
 *
 * Since agents 0.34 the SDK does the hard part (cloudflare/agents#2658,
 * #2782): when a tool call needs more scope (`403 insufficient_scope`) or a
 * refresh fails, `MCPClientManager.callTool` moves the server to
 * `authenticating`, saves the new link as its `auth_url` and throws
 * `MCPAuthorizationRequiredError` with `authUrl`. The normal OAuth callback
 * then exchanges the code. During a scope step-up the server keeps working
 * on its current grant, until the hub restarts: the SDK then restores it as
 * `authenticating` with no tools, and every call returns the same link.
 *
 * What Dodo still adds (hub DO, `CodingAgent.callOAuthTool`):
 * - turns that error into a marker the session shows as an Approve access
 *   card (server id only; the owner's browser fetches the link, see
 *   `stepUpToolResult`),
 * - refuses a link whose authorization server is not the one that issued
 *   the grant (`isTrustedAuthUrl`; the SDK does not check). The SDK saves
 *   refused links too, so the hub only serves a link it parked
 *   (`CodingAgent.vettedStepUpLink`),
 * - strips a marker a server forges in a normal result (`stripStepUpMarker`),
 * - expires a park when its link dies (`STEP_UP_PARK_TTL_MS`, Dodo's
 *   `expireStepUpPark` schedule): the SDK keeps a dead link until someone
 *   reconnects the server.
 *
 * This module is pure (no DO, no SDK imports) so it unit-tests cheaply.
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
 * The card to show for an SDK `MCPAuthorizationRequiredError`, or null when
 * the link must not be shown (see `isTrustedAuthUrl`).
 */
export function stepUpFromAuthError(input: {
  serverId: string;
  serverName?: string;
  authUrl: string;
  grantIssuer?: string;
  linkIssuer?: string;
}): OAuthStepUp | null {
  const { authUrl } = input;
  if (!isTrustedAuthUrl(authUrl, { grantIssuer: input.grantIssuer, linkIssuer: input.linkIssuer })) return null;
  return { serverId: input.serverId, serverName: input.serverName, authUrl, scope: scopeFromAuthUrl(authUrl) };
}

/**
 * How long a step-up link can complete. Matches the agents OAuth provider's
 * state/verifier lifetime (STATE_EXPIRATION_MS, 10 min). The SDK keeps a
 * waiting server on its link after that, so Dodo reconnects it then.
 */
export const STEP_UP_PARK_TTL_MS = 10 * 60 * 1000;

/** A park past its link's lifetime: the link can't complete any more. */
export function parkExpired(park: { at: number }, now = Date.now()): boolean {
  return now - park.at >= STEP_UP_PARK_TTL_MS;
}

/** One step-up park: when, and the link the SDK saved as the server's auth_url. */
export interface StepUpPark {
  at: number;
  authUrl: string;
  /** Its expiry could not be scheduled: the next wake, or the next call with this link, tries again. */
  unscheduled?: true;
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
      if (park && typeof park.at === "number" && Number.isFinite(park.at) && typeof park.authUrl === "string") {
        out[k] = park.unscheduled === true ? { at: park.at, authUrl: park.authUrl, unscheduled: true } : { at: park.at, authUrl: park.authUrl };
      }
    }
    return out;
  } catch {
    return {};
  }
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
      ? "The person has been shown an Approve access button (session marked 'needs input'). Don't call request_user_input: the card is already up. End your turn now with one short line asking them to approve and reply done. When they reply, retry this exact call once. If it fails the same way again, stop and say so."
      : `Dodo could not show the person the Approve access button. Tell them ${who} needs them to approve more access before this call can work, then stop. Do not retry this call in this turn.`,
  };
}
