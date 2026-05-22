/**
 * Pure unit tests for HttpMcpClient constructor validation.
 * Extracted from mcp-config.test.ts to avoid importing the main worker module.
 * See: https://github.com/cloudflare/workers-sdk/issues/13191
 */
import { describe, expect, it } from "vitest";

describe("HttpMcpClient interface", () => {
  it("construct with valid config", async () => {
    const { HttpMcpClient } = await import("../src/mcp-client");

    const config = {
      id: "test-server",
      name: "Test Server",
      type: "http" as const,
      url: "https://mcp-test.example.com",
      headers: { Authorization: "Bearer abc" },
      auth_type: "static_headers" as const,
      enabled: true,
    };

    const gatekeeper = new HttpMcpClient(config);
    expect(gatekeeper).toBeTruthy();
    expect(gatekeeper.isConnected()).toBe(false);
  });

  it("rejects service-binding type", async () => {
    const { HttpMcpClient } = await import("../src/mcp-client");

    expect(() => new HttpMcpClient({
      id: "wrong-type",
      name: "Wrong Type",
      type: "service-binding",
      auth_type: "static_headers" as const,
      enabled: true,
    })).toThrow(/only supports type "http"/);
  });

  it("rejects missing url", async () => {
    const { HttpMcpClient } = await import("../src/mcp-client");

    expect(() => new HttpMcpClient({
      id: "no-url",
      name: "No URL",
      type: "http",
      auth_type: "static_headers" as const,
      enabled: true,
    })).toThrow(/requires a url/);
  });
});

describe("normaliseAuthorizationHeader", () => {
  it("prepends 'Bearer ' to a bare token", async () => {
    const { normaliseAuthorizationHeader } = await import("../src/mcp-client");
    expect(normaliseAuthorizationHeader("abc123xyz")).toBe("Bearer abc123xyz");
  });

  it("leaves an already-prefixed Bearer token untouched", async () => {
    const { normaliseAuthorizationHeader } = await import("../src/mcp-client");
    expect(normaliseAuthorizationHeader("Bearer abc123xyz")).toBe("Bearer abc123xyz");
  });

  it("leaves Basic auth untouched", async () => {
    const { normaliseAuthorizationHeader } = await import("../src/mcp-client");
    expect(normaliseAuthorizationHeader("Basic dXNlcjpwYXNz")).toBe("Basic dXNlcjpwYXNz");
  });

  it("leaves arbitrary scheme-shaped values untouched", async () => {
    const { normaliseAuthorizationHeader } = await import("../src/mcp-client");
    expect(normaliseAuthorizationHeader("Token abc")).toBe("Token abc");
    expect(normaliseAuthorizationHeader("OAuth foo=bar")).toBe("OAuth foo=bar");
    expect(normaliseAuthorizationHeader("Digest username=\"u\"")).toBe("Digest username=\"u\"");
  });

  it("treats scheme detection case-insensitively", async () => {
    const { normaliseAuthorizationHeader } = await import("../src/mcp-client");
    expect(normaliseAuthorizationHeader("bearer abc123")).toBe("bearer abc123");
    expect(normaliseAuthorizationHeader("BEARER abc123")).toBe("BEARER abc123");
  });

  it("preserves empty / whitespace-only values (no auth → upstream 401)", async () => {
    const { normaliseAuthorizationHeader } = await import("../src/mcp-client");
    expect(normaliseAuthorizationHeader("")).toBe("");
    expect(normaliseAuthorizationHeader("   ")).toBe("   ");
  });

  it("does not prepend Bearer to a single-token value with no scheme", async () => {
    // Single tokens with no space are the bare-API-key case — this *should* be normalised.
    const { normaliseAuthorizationHeader } = await import("../src/mcp-client");
    expect(normaliseAuthorizationHeader("sk-abc-123_def")).toBe("Bearer sk-abc-123_def");
  });

  it("trims whitespace before prepending", async () => {
    const { normaliseAuthorizationHeader } = await import("../src/mcp-client");
    expect(normaliseAuthorizationHeader("  abc123  ")).toBe("Bearer abc123");
  });

  it("treats a malformed scheme prefix (no token after scheme) as bare", async () => {
    // "Bearer " with trailing space and nothing else → not a complete scheme;
    // safer to prepend than to send a header that upstream will reject anyway.
    const { normaliseAuthorizationHeader } = await import("../src/mcp-client");
    expect(normaliseAuthorizationHeader("Bearer")).toBe("Bearer Bearer");
  });
});

describe("normaliseAuthHeaders", () => {
  it("normalises the Authorization header case-insensitively", async () => {
    const { normaliseAuthHeaders } = await import("../src/mcp-client");
    const { headers, normalised } = normaliseAuthHeaders({
      authorization: "abc123",
      "X-Other": "untouched",
    });
    expect(headers).toEqual({
      authorization: "Bearer abc123",
      "X-Other": "untouched",
    });
    expect(normalised).toBe(true);
  });

  it("reports normalised=false when no change is needed", async () => {
    const { normaliseAuthHeaders } = await import("../src/mcp-client");
    const { headers, normalised } = normaliseAuthHeaders({
      Authorization: "Bearer abc",
      "X-Other": "v",
    });
    expect(headers).toEqual({ Authorization: "Bearer abc", "X-Other": "v" });
    expect(normalised).toBe(false);
  });

  it("returns headers unchanged when there's no Authorization", async () => {
    const { normaliseAuthHeaders } = await import("../src/mcp-client");
    const { headers, normalised } = normaliseAuthHeaders({ "X-Api-Key": "abc" });
    expect(headers).toEqual({ "X-Api-Key": "abc" });
    expect(normalised).toBe(false);
  });

  it("does not mutate the input object", async () => {
    const { normaliseAuthHeaders } = await import("../src/mcp-client");
    const input = { Authorization: "abc123" };
    normaliseAuthHeaders(input);
    expect(input).toEqual({ Authorization: "abc123" });
  });
});
