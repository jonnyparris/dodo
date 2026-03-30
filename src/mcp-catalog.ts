export interface McpCatalogEntry {
  id: string;
  name: string;
  description: string;
  url: string;
  setupGuide: string;
}

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: "agent-memory",
    name: "Agent Memory",
    description: "Persistent memory across sessions",
    url: "https://github.com/jonnyparris/agent-memory-mcp",
    setupGuide: "Deploy to your CF account, add the URL",
  },
  {
    id: "github",
    name: "GitHub",
    description: "Repository management, issues, PRs",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    setupGuide: "Set up a GitHub personal access token, deploy the MCP server",
  },
  {
    id: "cloudflare-api",
    name: "Cloudflare API",
    description: "Manage Workers, KV, R2, D1",
    url: "https://github.com/cloudflare/mcp-server-cloudflare",
    setupGuide: "Deploy the Cloudflare MCP server with your API token",
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Error tracking and monitoring",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/sentry",
    setupGuide: "Configure Sentry auth token and organization slug",
  },
  {
    id: "linear",
    name: "Linear",
    description: "Issue tracking and project management",
    url: "https://github.com/modelcontextprotocol/servers/tree/main/src/linear",
    setupGuide: "Generate a Linear API key and configure the server",
  },
  {
    id: "browser",
    name: "Browser",
    description: "Web browsing and scraping",
    url: "Built-in (when enabled)",
    setupGuide: "Enable browser integration in your Dodo settings",
  },
];
