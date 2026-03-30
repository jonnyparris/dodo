import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAgentByName } from "agents";
import { z } from "zod";
import { getSharedIndexStub, getUserControlStub } from "./auth";
import type { Env } from "./types";

// MCP uses the admin email for all operations since MCP is token-authenticated
// (no CF Access identity available). In Phase 2, MCP can pass user context.
function mcpUserEmail(env: Env): string {
  return env.ADMIN_EMAIL ?? "you@example.com";
}

async function userControlFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const email = mcpUserEmail(env);
  const stub = getUserControlStub(env, email);
  const headers = new Headers(init?.headers);
  headers.set("x-owner-email", email);
  return stub.fetch(`https://user-control${path}`, { ...init, headers });
}

async function sharedIndexFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const stub = getSharedIndexStub(env);
  return stub.fetch(`https://shared-index${path}`, init);
}

async function agentFetch(env: Env, sessionId: string, path: string, init?: RequestInit): Promise<Response> {
  const agent = await getAgentByName(env.CODING_AGENT as never, sessionId);
  const headers = new Headers(init?.headers);
  headers.set("x-dodo-session-id", sessionId);
  headers.set("x-owner-email", mcpUserEmail(env));

  // Inject gateway config for message/prompt routes
  if (path === "/message" || path === "/prompt") {
    const configRes = await userControlFetch(env, "/config");
    const config = (await configRes.json()) as Record<string, string>;
    headers.set("x-dodo-gateway", config.activeGateway ?? "opencode");
    headers.set("x-dodo-model", config.model ?? "");
    headers.set("x-dodo-opencode-base-url", config.opencodeBaseURL ?? "");
    headers.set("x-dodo-ai-base-url", config.aiGatewayBaseURL ?? "");
    headers.set("x-author-email", mcpUserEmail(env));
  }

  return agent.fetch(new Request(`https://coding-agent${path}`, { ...init, headers }));
}

function textResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

async function jsonFetch(env: Env, fetcher: "user" | "shared" | "agent", path: string, opts?: { sessionId?: string; init?: RequestInit }): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  let res: Response;
  if (fetcher === "user") {
    res = await userControlFetch(env, path, opts?.init);
  } else if (fetcher === "shared") {
    res = await sharedIndexFetch(env, path, opts?.init);
  } else {
    res = await agentFetch(env, opts?.sessionId ?? "", path, opts?.init);
  }
  const data = await res.json();
  return textResult(data);
}

