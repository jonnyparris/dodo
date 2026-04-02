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

async function agentFetch(env: Env, sessionId: string, path: string, init?: RequestInit, depth = 0): Promise<Response> {
  const agent = await getAgentByName(env.CODING_AGENT as never, sessionId);
  const headers = new Headers(init?.headers);
  headers.set("x-dodo-session-id", sessionId);
  headers.set("x-owner-email", mcpUserEmail(env));
  headers.set("x-dodo-mcp-depth", String(depth + 1));

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

function errorResult(data: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: true };
}

async function jsonFetch(env: Env, fetcher: "user" | "shared" | "agent", path: string, opts?: { sessionId?: string; init?: RequestInit; depth?: number }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
  let res: Response;
  if (fetcher === "user") {
    res = await userControlFetch(env, path, opts?.init);
  } else if (fetcher === "shared") {
    res = await sharedIndexFetch(env, path, opts?.init);
  } else {
    res = await agentFetch(env, opts?.sessionId ?? "", path, opts?.init, opts?.depth ?? 0);
  }
  const data = await res.json();
  if (!res.ok) {
    return errorResult(data);
  }
  return textResult(data);
}

export function createDodoMcpServer(env: Env, depth = 0): McpServer {
  const server = new McpServer({ name: "dodo", version: "0.4.0" });

  // --- Session tools ---

  server.tool("list_sessions", "List all Dodo coding sessions", {}, async () =>
    jsonFetch(env, "user", "/sessions"),
  );

  server.tool("create_session", "Create a new Dodo coding session", {}, async () => {
    const sessionId = crypto.randomUUID();
    const email = mcpUserEmail(env);
    const res = await userControlFetch(env, "/sessions", {
      body: JSON.stringify({ id: sessionId, ownerEmail: email, createdBy: email }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const session = await res.json();
    return textResult(session);
  });

  server.tool("get_session", "Get the state of a Dodo session", { sessionId: z.string().describe("Session ID") }, async ({ sessionId }) => {
    // Verify the session exists in UserControl before querying the agent
    const checkRes = await userControlFetch(env, `/sessions/${encodeURIComponent(sessionId)}/check`);
    if (!checkRes.ok) {
      return errorResult({ error: `Session '${sessionId}' not found. Run list_sessions to see available sessions.` });
    }
    return jsonFetch(env, "agent", "/", { sessionId, depth });
  });

  server.tool("delete_session", "Delete a Dodo session and its storage. The session can be restored within 5 minutes using restore_session.", { sessionId: z.string().describe("Session ID") }, async ({ sessionId }) => {
    // Verify the session exists before deleting
    const checkRes = await userControlFetch(env, `/sessions/${encodeURIComponent(sessionId)}/check`);
    if (!checkRes.ok) {
      return errorResult({ error: `Session '${sessionId}' not found. Run list_sessions to see available sessions.` });
    }
    const result = await agentFetch(env, sessionId, "/", { method: "DELETE" }, depth);
    // Soft-delete in UserControl (marks as deleted, auto-purges after 5 minutes)
    await userControlFetch(env, `/sessions/${encodeURIComponent(sessionId)}/soft-delete`, { method: "POST" });
    const data = await result.json();
    return textResult({ ...data as object, sessionId, recoverable: true, recoverableUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString() });
  });

  server.tool("bulk_delete_sessions", "Delete all sessions whose title starts with a given prefix. Skips sessions with running prompts.", {
    titlePrefix: z.string().min(3).describe("Delete all sessions whose title starts with this prefix"),
  }, async ({ titlePrefix }) => {
    const listRes = await userControlFetch(env, "/sessions");
    const { sessions } = (await listRes.json()) as { sessions: Array<{ id: string; title?: string; status?: string }> };
    const matching = sessions.filter((s) => s.title?.startsWith(titlePrefix));
    if (matching.length === 0) {
      return textResult({ deleted: 0, skipped: [], message: `No sessions found with title prefix "${titlePrefix}"` });
    }

    let deleted = 0;
    const skipped: string[] = [];
    for (const session of matching) {
      if (session.status === "running") {
        skipped.push(`${session.id} (running)`);
        continue;
      }
      try {
        await agentFetch(env, session.id, "/", { method: "DELETE" }, depth);
        await userControlFetch(env, `/sessions/${encodeURIComponent(session.id)}/soft-delete`, { method: "POST" });
        deleted++;
      } catch {
        skipped.push(`${session.id} (error)`);
      }
    }
    return textResult({ deleted, skipped });
  });

  server.tool("restore_session", "Restore a recently deleted session (within 5 minutes of deletion)", { sessionId: z.string().describe("Session ID to restore") }, async ({ sessionId }) => {
    const res = await userControlFetch(env, `/sessions/${encodeURIComponent(sessionId)}/restore`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      return errorResult(data);
    }
    return textResult(data);
  });

  server.tool("fork_session", "Fork a session (copy files + messages into a new session)", { sessionId: z.string().describe("Source session ID") }, async ({ sessionId }) => {
    // Verify the source session exists
    const checkRes = await userControlFetch(env, `/sessions/${encodeURIComponent(sessionId)}/check`);
    if (!checkRes.ok) {
      return errorResult({ error: `Source session '${sessionId}' not found. Run list_sessions to see available sessions.` });
    }
    const snapshotRes = await agentFetch(env, sessionId, "/snapshot", undefined, depth);
    const snapshot = await snapshotRes.text();
    const storeRes = await userControlFetch(env, "/fork-snapshots", { body: snapshot, headers: { "content-type": "application/json" }, method: "POST" });
    const { id: snapshotId } = (await storeRes.json()) as { id: string };
    const newId = crypto.randomUUID();
    const email = mcpUserEmail(env);
    await userControlFetch(env, "/sessions", { body: JSON.stringify({ id: newId, ownerEmail: email, createdBy: email }), headers: { "content-type": "application/json" }, method: "POST" });
    await agentFetch(env, newId, `/snapshot/import?snapshotId=${encodeURIComponent(snapshotId)}`, { method: "POST" }, depth);
    await userControlFetch(env, `/fork-snapshots/${encodeURIComponent(snapshotId)}`, { method: "DELETE" });
    return textResult({ sessionId: newId, sourceSessionId: sessionId, forkedAt: new Date().toISOString() });
  });

  // --- File tools ---

  server.tool("list_files", "List files in a session's workspace", {
    sessionId: z.string().describe("Session ID"),
    path: z.string().default("/").describe("Directory path"),
  }, async ({ sessionId, path }) =>
    jsonFetch(env, "agent", `/files?path=${encodeURIComponent(path)}`, { sessionId, depth }),
  );

  server.tool("read_file", "Read a file from a session's workspace", {
    sessionId: z.string().describe("Session ID"),
    path: z.string().describe("File path"),
  }, async ({ sessionId, path }) =>
    jsonFetch(env, "agent", `/file?path=${encodeURIComponent(path)}`, { sessionId, depth }),
  );

  server.tool("write_file", "Write a file to a session's workspace", {
    sessionId: z.string().describe("Session ID"),
    path: z.string().describe("File path"),
    content: z.string().describe("File content"),
  }, async ({ sessionId, path, content }) =>
    jsonFetch(env, "agent", `/file?path=${encodeURIComponent(path)}`, {
      sessionId,
      depth,
      init: { body: JSON.stringify({ content }), headers: { "content-type": "application/json" }, method: "PUT" },
    }),
  );

  server.tool("search_files", "Search workspace files by glob pattern and optional content query", {
    sessionId: z.string().describe("Session ID"),
    pattern: z.string().describe("Glob pattern (e.g. **/*.ts)"),
    query: z.string().optional().describe("Content search query (omit to match by filename only)"),
  }, async ({ sessionId, pattern, query }) =>
    jsonFetch(env, "agent", "/search", {
      sessionId,
      depth,
      init: { body: JSON.stringify({ pattern, query: query ?? "" }), headers: { "content-type": "application/json" }, method: "POST" },
    }),
  );

  // --- Code execution ---

  server.tool("execute_code", "Execute JavaScript code in a sandboxed Worker against the session workspace", {
    sessionId: z.string().describe("Session ID"),
    code: z.string().describe("JavaScript code to execute"),
  }, async ({ sessionId, code }) =>
    jsonFetch(env, "agent", "/execute", {
      sessionId,
      depth,
      init: { body: JSON.stringify({ code }), headers: { "content-type": "application/json" }, method: "POST" },
    }),
  );

  // --- Chat tools ---

  server.tool("send_message", "Send a synchronous message to the Dodo coding agent and wait for the full response", {
    sessionId: z.string().describe("Session ID"),
    content: z.string().describe("Message content"),
  }, async ({ sessionId, content }) =>
    jsonFetch(env, "agent", "/message", {
      sessionId,
      depth,
      init: { body: JSON.stringify({ content }), headers: { "content-type": "application/json" }, method: "POST" },
    }),
  );

  server.tool("send_prompt", "Send an async message to the Dodo coding agent (returns immediately, runs in background). Use get_prompts to check status.", {
    sessionId: z.string().describe("Session ID"),
    content: z.string().describe("Prompt content"),
  }, async ({ sessionId, content }) =>
    jsonFetch(env, "agent", "/prompt", {
      sessionId,
      depth,
      init: { body: JSON.stringify({ content }), headers: { "content-type": "application/json" }, method: "POST" },
    }),
  );

  server.tool("abort_prompt", "Abort a running async prompt", {
    sessionId: z.string().describe("Session ID"),
  }, async ({ sessionId }) =>
    jsonFetch(env, "agent", "/abort", { sessionId, depth, init: { method: "POST", body: "{}", headers: { "content-type": "application/json" } } }),
  );

  server.tool("get_messages", "Get message history for a session", {
    sessionId: z.string().describe("Session ID"),
  }, async ({ sessionId }) =>
    jsonFetch(env, "agent", "/messages", { sessionId, depth }),
  );

  server.tool("get_prompts", "Get prompt history for a session", {
    sessionId: z.string().describe("Session ID"),
  }, async ({ sessionId }) =>
    jsonFetch(env, "agent", "/prompts", { sessionId, depth }),
  );

  // --- Git tools ---

  server.tool("git_status", "Get git status for a session workspace", {
    sessionId: z.string().describe("Session ID"),
    dir: z.string().optional().describe("Repo directory path"),
  }, async ({ sessionId, dir }) =>
    jsonFetch(env, "agent", `/git/status${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`, { sessionId, depth }),
  );

  server.tool("git_init", "Initialize a git repo in the session workspace", {
    sessionId: z.string().describe("Session ID"),
    dir: z.string().optional().describe("Directory to init in"),
  }, async ({ sessionId, dir }) =>
    jsonFetch(env, "agent", "/git/init", {
      sessionId,
      depth,
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
      depth,
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
      depth,
      init: { body: JSON.stringify({ message, dir }), headers: { "content-type": "application/json" }, method: "POST" },
    }),
  );

  server.tool("git_log", "Get git log for a session's repo", {
    sessionId: z.string().describe("Session ID"),
    dir: z.string().optional().describe("Repo directory path"),
    depth: z.number().optional().describe("Number of commits to show"),
  }, async ({ sessionId, dir, depth: logDepth }) => {
    const params = new URLSearchParams();
    if (dir) params.set("dir", dir);
    if (logDepth) params.set("depth", String(logDepth));
    return jsonFetch(env, "agent", `/git/log?${params}`, { sessionId, depth });
  });

  server.tool("git_diff", "Get git diff for a session's repo", {
    sessionId: z.string().describe("Session ID"),
    dir: z.string().optional().describe("Repo directory path"),
  }, async ({ sessionId, dir }) =>
    jsonFetch(env, "agent", `/git/diff${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`, { sessionId, depth }),
  );

  server.tool("git_clone", "Clone a git repo into the session workspace", {
    sessionId: z.string().describe("Session ID"),
    url: z.string().describe("Git repo URL"),
    dir: z.string().optional().describe("Target directory"),
    branch: z.string().optional().describe("Branch to clone"),
    depth: z.number().optional().describe("Clone depth (shallow clone)"),
  }, async ({ sessionId, url, dir, branch, depth: cloneDepth }) =>
    jsonFetch(env, "agent", "/git/clone", {
      sessionId,
      depth,
      init: { body: JSON.stringify({ url, dir, branch, depth: cloneDepth }), headers: { "content-type": "application/json" }, method: "POST" },
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
      depth,
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

  // --- MCP Config tools ---

  server.tool("add_mcp_config", "Add an MCP integration. Bypasses host allowlist (MCP is trusted).", {
    name: z.string().describe("Integration name"),
    url: z.string().url().describe("MCP server URL"),
    authToken: z.string().optional().describe("Bearer token for Authorization header"),
    sessionId: z.string().optional().describe("If provided, only enable for this session"),
  }, async ({ name, url, authToken, sessionId: targetSessionId }) => {
    const headers: Record<string, string> = {};
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }

    // Create the config via UserControl directly (bypasses index.ts host allowlist)
    const res = await userControlFetch(env, "/mcp-configs", {
      body: JSON.stringify({ name, type: "http", url, headers: Object.keys(headers).length > 0 ? headers : undefined, enabled: true }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    if (!res.ok) {
      const err = await res.json();
      return errorResult(err);
    }

    const config = (await res.json()) as { id: string; name: string; url?: string };

    // If sessionId provided, enable only for that session via override
    if (targetSessionId) {
      await userControlFetch(env, `/sessions/${encodeURIComponent(targetSessionId)}/mcp-overrides`, {
        body: JSON.stringify({ mcpConfigId: config.id, enabled: true }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    }

    return textResult({ ...config, scopedToSession: targetSessionId ?? null });
  });

  server.tool("list_mcp_configs", "List configured MCP integrations with id, name, url, and enabled status", {}, async () =>
    jsonFetch(env, "user", "/mcp-configs"),
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

  server.tool("update_task", "Update a task's status, title, description, priority, or linked session", {
    id: z.string().describe("Task ID"),
    title: z.string().optional().describe("New title"),
    description: z.string().optional().describe("New description"),
    status: z.enum(["backlog", "todo", "in_progress", "done", "cancelled"]).optional().describe("New status"),
    priority: z.enum(["low", "medium", "high"]).optional().describe("New priority"),
    session_id: z.string().nullable().optional().describe("Session ID to link (null to unlink)"),
  }, async ({ id, ...patch }) =>
    jsonFetch(env, "user", `/tasks/${encodeURIComponent(id)}`, {
      init: { body: JSON.stringify(patch), headers: { "content-type": "application/json" }, method: "PUT" },
    }),
  );

  server.tool("delete_task", "Delete a task from the backlog", {
    id: z.string().describe("Task ID"),
  }, async ({ id }) => {
    // Verify the task exists before deleting
    const checkRes = await userControlFetch(env, `/tasks/${encodeURIComponent(id)}/check`);
    if (!checkRes.ok) {
      return errorResult({ error: `Task '${id}' not found. Run list_tasks to see available tasks.` });
    }
    return jsonFetch(env, "user", `/tasks/${encodeURIComponent(id)}`, { init: { method: "DELETE" } });
  });

  return server;
}
