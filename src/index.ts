import { getAgentByName } from "agents";
import { createMcpHandler } from "agents/mcp";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { AppControl } from "./app-control";
import { AuthError, verifyAccess } from "./auth";
import { CodingAgent } from "./coding-agent";
import { createDodoMcpServer } from "./mcp";
import type { AppConfig, Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({ origin: "*", allowHeaders: ["Content-Type", "x-dodo-session-id"], allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }));

async function getControlStub(env: Env): Promise<DurableObjectStub> {
  return env.APP_CONTROL.get(env.APP_CONTROL.idFromName("global"));
}

async function readConfig(env: Env): Promise<AppConfig> {
  const stub = await getControlStub(env);
  const response = await stub.fetch("https://app-control/config");
  return (await response.json()) as AppConfig;
}

async function proxyToControl(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const stub = await getControlStub(env);
  return stub.fetch(`https://app-control${path}`, init);
}

async function requireAuth(c: { req: { raw: Request }; env: Env; json: (data: unknown, status?: number) => Response }, next: () => Promise<void>): Promise<Response | void> {
  if (new URL(c.req.raw.url).pathname === "/health") {
    return next();
  }

  try {
    await verifyAccess(c.req.raw, c.env);
  } catch (error) {
    if (error instanceof AuthError) {
      return c.json({ error: error.message }, error.status);
    }
    return c.json({ error: "Authentication failed" }, 403);
  }
  return next();
}

function proxyRequest(url: string, request: Request, headers: Headers): Request {
  const init: RequestInit = {
    body: request.body,
    headers,
    method: request.method,
  };
  if (request.body) {
    (init as Record<string, unknown>).duplex = "half";
  }
  return new Request(url, init);
}

async function proxyToAgent(request: Request, env: Env, sessionId: string, path: string, extraHeaders?: HeadersInit): Promise<Response> {
  const agent = await getAgentByName(env.CODING_AGENT as never, sessionId);
  const headers = new Headers(request.headers);
  headers.set("x-dodo-session-id", sessionId);

  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => {
      headers.set(key, value);
    });
  }

  return agent.fetch(proxyRequest(`https://coding-agent${path}`, request, headers));
}

app.all("/mcp", async (c) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");
  if (!c.env.DODO_MCP_TOKEN || token !== c.env.DODO_MCP_TOKEN) {
    return c.json({ error: "Invalid or missing MCP token" }, 401);
  }
  const server = createDodoMcpServer(c.env);
  const handler = createMcpHandler(server);
  return handler(c.req.raw, c.env, c.executionCtx);
});

app.use("*", requireAuth);

app.get("/", async (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }

  return new Response("Dodo", { headers: { "content-type": "text/plain" } });
});

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/docs", async (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(new Request(new URL("/docs.html", c.req.url), c.req.raw));
  }
  return new Response("Docs not available", { status: 404 });
});

app.get("/api/config", async (c) => {
  const stub = await getControlStub(c.env);
  return stub.fetch("https://app-control/config");
});

app.put("/api/config", async (c) => {
  return proxyToControl(c.env, "/config", {
    body: await c.req.raw.text(),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
});

app.get("/api/allowlist", async (c) => proxyToControl(c.env, "/allowlist"));

app.post("/api/allowlist", async (c) =>
  proxyToControl(c.env, "/allowlist", {
    body: await c.req.raw.text(),
    headers: { "content-type": "application/json" },
    method: "POST",
  }),
);

app.delete("/api/allowlist/:hostname", async (c) =>
  proxyToControl(c.env, `/allowlist/${encodeURIComponent(c.req.param("hostname"))}`, { method: "DELETE" }),
);

app.get("/api/allowlist/check", async (c) => proxyToControl(c.env, `/allowlist/check${new URL(c.req.raw.url).search}`));

app.get("/api/memory", async (c) => proxyToControl(c.env, `/memory${new URL(c.req.raw.url).search}`));

app.post("/api/memory", async (c) =>
  proxyToControl(c.env, "/memory", {
    body: await c.req.raw.text(),
    headers: { "content-type": "application/json" },
    method: "POST",
  }),
);

app.get("/api/memory/:id", async (c) => proxyToControl(c.env, `/memory/${encodeURIComponent(c.req.param("id"))}`));

app.put("/api/memory/:id", async (c) =>
  proxyToControl(c.env, `/memory/${encodeURIComponent(c.req.param("id"))}`, {
    body: await c.req.raw.text(),
    headers: { "content-type": "application/json" },
    method: "PUT",
  }),
);

app.delete("/api/memory/:id", async (c) => proxyToControl(c.env, `/memory/${encodeURIComponent(c.req.param("id"))}`, { method: "DELETE" }));

app.get("/api/models", async (c) => proxyToControl(c.env, "/models"));

app.get("/api/status", async (c) => proxyToControl(c.env, "/status"));

app.get("/api/tasks", async (c) => proxyToControl(c.env, `/tasks${new URL(c.req.raw.url).search}`));

app.post("/api/tasks", async (c) =>
  proxyToControl(c.env, "/tasks", {
    body: await c.req.raw.text(),
    headers: { "content-type": "application/json" },
    method: "POST",
  }),
);

app.put("/api/tasks/:id", async (c) =>
  proxyToControl(c.env, `/tasks/${encodeURIComponent(c.req.param("id"))}`, {
    body: await c.req.raw.text(),
    headers: { "content-type": "application/json" },
    method: "PUT",
  }),
);

app.delete("/api/tasks/:id", async (c) => proxyToControl(c.env, `/tasks/${encodeURIComponent(c.req.param("id"))}`, { method: "DELETE" }));

app.post("/session", async (c) => {
  const sessionId = crypto.randomUUID();
  const stub = await getControlStub(c.env);
  await stub.fetch("https://app-control/sessions", {
    body: JSON.stringify({ id: sessionId }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  return c.json({ id: sessionId }, 201);
});

app.get("/session", async (c) => {
  const stub = await getControlStub(c.env);
  return stub.fetch("https://app-control/sessions");
});

app.get("/session/:id", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/"));

app.delete("/session/:id", async (c) => {
  const sessionId = c.req.param("id");
  const result = await proxyToAgent(c.req.raw, c.env, sessionId, "/");
  await proxyToControl(c.env, `/sessions/${sessionId}`, { method: "DELETE" });
  return result;
});

app.get("/session/:id/messages", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/messages"));

app.get("/session/:id/prompts", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/prompts"));

app.get("/session/:id/cron", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/cron"));

app.get("/session/:id/events", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/events"));

app.get("/session/:id/files", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), `/files${new URL(c.req.raw.url).search}`));

app.get("/session/:id/file", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), `/file${new URL(c.req.raw.url).search}`));

app.put("/session/:id/file", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), `/file${new URL(c.req.raw.url).search}`));

app.patch("/session/:id/file", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), `/file${new URL(c.req.raw.url).search}`));

app.delete("/session/:id/file", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), `/file${new URL(c.req.raw.url).search}`));

