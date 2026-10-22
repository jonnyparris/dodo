/**
 * OAuth client provider for the hub DO's MCP servers. Same storage as the
 * agents default (`DurableObjectOAuthClientProvider`), plus a Dodo-owned
 * issuer pin for step-up (src/mcp-step-up.ts).
 *
 * Why not trust the SDK's issuer stamp on the saved tokens? Tokens saved
 * before the MCP client SDK stamped issuers (SEP-2352, client 2.x) get
 * stamped by their next `auth()` run with whatever authorization server
 * that run discovered. If the MCP server had swapped `authorization_servers`
 * by then, the stamp names the swapped server. Later, nothing tells that
 * stamp apart from a real one.
 *
 * So the pin is written only when a code exchange saves tokens: the person
 * approved at that authorization server, and the SDK checked its issuer
 * against the discovery recorded when the link was made. A refresh or the
 * SDK's upgrade stamp never writes it. A grant with no pin (every grant
 * from before this provider) gets no Approve access card until the server
 * is connected again from Settings. Removing a server clears every key under
 * its prefix (`clearServerStorage`), pin included.
 *
 * Accepted risk, not handled here: for a grant still unstamped (saved before
 * the SDK upgrade and unused since), the first non-forced auth() after the
 * MCP server swaps `authorization_servers` stamps it with the swapped AS and
 * sends its refresh token there (client index.mjs, auth()). Blocking that
 * means dropping the refresh token on the stamp save, which forces every
 * such grant to reconnect. Not done: the MCP server already receives the
 * access token on every call, and few such grants remain since agents 0.28
 * (2026-10-17) stamped every grant used since. Stamped grants are safe: the
 * SDK drops a grant whose stamp names another AS before refreshing.
 */
import { DurableObjectOAuthClientProvider } from "agents";

type SaveTokensArgs = Parameters<DurableObjectOAuthClientProvider["saveTokens"]>;

export class DodoOAuthClientProvider extends DurableObjectOAuthClientProvider {
  /**
   * Set when the SDK reads the PKCE verifier: only the authorization-code
   * exchange does, right before its token request. Cleared by any tokens()
   * read: the exchange doesn't read tokens before saving, while the refresh
   * and upgrade-stamp paths do. So a failed exchange can't leave it set for
   * a later save. A parallel read clearing it early skips the pin, which
   * fails closed (the previous pin, if any, stays).
   */
  private codeExchangeInFlight = false;

  /** Per server, not per client: a re-registration must not move it. */
  private issuerPinKey(): string {
    return `/${this.clientName}/${this.serverId}/dodo_issuer_pin`;
  }

  override async codeVerifier(): Promise<string> {
    const verifier = await super.codeVerifier();
    this.codeExchangeInFlight = true;
    return verifier;
  }

  override async tokens(...args: Parameters<DurableObjectOAuthClientProvider["tokens"]>): ReturnType<DurableObjectOAuthClientProvider["tokens"]> {
    this.codeExchangeInFlight = false;
    return super.tokens(...args);
  }

  override async saveTokens(...[tokens, context]: SaveTokensArgs): Promise<void> {
    const exchange = this.codeExchangeInFlight;
    // super.tokens: our tokens() override would clear the flag (already read).
    const prev = exchange ? await super.tokens().catch(() => undefined) : undefined;
    this.codeExchangeInFlight = false;
    await super.saveTokens(tokens, context);
    // A real exchange always brings a new access token; the SDK's upgrade
    // stamp re-saves the same one.
    if (exchange && typeof tokens.issuer === "string" && tokens.access_token !== prev?.access_token) {
      await this.storage.put(this.issuerPinKey(), { issuer: tokens.issuer, at: Date.now() });
    }
  }

  /**
   * Authorization server of the last code exchange for this server, or
   * undefined (none since this provider shipped, or storage failed: callers
   * treat both as "no trusted issuer").
   */
  async pinnedIssuer(): Promise<string | undefined> {
    try {
      const pin = (await this.storage.get(this.issuerPinKey())) as { issuer?: unknown } | undefined;
      return typeof pin?.issuer === "string" ? pin.issuer : undefined;
    } catch {
      return undefined;
    }
  }
}
