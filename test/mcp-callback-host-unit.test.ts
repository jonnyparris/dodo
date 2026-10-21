import { describe, expect, it } from "vitest";
import { DEV_LOOPBACK_WORKER_URL, resolveMcpCallbackHost } from "../src/mcp-callback";

// Regression coverage for the MCP OAuth callback host. A production deploy
// that never overrode WORKER_URL used to register the loopback redirect URI
// http://localhost:8787/agents/coding-agent/<id>/callback, which no OAuth
// provider can deliver to. The resolver must ignore that dev default and use
// the live request origin instead, while still honouring a real override.
describe("resolveMcpCallbackHost", () => {
  it("ignores the development loopback default and uses the request origin", () => {
    expect(resolveMcpCallbackHost(DEV_LOOPBACK_WORKER_URL, "https://dodo.example/agents/coding-agent/cb")).toBe(
      "https://dodo.example",
    );
  });

  it("falls back to the request origin when WORKER_URL is unset", () => {
    expect(resolveMcpCallbackHost(undefined, "https://dodo.jonnyparris.club/api/mcp/refresh-state")).toBe(
      "https://dodo.jonnyparris.club",
    );
  });

  it("falls back to the request origin for an empty WORKER_URL", () => {
    expect(resolveMcpCallbackHost("", "https://dodo.example/api/mcp/refresh-state")).toBe("https://dodo.example");
  });

  it("honours an explicit non-loopback WORKER_URL override", () => {
    expect(resolveMcpCallbackHost("https://custom.example", "https://dodo.example/api/mcp/refresh-state")).toBe(
      "https://custom.example",
    );
  });

  it("keeps the request scheme, host and port but drops the path", () => {
    expect(resolveMcpCallbackHost(DEV_LOOPBACK_WORKER_URL, "http://127.0.0.1:8787/foo/bar?x=1")).toBe(
      "http://127.0.0.1:8787",
    );
  });
});
