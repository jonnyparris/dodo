/**
 * OAuth client provider for the hub DO's MCP servers. Same storage as the
 * agents default (`DurableObjectOAuthClientProvider`), plus one check for
 * the step-up issuer pin (src/mcp-step-up.ts).
 *
 * The gap it closes: tokens saved before the MCP client SDK stamped an
 * `issuer` on them (SEP-2352, @modelcontextprotocol/client 2.x) get stamped
 * by the next `auth()` with whatever authorization server that run
 * discovered. If the MCP server had swapped `authorization_servers` by then,
 * the stamp names the swapped server, and the next step-up would trust a
 * link to it. The SDK gives no way to tell that stamp from a real one later.
 *
 * So catch it as it happens: a save that only adds an issuer to unchanged,
 * unstamped tokens is that upgrade stamp. Record it, and `callOAuthTool`
 * then treats the grant as having no trusted issuer (no Approve access card)
 * until the server is removed and connected again from Settings. Removing a
 * server clears every key under its prefix (`clearServerStorage`), so the
 * flag goes with it.
 *
 * Grants the SDK already stamped this way before this provider shipped are
 * not flagged: the stamp happened on their first refresh after the upgrade.
 */
import { DurableObjectOAuthClientProvider } from "agents";
import { log } from "./logger";

type SaveTokensArgs = Parameters<DurableObjectOAuthClientProvider["saveTokens"]>;

export class DodoOAuthClientProvider extends DurableObjectOAuthClientProvider {
  /** Per server, not per client: a re-registration must not clear it. */
  private issuerUnverifiedKey(): string {
    return `/${this.clientName}/${this.serverId}/dodo_issuer_unverified`;
  }

  override async saveTokens(...[tokens, context]: SaveTokensArgs): Promise<void> {
    let prev: Awaited<ReturnType<DurableObjectOAuthClientProvider["tokens"]>>;
    try {
      prev = await this.tokens();
    } catch {
      prev = undefined;
    }
    if (isUpgradeStamp(prev, tokens)) {
      await this.storage.put(this.issuerUnverifiedKey(), { at: Date.now(), issuer: tokens.issuer });
      log("warn", "oauth mcp grant stamped by the SDK upgrade; step-up disabled until reconnect", { serverId: this.serverId });
    }
    return super.saveTokens(tokens, context);
  }

  /** True once the current grant's issuer came from an upgrade stamp. */
  async issuerUnverified(): Promise<boolean> {
    try {
      return (await this.storage.get(this.issuerUnverifiedKey())) !== undefined;
    } catch {
      // serverId unset: not a real server connection.
      return false;
    }
  }
}

/**
 * The SDK's upgrade stamp: the stored tokens had no issuer, and the new
 * value is the same tokens with only an issuer added. A refresh or code
 * exchange always carries a new access token.
 */
export function isUpgradeStamp(
  prev: { issuer?: string; access_token?: string; refresh_token?: string } | undefined,
  next: { issuer?: string; access_token?: string; refresh_token?: string },
): boolean {
  if (!prev || prev.issuer !== undefined || typeof next.issuer !== "string") return false;
  return prev.access_token === next.access_token && prev.refresh_token === next.refresh_token;
}
