/**
 * Unit tests for the MCP catalog presets. Confirms that catalog entries
 * intended for OAuth flow (cf-portal, browser-rendering, github) carry the
 * right `auth_type` and `knownHosts` — the knownHosts list is what allows
 * the OAuth dance through `isHostAllowed()` without an admin allowlist add.
 */
import { describe, expect, it } from "vitest";
import { MCP_CATALOG } from "../src/mcp-catalog";

describe("MCP_CATALOG", () => {
  it("does NOT include cf-portal — its OAuth authorize endpoint rejects non-loopback redirect URIs", () => {
    // Documented in mcp-catalog.ts. cf-portal works for OpenCode/Cursor/etc
    // because those clients use http://127.0.0.1:PORT/... redirect URIs.
    // A hosted Worker can't do that, and cf-portal rejects everything else.
    const entry = MCP_CATALOG.find((e) => e.id === "cf-portal");
    expect(entry).toBeUndefined();
  });

  it("includes browser-rendering as an OAuth catalog entry", () => {
    const entry = MCP_CATALOG.find((e) => e.id === "browser-rendering");
    expect(entry).toBeDefined();
    expect(entry?.auth_type).toBe("oauth");
    expect(entry?.knownHosts).toContain("browser.mcp.cloudflare.com");
  });

  it("includes web-search as an OAuth catalog entry", () => {
    const entry = MCP_CATALOG.find((e) => e.id === "web-search");
    expect(entry).toBeDefined();
    expect(entry?.auth_type).toBe("oauth");
    expect(entry?.knownHosts).toContain("websearch-staging.mcp.cloudflare.com");
  });

  it("includes the Cloudflare API MCP as an OAuth entry that steers users to a narrow grant", () => {
    const entry = MCP_CATALOG.find((e) => e.id === "cloudflare-api");
    expect(entry).toBeDefined();
    expect(entry?.url).toBe("https://mcp.cloudflare.com/mcp");
    expect(entry?.auth_type).toBe("oauth");
    expect(entry?.knownHosts).toEqual(["mcp.cloudflare.com"]);
    // Step-up makes Minimal / Read only usable; the guide must say so.
    expect(entry?.setupGuide).toMatch(/Minimal or Read only/);
  });

  it("does NOT include github as an OAuth catalog entry — GitHub's MCP server doesn't support DCR", () => {
    // Documented in mcp-catalog.ts. api.githubcopilot.com returns
    // "Incompatible auth server: does not support dynamic client
    // registration" when the SDK-managed OAuth path attempts DCR. To use
    // GitHub MCP, add a github_token secret — the static-headers path
    // already handles it and the UI hides the suggestion when present.
    const entry = MCP_CATALOG.find((e) => e.id === "github");
    expect(entry).toBeUndefined();
  });

  it("every catalog entry has either auth_type or is the self-MCP", () => {
    for (const e of MCP_CATALOG) {
      if (e.id === "dodo-self") continue;
      expect(e.auth_type).toMatch(/^(oauth|static_headers)$/);
    }
  });
});
