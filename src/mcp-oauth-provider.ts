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
 * "A code exchange" = a saveTokens inside `runWithCodeVerifierState`, which
 * agents' OAuth callback handler wraps around `completeAuthorization`. An
 * async context, not a flag on this (shared, long-lived) instance, so a
 * refresh running in parallel can never save inside it. agents'
 * `connectToServer({ reconnect: { oauthCode } })` exchanges without that
 * wrapper; Dodo doesn't use it, and it would just leave no pin (no card).
 *
 * Accepted risk, not handled here: for a grant still unstamped (saved before
 * the SDK upgrade and unused since), the first non-forced auth() after the
 * MCP server swaps `authorization_servers` stamps it with the swapped AS and
 * sends its refresh token there (client index.mjs, auth()). Every later
 * refresh goes there too: the grant is now stamped for that AS. Blocking it
 * means dropping the refresh token on the stamp save, which forces every
 * such grant to reconnect. Not done: the MCP server already receives the
 * access token on every call, and few such grants remain since agents 0.28
 * (2026-10-17) stamped every grant used since. Grants stamped before a swap
 * are safe: the SDK drops a grant whose stamp names another AS before
 * refreshing. Either way, step-up trusts only the pin.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { DurableObjectOAuthClientProvider } from "agents";
import { log } from "./logger";

type SaveTokensArgs = Parameters<DurableObjectOAuthClientProvider["saveTokens"]>;

/** Present only inside an OAuth callback's code exchange. */
const codeExchange = new AsyncLocalStorage<true>();

export class DodoOAuthClientProvider extends DurableObjectOAuthClientProvider {
  /** Per server, not per client: a re-registration must not move it. */
  private issuerPinKey(): string {
    return `/${this.clientName}/${this.serverId}/dodo_issuer_pin`;
  }

  override async runWithCodeVerifierState<T>(state: string, callback: () => Promise<T>): Promise<T> {
    return super.runWithCodeVerifierState(state, () => codeExchange.run(true, callback));
  }

  override async saveTokens(...[tokens, context]: SaveTokensArgs): Promise<void> {
    await super.saveTokens(tokens, context);
    if (codeExchange.getStore() !== true || typeof tokens.issuer !== "string") return;
    try {
      await this.storage.put(this.issuerPinKey(), { issuer: tokens.issuer, at: Date.now() });
    } catch (err) {
      // The exchange itself worked; without a pin the next step-up just gets
      // no card until a reconnect.
      log("warn", "oauth mcp issuer pin write failed", { serverId: this.serverId, error: err instanceof Error ? err.message : String(err) });
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