export function createDodoMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "dodo", version: "0.3.0" });

  // --- Session tools ---

  server.tool("list_sessions", "List all Dodo coding sessions", {}, async () =>
    jsonFetch(env, "user", "/sessions"),
  );

  server.tool("create_session", "Create a new Dodo coding session", {}, async () => {
    const sessionId = crypto.randomUUID();
    const email = mcpUserEmail(env);
    await userControlFetch(env, "/sessions", {
      body: JSON.stringify({ id: sessionId, ownerEmail: email, createdBy: email }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    return textResult({ id: sessionId });
  });

  server.tool("get_session", "Get the state of a Dodo session", { sessionId: z.string().describe("Session ID") }, async ({ sessionId }) =>
    jsonFetch(env, "agent", "/", { sessionId }),
  );

  server.tool("delete_session", "Delete a Dodo session and its storage", { sessionId: z.string().describe("Session ID") }, async ({ sessionId }) => {
    const result = await agentFetch(env, sessionId, "/", { method: "DELETE" });
    await userControlFetch(env, `/sessions/${sessionId}`, { method: "DELETE" });
    return textResult(await result.json());
  });

  server.tool("fork_session", "Fork a session (copy files + messages into a new session)", { sessionId: z.string().describe("Source session ID") }, async ({ sessionId }) => {
    const snapshotRes = await agentFetch(env, sessionId, "/snapshot");
    const snapshot = await snapshotRes.text();
    const storeRes = await userControlFetch(env, "/fork-snapshots", { body: snapshot, headers: { "content-type": "application/json" }, method: "POST" });
    const { id: snapshotId } = (await storeRes.json()) as { id: string };
    const newId = crypto.randomUUID();
    const email = mcpUserEmail(env);
    await userControlFetch(env, "/sessions", { body: JSON.stringify({ id: newId, ownerEmail: email, createdBy: email }), headers: { "content-type": "application/json" }, method: "POST" });
    await agentFetch(env, newId, `/snapshot/import?snapshotId=${encodeURIComponent(snapshotId)}`, { method: "POST" });
    await userControlFetch(env, `/fork-snapshots/${encodeURIComponent(snapshotId)}`, { method: "DELETE" });
    return textResult({ id: newId, sourceId: sessionId });
  });

  // --- File tools ---

  server.tool("list_files", "List files in a session's workspace", {
    sessionId: z.string().describe("Session ID"),
    path: z.string().default("/").describe("Directory path"),
  }, async ({ sessionId, path }) =>
    jsonFetch(env, "agent", `/files?path=${encodeURIComponent(path)}`, { sessionId }),
  );

  server.tool("read_file", "Read a file from a session's workspace", {
    sessionId: z.string().describe("Session ID"),
    path: z.string().describe("File path"),
  }, async ({ sessionId, path }) =>
    jsonFetch(env, "agent", `/file?path=${encodeURIComponent(path)}`, { sessionId }),
  );

  server.tool("write_file", "Write a file to a session's workspace", {
    sessionId: z.string().describe("Session ID"),
    path: z.string().describe("File path"),
    content: z.string().describe("File content"),
  }, async ({ sessionId, path, content }) =>
    jsonFetch(env, "agent", `/file?path=${encodeURIComponent(path)}`, {
      sessionId,
      init: { body: JSON.stringify({ content }), headers: { "content-type": "application/json" }, method: "PUT" },
    }),
  );

  server.tool("search_files", "Search workspace files by glob pattern and content query", {
    sessionId: z.string().describe("Session ID"),
    pattern: z.string().describe("Glob pattern (e.g. **/*.ts)"),
    query: z.string().describe("Content search query"),
  }, async ({ sessionId, pattern, query }) =>
    jsonFetch(env, "agent", "/search", {
      sessionId,
      init: { body: JSON.stringify({ pattern, query }), headers: { "content-type": "application/json" }, method: "POST" },
    }),
  );

  // --- Code execution ---

  server.tool("execute_code", "Execute JavaScript code in a sandboxed Worker against the session workspace", {
    sessionId: z.string().describe("Session ID"),
    code: z.string().describe("JavaScript code to execute"),
  }, async ({ sessionId, code }) =>
    jsonFetch(env, "agent", "/execute", {
      sessionId,
      init: { body: JSON.stringify({ code }), headers: { "content-type": "application/json" }, method: "POST" },
    }),
  );

  // --- Chat tools ---

  server.tool("send_message", "Send a synchronous message to the Dodo coding agent (waits for full response)", {
    sessionId: z.string().describe("Session ID"),
    content: z.string().describe("Message content"),
  }, async ({ sessionId, content }) =>
    jsonFetch(env, "agent", "/message", {
      sessionId,
      init: { body: JSON.stringify({ content }), headers: { "content-type": "application/json" }, method: "POST" },
    }),
  );

  server.tool("send_prompt", "Dispatch an async prompt to Dodo (returns immediately, runs in background)", {
    sessionId: z.string().describe("Session ID"),
    content: z.string().describe("Prompt content"),
  }, async ({ sessionId, content }) =>
    jsonFetch(env, "agent", "/prompt", {
      sessionId,
      init: { body: JSON.stringify({ content }), headers: { "content-type": "application/json" }, method: "POST" },
    }),
  );

  server.tool("abort_prompt", "Abort a running async prompt", {
    sessionId: z.string().describe("Session ID"),
  }, async ({ sessionId }) =>
    jsonFetch(env, "agent", "/abort", { sessionId, init: { method: "POST", body: "{}", headers: { "content-type": "application/json" } } }),
  );

  server.tool("get_messages", "Get message history for a session", {
    sessionId: z.string().describe("Session ID"),
  }, async ({ sessionId }) =>
    jsonFetch(env, "agent", "/messages", { sessionId }),
  );

  server.tool("get_prompts", "Get prompt history for a session", {
    sessionId: z.string().describe("Session ID"),
  }, async ({ sessionId }) =>
    jsonFetch(env, "agent", "/prompts", { sessionId }),
  );

  // --- Git tools ---

  server.tool("git_status", "Get git status for a session workspace", {
    sessionId: z.string().describe("Session ID"),
    dir: z.string().optional().describe("Repo directory path"),
  }, async ({ sessionId, dir }) =>
    jsonFetch(env, "agent", `/git/status${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`, { sessionId }),
  );

  server.tool("git_init", "Initialize a git repo in the session workspace", {
    sessionId: z.string().describe("Session ID"),
    dir: z.string().optional().describe("Directory to init in"),
  }, async ({ sessionId, dir }) =>
    jsonFetch(env, "agent", "/git/init", {
      sessionId,
      init: { body: JSON.stringify({ dir }), headers: { "content-type": "application/json" }, method: "POST" },
    }),
  );

  server.tool("git_add", "Stage files in a session's git repo", {
    sessionId: z.string().describe("Session ID"),
    filepath: z.string().default(".").describe("File or directory to stage"),
    dir: z.string().optional().describe("Repo directory path"),
  }, async ({ sessionId, filepath, dir }) =>
    jsonFetch(env, "agent", "/git/add", {
      sessionId,
      init: { body: JSON.stringify({ filepath, dir }), headers: { "content-type": "application/json" }, method: "POST" },
    }),
  );

  server.tool("git_commit", "Commit staged changes in a session's git repo", {
    sessionId: z.string().describe("Session ID"),
    message: z.string().describe("Commit message"),
    dir: z.string().optional().describe("Repo directory path"),
  }, async ({ sessionId, message, dir }) =>
    jsonFetch(env, "agent", "/git/commit", {
      sessionId,
      init: { body: JSON.stringify({ message, dir }), headers: { "content-type": "application/json" }, method: "POST" },
    }),
  );

  server.tool("git_log", "Get git log for a session's repo", {
    sessionId: z.string().describe("Session ID"),
    dir: z.string().optional().describe("Repo directory path"),
    depth: z.number().optional().describe("Number of commits to show"),
  }, async ({ sessionId, dir, depth }) => {
    const params = new URLSearchParams();
    if (dir) params.set("dir", dir);
    if (depth) params.set("depth", String(depth));
    return jsonFetch(env, "agent", `/git/log?${params}`, { sessionId });
  });

  server.tool("git_diff", "Get git diff for a session's repo", {
    sessionId: z.string().describe("Session ID"),
    dir: z.string().optional().describe("Repo directory path"),
  }, async ({ sessionId, dir }) =>
    jsonFetch(env, "agent", `/git/diff${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`, { sessionId }),
  );

  server.tool("git_clone", "Clone a git repo into the session workspace", {
    sessionId: z.string().describe("Session ID"),
    url: z.string().describe("Git repo URL"),
    dir: z.string().optional().describe("Target directory"),
    branch: z.string().optional().describe("Branch to clone"),
    depth: z.number().optional().describe("Clone depth (shallow clone)"),
  }, async ({ sessionId, url, dir, branch, depth }) =>
    jsonFetch(env, "agent", "/git/clone", {
      sessionId,
      init: { body: JSON.stringify({ url, dir, branch, depth }), headers: { "content-type": "application/json" }, method: "POST" },
    }),
  );

  server.tool("git_push", "Push commits to remote", {
    sessionId: z.string().describe("Session ID"),
    dir: z.string().optional().describe("Repo directory path"),
    remote: z.string().optional().describe("Remote name (default: origin)"),
    ref: z.string().optional().describe("Branch ref to push"),
    force: z.boolean().optional().describe("Force push"),
  }, async ({ sessionId, dir, remote, ref, force }) =>
    jsonFetch(env, "agent", "/git/push", {
      sessionId,
      init: { body: JSON.stringify({ dir, remote, ref, force }), headers: { "content-type": "application/json" }, method: "POST" },
    }),
  );

  // --- Memory tools (per-user) ---

  server.tool("memory_search", "Search Dodo's persistent memory store", {
    query: z.string().default("").describe("Search query (empty for all)"),
  }, async ({ query }) =>
    jsonFetch(env, "user", `/memory${query ? `?q=${encodeURIComponent(query)}` : ""}`),
  );

  server.tool("memory_write", "Write an entry to Dodo's memory store", {
    title: z.string().describe("Entry title"),
    content: z.string().describe("Entry content"),
    tags: z.array(z.string()).default([]).describe("Tags"),
  }, async ({ title, content, tags }) =>
    jsonFetch(env, "user", "/memory", {
      init: { body: JSON.stringify({ title, content, tags }), headers: { "content-type": "application/json" }, method: "POST" },
    }),
  );

  // --- Config tools (per-user) ---

  server.tool("get_config", "Get Dodo's current LLM and git configuration", {}, async () =>
    jsonFetch(env, "user", "/config"),
  );

  server.tool("update_config", "Update Dodo's LLM gateway, model, or git author config", {
    model: z.string().optional().describe("Model ID"),
    activeGateway: z.enum(["opencode", "ai-gateway"]).optional().describe("LLM gateway"),
  }, async (params) =>
    jsonFetch(env, "user", "/config", {
      init: { body: JSON.stringify(params), headers: { "content-type": "application/json" }, method: "PUT" },
    }),
  );

  // --- Task tools (per-user) ---

  server.tool("list_tasks", "List all tasks in the Dodo backlog", {
    status: z.string().optional().describe("Filter by status: backlog, todo, in_progress, done, cancelled"),
  }, async ({ status }) =>
    jsonFetch(env, "user", `/tasks${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  );

  server.tool("create_task", "Create a new task in the Dodo backlog", {
    title: z.string().describe("Task title"),
    description: z.string().default("").describe("Task description"),
    priority: z.enum(["low", "medium", "high"]).default("medium").describe("Task priority"),
  }, async ({ title, description, priority }) =>
    jsonFetch(env, "user", "/tasks", {
      init: { body: JSON.stringify({ title, description, priority }), headers: { "content-type": "application/json" }, method: "POST" },
    }),
  );

  server.tool("update_task", "Update a task's status, title, description, or priority", {
    id: z.string().describe("Task ID"),
    title: z.string().optional().describe("New title"),
    description: z.string().optional().describe("New description"),
    status: z.enum(["backlog", "todo", "in_progress", "done", "cancelled"]).optional().describe("New status"),
    priority: z.enum(["low", "medium", "high"]).optional().describe("New priority"),
  }, async ({ id, ...patch }) =>
    jsonFetch(env, "user", `/tasks/${encodeURIComponent(id)}`, {
      init: { body: JSON.stringify(patch), headers: { "content-type": "application/json" }, method: "PUT" },
    }),
  );

  server.tool("delete_task", "Delete a task from the backlog", {
    id: z.string().describe("Task ID"),
  }, async ({ id }) =>
    jsonFetch(env, "user", `/tasks/${encodeURIComponent(id)}`, { init: { method: "DELETE" } }),
  );

  return server;
}
