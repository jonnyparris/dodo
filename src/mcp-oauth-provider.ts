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
 */
import { DurableObjectOAuthClientProvider } from "agents";

type SaveTokensArgs = Parameters<DurableObjectOAuthClientProvider["saveTokens"]>;

export class DodoOAuthClientProvider extends DurableObjectOAuthClientProvider {
  /**
   * Set when the SDK reads the PKCE verifier: only the authorization-code
   * exchange does (a refresh never does). The next saveTokens is that
   * exchange's result.
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

  override async saveTokens(...[tokens, context]: SaveTokensArgs): Promise<void> {
    const exchange = this.codeExchangeInFlight;
    this.codeExchangeInFlight = false;
    await super.saveTokens(tokens, context);
    if (exchange && typeof tokens.issuer === "string") {
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