app.post("/session/:id/search", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/search"));

app.post("/session/:id/execute", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/execute"));

app.post("/session/:id/git/init", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/git/init"));
app.post("/session/:id/git/clone", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/git/clone"));
app.post("/session/:id/git/add", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/git/add"));
app.post("/session/:id/git/commit", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/git/commit"));
app.post("/session/:id/git/branch", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/git/branch"));
app.post("/session/:id/git/checkout", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/git/checkout"));
app.post("/session/:id/git/pull", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/git/pull"));
app.post("/session/:id/git/push", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/git/push"));
app.post("/session/:id/git/remote", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/git/remote"));
app.get("/session/:id/git/status", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), `/git/status${new URL(c.req.raw.url).search}`));
app.get("/session/:id/git/log", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), `/git/log${new URL(c.req.raw.url).search}`));
app.get("/session/:id/git/diff", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), `/git/diff${new URL(c.req.raw.url).search}`));

app.post("/session/:id/message", async (c) => {
  const config = await readConfig(c.env);
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/message", {
    "x-dodo-ai-base-url": config.aiGatewayBaseURL,
    "x-dodo-gateway": config.activeGateway,
    "x-dodo-model": config.model,
    "x-dodo-opencode-base-url": config.opencodeBaseURL,
  });
});

app.post("/session/:id/prompt", async (c) => {
  const config = await readConfig(c.env);
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/prompt", {
    "x-dodo-ai-base-url": config.aiGatewayBaseURL,
    "x-dodo-gateway": config.activeGateway,
    "x-dodo-model": config.model,
    "x-dodo-opencode-base-url": config.opencodeBaseURL,
  });
});

app.post("/session/:id/abort", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/abort"));

app.post("/session/:id/cron", async (c) => proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/cron"));

app.delete("/session/:id/cron/:cronId", async (c) =>
  proxyToAgent(c.req.raw, c.env, c.req.param("id"), `/cron/${encodeURIComponent(c.req.param("cronId"))}`),
);

app.post("/session/:id/fork", async (c) => {
  const sourceId = c.req.param("id");
  const sourceAgent = await getAgentByName(c.env.CODING_AGENT as never, sourceId);
  const snapshotResponse = await sourceAgent.fetch(new Request("https://coding-agent/snapshot", { method: "GET" }));
  const snapshot = await snapshotResponse.text();
  const snapshotStoreResponse = await proxyToControl(c.env, "/fork-snapshots", {
    body: snapshot,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const { id: snapshotId } = (await snapshotStoreResponse.json()) as { id: string };
  const sessionId = crypto.randomUUID();
  await proxyToControl(c.env, "/sessions", {
    body: JSON.stringify({ id: sessionId }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const targetAgent = await getAgentByName(c.env.CODING_AGENT as never, sessionId);
  const importResponse = await targetAgent.fetch(
    new Request(`https://coding-agent/snapshot/import?snapshotId=${encodeURIComponent(snapshotId)}`, {
      headers: {
        "x-dodo-session-id": sessionId,
      },
      method: "POST",
    }),
  );
  await proxyToControl(c.env, `/fork-snapshots/${encodeURIComponent(snapshotId)}`, { method: "DELETE" });
  if (!importResponse.ok) {
    return c.json({ error: await importResponse.text(), id: sessionId, sourceId }, 500);
  }
  return c.json({ id: sessionId, sourceId }, 201);
});

export { AppControl, CodingAgent };

export default {
  fetch(request: Request, env: Env, executionContext: ExecutionContext): Promise<Response> {
    return Promise.resolve(app.fetch(request, env, executionContext));
  },
};
