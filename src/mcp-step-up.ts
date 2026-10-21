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
 * with the link. The model retries the call after the person replies.
 *
 * This module is pure (no DO, no SDK imports) so it unit-tests cheaply.
 * Probably belongs upstream in `agents` (MCPClientManager.callTool); delete
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

/**
 * Decide whether a failed OAuth tool call needs the person to re-authorize.
 * `authUrlBefore` is the provider's URL before the call: an unchanged URL is
 * left over from the original connect and must not be shown again (every
 * fresh `auth()` redirect has a new random `state`, so a real one differs).
 */
export function detectOAuthStepUp(input: {
  serverId: string;
  serverName?: string;
  error: unknown;
  authUrlBefore: string | undefined;
  authUrlAfter: string | undefined;
}): OAuthStepUp | null {
  const { error, authUrlBefore, authUrlAfter } = input;
  if (!authUrlAfter || authUrlAfter === authUrlBefore) return null;
  if (!isUnauthorizedError(error)) return null;
  try {
    const u = new URL(authUrlAfter);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  } catch {
    return null;
  }
  return {
    serverId: input.serverId,
    serverName: input.serverName,
    authUrl: authUrlAfter,
    scope: scopeFromAuthUrl(authUrlAfter),
  };
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
 * Tool result the model sees. `cardShown` = the session already raised the
 * needs-input card (top-level turns); otherwise (subagents) the model has
 * to pass the link on itself.
 */
export function stepUpToolResult(s: OAuthStepUp, cardShown: boolean): { error: string; authUrl: string; requiredScope?: string; next: string } {
  const who = s.serverName || s.serverId;
  return {
    error: `${who} refused this call until the person approves more access (OAuth re-authorization).`,
    authUrl: s.authUrl,
    requiredScope: s.scope,
    next: cardShown
      ? "The person has been shown an approval link (session marked 'needs input'). End your turn now with one short line asking them to approve and reply done. When they reply, retry this exact call once. If it fails the same way again, stop and say so."
      : "Give the person this authUrl and ask them to approve and reply done. When they reply, retry this exact call once. If it fails the same way again, stop and say so.",
  };
}
