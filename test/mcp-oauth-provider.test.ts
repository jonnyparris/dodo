/**
 * DodoOAuthClientProvider writes the step-up issuer pin only for a real code
 * exchange (src/mcp-oauth-provider.ts), against real DO storage. The hub
 * flows are in test/mcp-step-up-hub.test.ts.
 */
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/types";
import { DodoOAuthClientProvider } from "../src/mcp-oauth-provider";

const AS = "https://as.example";
const PHISH = "https://phish.example";

async function withProvider(fn: (p: DodoOAuthClientProvider, pin: () => Promise<string | undefined>) => Promise<void>): Promise<void> {
  const ns = (env as Env).CODING_AGENT;
  const stub = ns.get(ns.idFromName(`oauth-provider-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_i: unknown, state: DurableObjectState) => {
    const p = new DodoOAuthClientProvider(state.storage, "owner@dodo.test", "https://dodo.test/cb");
    p.serverId = "srv1";
    p.clientId = "client-1";
    // Legacy verifier key: codeVerifier() falls back to it outside a callback.
    await state.storage.put(`${p.keyPrefix("client-1")}/code_verifier`, "verifier-1");
    await fn(p, () => p.pinnedIssuer());
  });
}

describe("DodoOAuthClientProvider issuer pin", () => {
  it("pins the issuer of a code exchange", async () => {
    await withProvider(async (p, pin) => {
      await p.codeVerifier();
      await p.saveTokens({ access_token: "a1", token_type: "Bearer", issuer: AS });
      expect(await pin()).toBe(AS);
    });
  });

  it("does not pin an upgrade stamp or a refresh", async () => {
    await withProvider(async (p, pin) => {
      await p.saveTokens({ access_token: "a1", token_type: "Bearer" });
      // Upgrade stamp: the SDK reads tokens, then re-saves them with an issuer.
      const t = await p.tokens();
      await p.saveTokens({ ...t!, issuer: PHISH });
      // Refresh: reads tokens, saves new ones.
      await p.tokens();
      await p.saveTokens({ access_token: "a2", token_type: "Bearer", issuer: PHISH });
      expect(await pin()).toBeUndefined();
    });
  });

  it("a failed exchange does not leave the next save pinning", async () => {
    await withProvider(async (p, pin) => {
      await p.saveTokens({ access_token: "a1", token_type: "Bearer" });
      await p.codeVerifier(); // exchange starts, then its token request fails: no save
      const t = await p.tokens(); // a later auth() run: upgrade stamp
      await p.saveTokens({ ...t!, issuer: PHISH });
      expect(await pin()).toBeUndefined();
      // Even without a tokens() read in between, re-saving the same access
      // token (the stamp) never pins.
      await p.codeVerifier();
      await p.saveTokens({ ...t!, issuer: PHISH });
      expect(await pin()).toBeUndefined();
    });
  });
});
