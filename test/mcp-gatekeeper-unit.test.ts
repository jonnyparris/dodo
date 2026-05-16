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
