/**
 * Pure unit tests for HttpMcpGatekeeper constructor validation.
 * Extracted from mcp-config.test.ts to avoid importing the main worker module.
 * See: https://github.com/cloudflare/workers-sdk/issues/13191
 */
import { describe, expect, it } from "vitest";

describe("HttpMcpGatekeeper interface", () => {
  it("construct with valid config", async () => {
    const { HttpMcpGatekeeper } = await import("../src/mcp-gatekeeper");

    const config = {
      id: "test-server",
      name: "Test Server",
      type: "http" as const,
      url: "https://mcp-test.example.com",
      headers: { Authorization: "Bearer abc" },
      auth_type: "static_headers",
      enabled: true,
    };

    const gatekeeper = new HttpMcpGatekeeper(config);
    expect(gatekeeper).toBeTruthy();
    expect(gatekeeper.isConnected()).toBe(false);
  });

  it("rejects service-binding type", async () => {
    const { HttpMcpGatekeeper } = await import("../src/mcp-gatekeeper");

    expect(() => new HttpMcpGatekeeper({
      id: "wrong-type",
      name: "Wrong Type",
      type: "service-binding",
      auth_type: "static_headers",
      enabled: true,
    })).toThrow(/only supports type "http"/);
  });

  it("rejects missing url", async () => {
    const { HttpMcpGatekeeper } = await import("../src/mcp-gatekeeper");

    expect(() => new HttpMcpGatekeeper({
      id: "no-url",
      name: "No URL",
      type: "http",
      auth_type: "static_headers",
      enabled: true,
    })).toThrow(/requires a url/);
  });
});
