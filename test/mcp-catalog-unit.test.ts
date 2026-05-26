/**
 * Unit tests for the MCP catalog presets. Confirms that catalog entries
 * intended for OAuth flow (cf-portal, browser-rendering, github) carry the
 * right `auth_type` and `knownHosts` — the knownHosts list is what allows
 * the OAuth dance through `isHostAllowed()` without an admin allowlist add.
 */
import { describe, expect, it } from "vitest";
import { MCP_CATALOG } from "../src/mcp-catalog";

describe("MCP_CATALOG", () => {
  it("includes cf-portal as an OAuth catalog entry", () => {
    const entry = MCP_CATALOG.find((e) => e.id === "cf-portal");
    expect(entry).toBeDefined();
    expect(entry?.url).toBe("https://portal.mcp.cfdata.org/mcp");
    expect(entry?.auth_type).toBe("oauth");
    // Both the MCP host AND the Cloudflare Access OAuth dance host must be
    // in knownHosts — otherwise `isHostAllowed()` rejects the start-auth
    // call and the token endpoint round-trip during the dance.
    expect(entry?.knownHosts).toContain("portal.mcp.cfdata.org");
    expect(entry?.knownHosts).toContain("cf-mcp.cloudflareaccess.com");
  });

  it("includes browser-rendering as an OAuth catalog entry", () => {
    const entry = MCP_CATALOG.find((e) => e.id === "browser-rendering");
    expect(entry).toBeDefined();
    expect(entry?.auth_type).toBe("oauth");
    expect(entry?.knownHosts).toContain("browser.mcp.cloudflare.com");
  });

  it("includes github as an OAuth catalog entry", () => {
    const entry = MCP_CATALOG.find((e) => e.id === "github");
    expect(entry).toBeDefined();
    expect(entry?.auth_type).toBe("oauth");
    expect(entry?.knownHosts).toContain("api.githubcopilot.com");
  });

  it("every catalog entry has either auth_type or is the self-MCP", () => {
    for (const e of MCP_CATALOG) {
      if (e.id === "dodo-self") continue;
      expect(e.auth_type).toMatch(/^(oauth|static_headers)$/);
    }
  });
});
