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
  // NOTE: GitHub Copilot's MCP server at https://api.githubcopilot.com/mcp/
  // was tested and is intentionally NOT in this catalog as an OAuth entry.
  // Its OAuth provider does NOT support Dynamic Client Registration —
  // attempting to connect via the SDK-managed OAuth path errors with
  // "Incompatible auth server: does not support dynamic client registration".
  // To use GitHub MCP, add a github_token secret (Personal Access Token or
  // GitHub App installation token); the existing static-headers path picks
  // it up automatically and the UI hides the GitHub catalog entry when one
  // is present.
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
  {
    id: "web-search",
    name: "Web Search",
    description:
      "Search the public web for URLs matching a query, powered by Cloudflare Web Search. Returns titles and catalog metadata — not page content; fetch a result URL yourself to read it.",
    // Staging endpoint. Same *.mcp.cloudflare.com OAuth family as the
    // Browser Rendering MCP above (which works from Dodo), unlike cf-portal
    // on portal.mcp.cfdata.org (loopback-only redirect, excluded below).
    // The companion `web_search` Worker binding (env.WEBSEARCH) was tried and
    // reverted — the control plane silently drops the binding so it never
    // materialises at runtime. This MCP is the working path until the binding
    // GAs. See commit reverting "add Cloudflare Web Search binding".
    url: "https://websearch-staging.mcp.cloudflare.com/mcp",
    setupGuide:
      "Connect with OAuth. Staging: your Cloudflare account must be enabled for Web Search by the Web Search team before queries succeed.",
    auth_type: "oauth",
    knownHosts: ["websearch-staging.mcp.cloudflare.com"],
  },
  // NOTE: cf-portal (https://portal.mcp.cfdata.org/mcp) was tested and is
  // intentionally NOT in this catalog. Its OAuth authorize endpoint
  // (cf-mcp.cloudflareaccess.com) only accepts redirect URIs pointing at
  // loopback (http://127.0.0.1:*) or Cloudflare-managed domains (e.g.
  // seal-nightly.cloudflare.dev). DCR succeeds, but the authorize step
  // returns "Redirect URI not allowed by application configuration"
  // for any other host. This is by design — cf-portal treats third-party
  // hosted apps as untrusted clients. OpenCode/Cursor/Claude Desktop work
  // because they run locally on 127.0.0.1; Dodo runs on a Worker, which
  // can't bind 127.0.0.1 from the user's POV. See OpenCode's
  // `McpOAuthProvider.redirectUrl` for reference. To use cf-portal tools
  // in Dodo, run a local mcp-remote proxy and add it as a static-headers
  // integration.
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
