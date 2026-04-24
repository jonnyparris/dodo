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
    url: "https://api.githubcopilot.com/mcp/",
    setupGuide:
      "Use the remote server at https://api.githubcopilot.com/mcp/ with OAuth, or deploy locally with a PAT",
    auth_type: "oauth",
    knownHosts: ["api.githubcopilot.com"],
  },
  {
    id: "cloudflare-api-docs",
    name: "Cloudflare Docs",
    description: "Search Cloudflare's developer documentation",
    url: "https://docs.mcp.cloudflare.com/mcp",
    setupGuide: "Connect with OAuth",
    auth_type: "oauth",
    knownHosts: ["docs.mcp.cloudflare.com"],
  },
  {
    id: "cloudflare-api-bindings",
    name: "Cloudflare Bindings",
    description: "Manage Workers bindings (KV, R2, D1, Queues, etc.)",
    url: "https://bindings.mcp.cloudflare.com/mcp",
    setupGuide: "Connect with OAuth",
    auth_type: "oauth",
    knownHosts: ["bindings.mcp.cloudflare.com"],
  },
  {
    id: "cloudflare-api-builds",
    name: "Cloudflare Builds",
    description: "Manage Workers Builds and deployments",
    url: "https://builds.mcp.cloudflare.com/mcp",
    setupGuide: "Connect with OAuth",
    auth_type: "oauth",
    knownHosts: ["builds.mcp.cloudflare.com"],
  },
  {
    id: "cloudflare-api-observability",
    name: "Cloudflare Observability",
    description: "Query Workers logs, metrics, and traces",
    url: "https://observability.mcp.cloudflare.com/mcp",
    setupGuide: "Connect with OAuth",
    auth_type: "oauth",
    knownHosts: ["observability.mcp.cloudflare.com"],
  },
  {
    id: "cloudflare-api-radar",
    name: "Cloudflare Radar",
    description: "Query Cloudflare Radar for internet insights and threat data",
    url: "https://radar.mcp.cloudflare.com/mcp",
    setupGuide: "Connect with OAuth",
    auth_type: "oauth",
    knownHosts: ["radar.mcp.cloudflare.com"],
  },
  {
    id: "cloudflare-api-containers",
    name: "Cloudflare Containers",
    description: "Manage Cloudflare Containers",
    url: "https://containers.mcp.cloudflare.com/mcp",
    setupGuide: "Connect with OAuth",
    auth_type: "oauth",
    knownHosts: ["containers.mcp.cloudflare.com"],
  },
  {
    id: "cloudflare-api-logs",
    name: "Cloudflare Logs",
    description: "Query and manage Cloudflare logs",
    url: "https://logs.mcp.cloudflare.com/mcp",
    setupGuide: "Connect with OAuth",
    auth_type: "oauth",
    knownHosts: ["logs.mcp.cloudflare.com"],
  },
  {
    id: "cloudflare-api-ai-gateway",
    name: "Cloudflare AI Gateway",
    description: "Manage AI Gateway configurations and query LLM usage",
    url: "https://ai-gateway.mcp.cloudflare.com/mcp",
    setupGuide: "Connect with OAuth",
    auth_type: "oauth",
    knownHosts: ["ai-gateway.mcp.cloudflare.com"],
  },
  {
    id: "cloudflare-api-autorag",
    name: "Cloudflare AutoRAG",
    description: "Manage AutoRAG retrieval pipelines",
    url: "https://autorag.mcp.cloudflare.com/mcp",
    setupGuide: "Connect with OAuth",
    auth_type: "oauth",
    knownHosts: ["autorag.mcp.cloudflare.com"],
  },
  {
    id: "browser-rendering",
    name: "Browser Rendering",
    description:
      "Automate a headless Chrome browser via CDP — navigate, screenshot, click, fill forms, and run Lighthouse audits. Powered by Cloudflare Browser Rendering.",
    url: "https://browser.mcp.cloudflare.com/mcp",
    setupGuide:
      "Connect with OAuth. Each user's browser sessions are billed to their own account.",
    auth_type: "oauth",
    knownHosts: ["browser.mcp.cloudflare.com"],
  },
];
