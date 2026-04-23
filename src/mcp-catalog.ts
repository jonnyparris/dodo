export interface McpCatalogEntry {
  id: string;
  name: string;
  description: string;
  url: string;
  setupGuide: string;
  auth_type?: "oauth" | "static_headers";
  /** Hostnames implicitly allowed without requiring admin allowlist entry. */
  knownHosts?: string[];
}

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: "dodo-self",
    name: "Dodo Self",
    description: "Connect to this Dodo instance's own MCP server for multi-session orchestration. Use /mcp/codemode for coding agents (2 tools, ~1k tokens) or /mcp for orchestrators (40+ tools).",
    url: "/mcp/codemode",
    setupGuide: "Add your DODO_MCP_TOKEN as the Authorization Bearer token. The /mcp/codemode endpoint uses code-mode (search + execute) to minimize context usage.",
    auth_type: "static_headers",
    knownHosts: [],
  },
  {
    id: "github",
    name: "GitHub",
    description:
      "Structured tools for issues, PRs, actions, and code scanning (beyond basic git operations)",
    url: "https://github.com/github/github-mcp-server",
    setupGuide:
      "Use the remote server at https://api.githubcopilot.com/mcp/ with OAuth, or deploy locally with a PAT",
    auth_type: "oauth",
    knownHosts: ["api.githubcopilot.com"],
  },
  {
    id: "cloudflare-api-docs",
    name: "Cloudflare API (Docs)",
    description: "Manage Workers, KV, R2, D1",
    url: "https://github.com/cloudflare/mcp-server-cloudflare",
    setupGuide: "Connect to the Cloudflare MCP server with OAuth",
    auth_type: "oauth",
    knownHosts: ["docs.mcp.cloudflare.com"],
  },
  {
    id: "cloudflare-api-bindings",
    name: "Cloudflare API (Bindings)",
    description: "Manage Workers, KV, R2, D1",
    url: "https://github.com/cloudflare/mcp-server-cloudflare",
    setupGuide: "Connect to the Cloudflare MCP server with OAuth",
    auth_type: "oauth",
    knownHosts: ["bindings.mcp.cloudflare.com"],
  },
  {
    id: "cloudflare-api-builds",
    name: "Cloudflare API (Builds)",
    description: "Manage Workers, KV, R2, D1",
    url: "https://github.com/cloudflare/mcp-server-cloudflare",
    setupGuide: "Connect to the Cloudflare MCP server with OAuth",
    auth_type: "oauth",
    knownHosts: ["builds.mcp.cloudflare.com"],
  },
  {
    id: "cloudflare-api-observability",
    name: "Cloudflare API (Observability)",
    description: "Manage Workers, KV, R2, D1",
    url: "https://github.com/cloudflare/mcp-server-cloudflare",
    setupGuide: "Connect to the Cloudflare MCP server with OAuth",
    auth_type: "oauth",
    knownHosts: ["observability.mcp.cloudflare.com"],
  },
  {
    id: "cloudflare-api-radar",
    name: "Cloudflare API (Radar)",
    description: "Manage Workers, KV, R2, D1",
    url: "https://github.com/cloudflare/mcp-server-cloudflare",
    setupGuide: "Connect to the Cloudflare MCP server with OAuth",
    auth_type: "oauth",
    knownHosts: ["radar.mcp.cloudflare.com"],
  },
  {
    id: "cloudflare-api-containers",
    name: "Cloudflare API (Containers)",
    description: "Manage Workers, KV, R2, D1",
    url: "https://github.com/cloudflare/mcp-server-cloudflare",
    setupGuide: "Connect to the Cloudflare MCP server with OAuth",
    auth_type: "oauth",
    knownHosts: ["containers.mcp.cloudflare.com"],
  },
  {
    id: "cloudflare-api-browser",
    name: "Cloudflare API (Browser)",
    description: "Manage Workers, KV, R2, D1",
    url: "https://github.com/cloudflare/mcp-server-cloudflare",
    setupGuide: "Connect to the Cloudflare MCP server with OAuth",
    auth_type: "oauth",
    knownHosts: ["browser.mcp.cloudflare.com"],
  },
  {
    id: "cloudflare-api-logs",
    name: "Cloudflare API (Logs)",
    description: "Manage Workers, KV, R2, D1",
    url: "https://github.com/cloudflare/mcp-server-cloudflare",
    setupGuide: "Connect to the Cloudflare MCP server with OAuth",
    auth_type: "oauth",
    knownHosts: ["logs.mcp.cloudflare.com"],
  },
  {
    id: "browser-rendering",
    name: "Browser Rendering",
    description:
      "Automate a headless Chrome browser via CDP — navigate, screenshot, click, fill forms, and run Lighthouse audits. Powered by Cloudflare Browser Rendering.",
    url: "https://browser.mcp.cloudflare.com/mcp",
    setupGuide:
      "Enter your Cloudflare Account ID and an API Token with 'Browser Rendering - Edit' permission. Each user's browser sessions are billed to their own account.",
    auth_type: "oauth",
    knownHosts: ["browser.mcp.cloudflare.com"],
  },
];
