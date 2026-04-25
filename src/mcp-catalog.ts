import type { Env } from "./types";

export interface McpCatalogEntry {
  id: string;
  name: string;
  description?: string;
  url: string;
  setupGuide?: string;
  auth_type?: "oauth" | "static_headers";
  /** Hostnames implicitly allowed without requiring admin allowlist entry. */
  knownHosts?: string[];
}

export type McpCatalogConfig = {
  cloudflareRemoteMcps?: McpCatalogEntry[];
};

const CORE_MCP_CATALOG: McpCatalogEntry[] = [
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
];

const DEFAULT_CLOUDFLARE_REMOTE_MCP_CATALOG: McpCatalogEntry[] = [
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

export const DEPLOY_MCP_CATALOG_CONFIG: McpCatalogConfig = {
  cloudflareRemoteMcps: DEFAULT_CLOUDFLARE_REMOTE_MCP_CATALOG,
};

export function getMcpCatalog(config: McpCatalogConfig = DEPLOY_MCP_CATALOG_CONFIG): McpCatalogEntry[] {
  return [...CORE_MCP_CATALOG, ...(config.cloudflareRemoteMcps ?? [])];
}

export function getDeployMcpCatalog(env?: Pick<Env, "DEPLOY_MCP_CATALOG_CONFIG">): McpCatalogEntry[] {
  const rawConfig = env?.DEPLOY_MCP_CATALOG_CONFIG;
  if (!rawConfig) return getMcpCatalog(DEPLOY_MCP_CATALOG_CONFIG);

  try {
    const parsed = JSON.parse(rawConfig) as McpCatalogConfig;
    return getMcpCatalog(parsed);
  } catch {
    return getMcpCatalog(DEPLOY_MCP_CATALOG_CONFIG);
  }
}

export const MCP_CATALOG: McpCatalogEntry[] = getDeployMcpCatalog();
