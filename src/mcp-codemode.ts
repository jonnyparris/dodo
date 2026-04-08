import { getAgentByName } from "agents";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getUserControlStub, resolveAdminEmail } from "./auth";
import type { Env } from "./types";

// ─── API Catalog ───
// Static description of all Dodo internal API endpoints.
// The coding agent queries this via the `search` tool to discover capabilities,
// then calls them via the `execute` tool's `dodo.request()` client.

const API_CATALOG = [
  // Sessions
  { method: "GET", path: "/sessions", description: "List all sessions", params: [] },
  { method: "POST", path: "/sessions", description: "Create a session", params: [{ name: "id", in: "body" }, { name: "title", in: "body", optional: true }, { name: "ownerEmail", in: "body" }, { name: "createdBy", in: "body" }] },
  { method: "GET", path: "/sessions/{sessionId}/check", description: "Check if a session exists", params: [{ name: "sessionId", in: "path" }] },
  { method: "PATCH", path: "/sessions/{sessionId}", description: "Update session (status, title)", params: [{ name: "sessionId", in: "path" }, { name: "status", in: "body", optional: true }, { name: "title", in: "body", optional: true }] },
  { method: "POST", path: "/sessions/{sessionId}/soft-delete", description: "Soft-delete a session (recoverable for 5 min)", params: [{ name: "sessionId", in: "path" }] },
  { method: "POST", path: "/sessions/{sessionId}/restore", description: "Restore a soft-deleted session", params: [{ name: "sessionId", in: "path" }] },

  // Config
  { method: "GET", path: "/config", description: "Get LLM and git configuration", params: [] },
  { method: "PUT", path: "/config", description: "Update config (model, gateway, git author)", params: [{ name: "model", in: "body", optional: true }, { name: "activeGateway", in: "body", optional: true }] },

  // MCP Configs
  { method: "GET", path: "/mcp-configs", description: "List MCP integrations", params: [] },
  { method: "POST", path: "/mcp-configs", description: "Add MCP integration", params: [{ name: "name", in: "body" }, { name: "type", in: "body" }, { name: "url", in: "body" }, { name: "enabled", in: "body" }] },
  { method: "DELETE", path: "/mcp-configs/{id}", description: "Remove MCP integration", params: [{ name: "id", in: "path" }] },

  // Tasks
  { method: "GET", path: "/tasks", description: "List backlog tasks", params: [{ name: "status", in: "query", optional: true }] },
  { method: "POST", path: "/tasks", description: "Create a task", params: [{ name: "title", in: "body" }, { name: "description", in: "body", optional: true }, { name: "priority", in: "body", optional: true }] },
  { method: "PUT", path: "/tasks/{id}", description: "Update a task", params: [{ name: "id", in: "path" }, { name: "title", in: "body", optional: true }, { name: "status", in: "body", optional: true }, { name: "priority", in: "body", optional: true }] },
  { method: "DELETE", path: "/tasks/{id}", description: "Delete a task", params: [{ name: "id", in: "path" }] },

  // Memory
  { method: "GET", path: "/memory", description: "Search memory entries", params: [{ name: "q", in: "query", optional: true }] },
  { method: "POST", path: "/memory", description: "Write a memory entry", params: [{ name: "title", in: "body" }, { name: "content", in: "body" }, { name: "tags", in: "body", optional: true }] },

  // Worker Runs
  { method: "GET", path: "/worker-runs", description: "List tracked worker runs", params: [{ name: "sessionId", in: "query", optional: true }] },
  { method: "GET", path: "/worker-runs/{runId}", description: "Get a worker run", params: [{ name: "runId", in: "path" }] },
  { method: "POST", path: "/worker-runs", description: "Create a worker run", params: [{ name: "sessionId", in: "body" }, { name: "repoId", in: "body" }, { name: "branch", in: "body" }, { name: "title", in: "body" }, { name: "strategy", in: "body" }] },
  { method: "PUT", path: "/worker-runs/{runId}", description: "Update a worker run status", params: [{ name: "runId", in: "path" }, { name: "status", in: "body" }] },

  // Failure Snapshots
  { method: "GET", path: "/failure-snapshots/{snapshotId}", description: "Get a failure snapshot", params: [{ name: "snapshotId", in: "path" }] },

  // Agent (session-scoped) — require sessionId in path
  { method: "GET", path: "/agent/{sessionId}/", description: "Get session state", params: [{ name: "sessionId", in: "path" }] },
  { method: "DELETE", path: "/agent/{sessionId}/", description: "Delete session storage", params: [{ name: "sessionId", in: "path" }] },
  { method: "GET", path: "/agent/{sessionId}/messages", description: "Get message history", params: [{ name: "sessionId", in: "path" }] },
  { method: "GET", path: "/agent/{sessionId}/prompts", description: "Get prompt history", params: [{ name: "sessionId", in: "path" }] },
  { method: "POST", path: "/agent/{sessionId}/message", description: "Send sync message (waits for response)", params: [{ name: "sessionId", in: "path" }, { name: "content", in: "body" }] },
  { method: "POST", path: "/agent/{sessionId}/prompt", description: "Send async prompt (returns immediately)", params: [{ name: "sessionId", in: "path" }, { name: "content", in: "body" }] },
  { method: "POST", path: "/agent/{sessionId}/abort", description: "Abort running prompt", params: [{ name: "sessionId", in: "path" }] },
  { method: "GET", path: "/agent/{sessionId}/snapshot", description: "Get workspace snapshot", params: [{ name: "sessionId", in: "path" }] },
  { method: "POST", path: "/agent/{sessionId}/snapshot/import", description: "Import a snapshot", params: [{ name: "sessionId", in: "path" }, { name: "snapshotId", in: "query" }] },

  // Agent files
  { method: "GET", path: "/agent/{sessionId}/files", description: "List workspace files", params: [{ name: "sessionId", in: "path" }, { name: "path", in: "query", optional: true }] },
  { method: "GET", path: "/agent/{sessionId}/file", description: "Read a file", params: [{ name: "sessionId", in: "path" }, { name: "path", in: "query" }] },
  { method: "PUT", path: "/agent/{sessionId}/file", description: "Write a file", params: [{ name: "sessionId", in: "path" }, { name: "path", in: "query" }, { name: "content", in: "body" }] },
  { method: "PATCH", path: "/agent/{sessionId}/file", description: "Edit a file (search/replace)", params: [{ name: "sessionId", in: "path" }, { name: "path", in: "query" }, { name: "search", in: "body" }, { name: "replacement", in: "body" }] },
  { method: "POST", path: "/agent/{sessionId}/search", description: "Search files by glob + content", params: [{ name: "sessionId", in: "path" }, { name: "pattern", in: "body" }, { name: "query", in: "body", optional: true }] },

  // Agent git
  { method: "GET", path: "/agent/{sessionId}/git/status", description: "Git status", params: [{ name: "sessionId", in: "path" }, { name: "dir", in: "query", optional: true }] },
  { method: "POST", path: "/agent/{sessionId}/git/clone", description: "Clone a repo", params: [{ name: "sessionId", in: "path" }, { name: "url", in: "body" }, { name: "dir", in: "body", optional: true }, { name: "branch", in: "body", optional: true }] },
  { method: "POST", path: "/agent/{sessionId}/git/add", description: "Stage files", params: [{ name: "sessionId", in: "path" }, { name: "filepath", in: "body" }, { name: "dir", in: "body", optional: true }] },
  { method: "POST", path: "/agent/{sessionId}/git/commit", description: "Commit staged changes", params: [{ name: "sessionId", in: "path" }, { name: "message", in: "body" }, { name: "dir", in: "body", optional: true }] },
  { method: "POST", path: "/agent/{sessionId}/git/push", description: "Push to remote", params: [{ name: "sessionId", in: "path" }, { name: "dir", in: "body", optional: true }, { name: "ref", in: "body", optional: true }] },
  { method: "POST", path: "/agent/{sessionId}/git/push-checked", description: "Push and verify branch", params: [{ name: "sessionId", in: "path" }, { name: "dir", in: "body" }, { name: "ref", in: "body" }, { name: "baseRef", in: "body", optional: true }] },
  { method: "POST", path: "/agent/{sessionId}/git/checkout", description: "Checkout branch", params: [{ name: "sessionId", in: "path" }, { name: "branch", in: "body" }, { name: "dir", in: "body", optional: true }] },
  { method: "GET", path: "/agent/{sessionId}/git/log", description: "Git log", params: [{ name: "sessionId", in: "path" }, { name: "dir", in: "query", optional: true }, { name: "depth", in: "query", optional: true }] },
  { method: "GET", path: "/agent/{sessionId}/git/diff", description: "Git diff", params: [{ name: "sessionId", in: "path" }, { name: "dir", in: "query", optional: true }] },
  { method: "POST", path: "/agent/{sessionId}/git/verify-branch", description: "Verify pushed branch", params: [{ name: "sessionId", in: "path" }, { name: "dir", in: "body" }, { name: "ref", in: "body" }, { name: "baseRef", in: "body", optional: true }] },

  // Code execution
  { method: "POST", path: "/agent/{sessionId}/execute", description: "Execute JS in sandbox", params: [{ name: "sessionId", in: "path" }, { name: "code", in: "body" }] },
];

