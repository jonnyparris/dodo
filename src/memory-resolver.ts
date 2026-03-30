import type { McpGatekeeperConfig } from "./mcp-gatekeeper";

/**
 * Determine whether to use an external Memory MCP server or the built-in memory.
 *
 * When an external Memory MCP server is configured and enabled, use it as primary.
 * If not configured (or connection fails at runtime), fall back to the built-in memory.
 *
 * This function only resolves the *strategy* — the actual fallback on connection
 * failure happens in the agentic loop when it tries to connect to the external server.
 */
export function resolveMemoryStrategy(mcpConfigs: McpGatekeeperConfig[]): "external" | "builtin" {
  const memoryConfig = mcpConfigs.find(
    (c) => c.name.toLowerCase().includes("memory") && c.enabled,
  );
  return memoryConfig ? "external" : "builtin";
}
