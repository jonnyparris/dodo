export interface McpCatalogEntry {
  id: string;
  name: string;
  description: string;
  url: string;
  setupGuide: string;
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
    knownHosts: ["api.githubcopilot.com"],
  },
  {
    id: "cloudflare-api",
    name: "Cloudflare API",
    description: "Manage Workers, KV, R2, D1",
    url: "https://github.com/cloudflare/mcp-server-cloudflare",
    setupGuide: "Deploy the Cloudflare MCP server with your API token",
    knownHosts: [
      "docs.mcp.cloudflare.com",
      "bindings.mcp.cloudflare.com",
      "builds.mcp.cloudflare.com",
      "observability.mcp.cloudflare.com",
      "radar.mcp.cloudflare.com",
      "containers.mcp.cloudflare.com",
      "browser.mcp.cloudflare.com",
      "logs.mcp.cloudflare.com",
      "ai-gateway.mcp.cloudflare.com",
      "autorag.mcp.cloudflare.com",
    ],
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Error tracking and monitoring",
    url: "https://github.com/getsentry/sentry-mcp",
    setupGuide:
      "Use the remote server at https://mcp.sentry.dev with OAuth, or run locally via npx @sentry/mcp-server",
    knownHosts: ["mcp.sentry.dev"],
  },
  {
    id: "browser-rendering",
    name: "Browser Rendering",
    description:
      "Automate a headless Chrome browser via CDP — navigate, screenshot, click, fill forms, and run Lighthouse audits. Powered by Cloudflare Browser Rendering.",
    url: "https://browser.mcp.cloudflare.com/mcp",
    setupGuide:
      "Enter your Cloudflare Account ID and an API Token with 'Browser Rendering - Edit' permission. Each user's browser sessions are billed to their own account.",
    knownHosts: ["browser.mcp.cloudflare.com"],
  },
];
