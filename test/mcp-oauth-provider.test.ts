/**
 * DodoOAuthClientProvider writes the step-up issuer pin only for a code
 * exchange, i.e. a save inside runWithCodeVerifierState
 * (src/mcp-oauth-provider.ts), against real DO storage. The hub flows are in
 * test/mcp-step-up-hub.test.ts.
 */
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/types";
import { DodoOAuthClientProvider } from "../src/mcp-oauth-provider";

const AS = "https://as.example";
const PHISH = "https://phish.example";
const STATE = "nonce1.srv1";

async function withProvider(fn: (p: DodoOAuthClientProvider, pin: () => Promise<string | undefined>) => Promise<void>): Promise<void> {
  const ns = (env as Env).CODING_AGENT;
  const stub = ns.get(ns.idFromName(`oauth-provider-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_i: unknown, state: DurableObjectState) => {
    const p = new DodoOAuthClientProvider(state.storage, "owner@dodo.test", "https://dodo.test/cb");
    p.serverId = "srv1";
    p.clientId = "client-1";
    await fn(p, () => p.pinnedIssuer());
  });
}

describe("DodoOAuthClientProvider issuer pin", () => {
  it("pins the issuer of a code exchange", async () => {
    await withProvider(async (p, pin) => {
      await p.runWithCodeVerifierState(STATE, () => p.saveTokens({ access_token: "a1", token_type: "Bearer", issuer: AS }));
      expect(await pin()).toBe(AS);
    });
  });

  it("does not pin an upgrade stamp or a refresh", async () => {
    await withProvider(async (p, pin) => {
      await p.saveTokens({ access_token: "a1", token_type: "Bearer" });
      const t = await p.tokens();
      await p.saveTokens({ ...t!, issuer: PHISH }); // upgrade stamp
      await p.saveTokens({ access_token: "a2", token_type: "Bearer", issuer: PHISH }); // refresh
      expect(await pin()).toBeUndefined();
    });
  });

  it("a save outside the exchange never pins, even while an exchange is running", async () => {
    await withProvider(async (p, pin) => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      // An exchange is in flight (its token request is slow)...
      const exchange = p.runWithCodeVerifierState(STATE, async () => {
        await gate;
        throw new Error("token request failed"); // ...and then fails: no save.
      });
      // ...while a parallel refresh saves tokens from another AS.
      await p.saveTokens({ access_token: "a2", token_type: "Bearer", issuer: PHISH });
      release();
      await expect(exchange).rejects.toThrow("token request failed");
      expect(await pin()).toBeUndefined();
      // Later saves (after the failed exchange) don't pin either.
      await p.saveTokens({ access_token: "a3", token_type: "Bearer", issuer: PHISH });
      expect(await pin()).toBeUndefined();
    });
  });

  it("a re-exchange moves the pin", async () => {
    await withProvider(async (p, pin) => {
      await p.runWithCodeVerifierState(STATE, () => p.saveTokens({ access_token: "a1", token_type: "Bearer", issuer: AS }));
      await p.runWithCodeVerifierState(STATE, () => p.saveTokens({ access_token: "a1", token_type: "Bearer", issuer: `${AS}/v2` }));
      expect(await pin()).toBe(`${AS}/v2`);
    });
  });
});
