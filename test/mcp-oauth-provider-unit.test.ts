/**
 * isUpgradeStamp: the save that only adds an SDK issuer stamp to unchanged,
 * unstamped tokens (src/mcp-oauth-provider.ts). The hub-level behaviour is
 * in test/mcp-step-up-hub.test.ts.
 */
import { describe, expect, it } from "vitest";
import { isUpgradeStamp } from "../src/mcp-oauth-provider";

const tok = { access_token: "a1", refresh_token: "r1" };

describe("isUpgradeStamp", () => {
  it("flags an issuer added to the same unstamped tokens", () => {
    expect(isUpgradeStamp(tok, { ...tok, issuer: "https://as.example" })).toBe(true);
  });
  it("ignores a refresh or code exchange (new access token)", () => {
    expect(isUpgradeStamp(tok, { access_token: "a2", refresh_token: "r2", issuer: "https://as.example" })).toBe(false);
    expect(isUpgradeStamp(tok, { access_token: "a2", refresh_token: "r1", issuer: "https://as.example" })).toBe(false);
  });
  it("ignores tokens that were already stamped", () => {
    expect(isUpgradeStamp({ ...tok, issuer: "https://as.example" }, { ...tok, issuer: "https://as.example" })).toBe(false);
  });
  it("ignores a first save and a save without an issuer", () => {
    expect(isUpgradeStamp(undefined, { ...tok, issuer: "https://as.example" })).toBe(false);
    expect(isUpgradeStamp(tok, { ...tok })).toBe(false);
  });
});