// ─── Types embedded in tool descriptions ───

const DODO_TYPES = `
interface DodoRequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;      // Use /agent/{sessionId}/... for session-scoped ops, otherwise /sessions, /config, etc.
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

declare const dodo: {
  request<T = unknown>(options: DodoRequestOptions): Promise<T>;
};
`;

const CATALOG_TYPES = `
interface CatalogEntry {
  method: string;
  path: string;
  description: string;
  params: Array<{ name: string; in: "path" | "query" | "body"; optional?: boolean }>;
}

declare const catalog: CatalogEntry[];
`;

// ─── Helpers ───

function mcpUserEmail(env: Env): string {
  const email = resolveAdminEmail(env);
  if (!email) throw new Error("ADMIN_EMAIL must be configured for MCP access. Set it as a secret or in wrangler.jsonc vars.");
  return email;
}

function errorResult(data: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: true };
}

/** Truncate large responses to avoid blowing up the context window. */
function truncateResponse(data: unknown, maxChars = 16_000): string {
  const text = JSON.stringify(data, null, 2);
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n\n... [truncated — ${text.length} chars total]`;
}

// ─── Code-Mode MCP Server ───

export function createDodoCodeModeMcpServer(env: Env, depth = 0): McpServer {
  const server = new McpServer({ name: "dodo-codemode", version: "0.4.0" });

  // --- Search tool: query the API catalog ---
  server.tool("search", `Search the Dodo API catalog to discover available endpoints.

Categories: sessions, config, mcp-configs, tasks, memory, worker-runs, failure-snapshots, agent (files, git, messages, prompts, code execution)

Types:
${CATALOG_TYPES}

Examples:

// Find all session-related endpoints
async () => {
  return catalog.filter(e => e.path.startsWith("/sessions"));
}

// Find all git operations
async () => {
  return catalog.filter(e => e.path.includes("/git/"));
}

// Find endpoints that take a body
async () => {
  return catalog.filter(e => e.params.some(p => p.in === "body"));
}`, {
    code: z.string().describe("JavaScript async arrow function to search the API catalog"),
  }, async ({ code }) => {
    try {
      const fn = new Function("catalog", `return (${code})()`);
      const result = await fn(API_CATALOG);
      return { content: [{ type: "text", text: truncateResponse(result) }] };
    } catch (error) {
      return errorResult({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // --- Execute tool: call dodo.request() ---
  server.tool("execute", `Execute JavaScript code against the Dodo API. First use 'search' to find endpoints, then write code using dodo.request().

Available in your code:
${DODO_TYPES}

Your code must be an async arrow function that returns the result.

Examples:

// List all sessions
async () => {
  return dodo.request({ method: "GET", path: "/sessions" });
}

// Get messages from a session
async () => {
  const sessionId = "abc-123";
  return dodo.request({ method: "GET", path: \`/agent/\${sessionId}/messages\` });
}

// Create a task
async () => {
  return dodo.request({
    method: "POST",
    path: "/tasks",
    body: { title: "Fix the bug", priority: "high" }
  });
}

// Delete an MCP config
async () => {
  return dodo.request({ method: "DELETE", path: "/mcp-configs/some-id" });
}

// Chain operations: list sessions then get the latest one's messages
async () => {
  const { sessions } = await dodo.request({ method: "GET", path: "/sessions" });
  if (!sessions.length) return { error: "No sessions" };
  const latest = sessions[0];
  const messages = await dodo.request({ method: "GET", path: \`/agent/\${latest.id}/messages\` });
  return { session: latest, messages };
}`, {
    code: z.string().describe("JavaScript async arrow function to execute"),
  }, async ({ code }) => {
    try {
      const dodoClient = buildDodoClient(env, depth);
      const fn = new Function("dodo", `return (${code})()`);
      const result = await fn(dodoClient);
      return { content: [{ type: "text", text: truncateResponse(result) }] };
    } catch (error) {
      return errorResult({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return server;
}

// ─── Dodo Client ───
// Routes requests to the appropriate internal Durable Object (UserControl or CodingAgent).

function buildDodoClient(env: Env, depth: number) {
  const email = mcpUserEmail(env);

  return {
    async request(options: { method: string; path: string; query?: Record<string, string | number | boolean | undefined>; body?: unknown }) {
      const { method, path, query, body } = options;

      // Determine target based on path prefix
      const isAgentPath = path.startsWith("/agent/");

      let targetPath = path;
      let sessionId: string | undefined;

      if (isAgentPath) {
        // Extract sessionId from /agent/{sessionId}/...
        const match = path.match(/^\/agent\/([^/]+)(\/.*)?$/);
        if (!match) throw new Error(`Invalid agent path: ${path}`);
        sessionId = match[1];
        targetPath = match[2] || "/";
      }

      // Build URL with query params
      const url = new URL(`https://internal${targetPath}`);
      if (query) {
        for (const [key, value] of Object.entries(query)) {
          if (value !== undefined) url.searchParams.set(key, String(value));
        }
      }

      const headers = new Headers();
      headers.set("x-owner-email", email);
      if (body) headers.set("content-type", "application/json");

      const init: RequestInit = { method, headers };
      if (body) init.body = JSON.stringify(body);

      let res: Response;
      if (isAgentPath && sessionId) {
        // Route to CodingAgent DO
        const agent = await getAgentByName(env.CODING_AGENT as never, sessionId);
        const agentHeaders = new Headers(headers);
        agentHeaders.set("x-dodo-session-id", sessionId);
        agentHeaders.set("x-dodo-mcp-depth", String(depth + 1));
        res = await agent.fetch(new Request(`https://coding-agent${targetPath}${url.search}`, { ...init, headers: agentHeaders }));
      } else {
        // Route to UserControl DO
        const stub = getUserControlStub(env, email);
        res = await stub.fetch(new Request(`https://user-control${targetPath}${url.search}`, init));
      }

      if (!res.ok) {
        const errorBody = await res.text();
        let detail = errorBody;
        try {
          const parsed = JSON.parse(errorBody);
          if (parsed.error) detail = parsed.error;
        } catch { /* not JSON */ }
        throw new Error(`Dodo API error ${res.status}: ${detail}`);
      }

      return res.json();
    },
  };
}


