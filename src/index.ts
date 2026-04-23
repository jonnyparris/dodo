import { getAgentByName } from "agents";
import { createMcpHandler } from "agents/mcp";
import { newRpcResponse } from "@hono/capnweb";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { AuthError, checkAllowlist, checkBrowserEnabled, getSharedIndexStub, getUserControlStub, isAdmin, isDevMode, verifyAccess } from "./auth";
import { CodingAgent } from "./coding-agent";
import { runHealthCheck } from "./health-check";
import { log } from "./logger";
import { createDodoMcpServer } from "./mcp";
import { createDodoCodeModeMcpServer } from "./mcp-codemode";
import { MCP_CATALOG } from "./mcp-catalog";
import { fetchAttachment } from "./attachments";
import { AllowlistOutbound } from "./outbound";
import { RateLimiter } from "./rate-limit";
import { DodoPublicApi } from "./rpc-api";
import { signCookie, verifyCookie } from "./share";
import { SharedIndex } from "./shared-index";
import { UserControl } from "./user-control";
import type { AccessIdentity, AppConfig, Env } from "./types";

// ─── Per-isolate rate limiters ───
// Intentionally module-level mutable state. Rate limiters are approximate
// (per-isolate, not global) — sufficient for abuse prevention without
// requiring a DO round-trip. The requestCount counter is also per-isolate;
// it drives periodic cleanup of expired sliding windows and carries no
// cross-request semantics.

const promptLimiter = new RateLimiter();
const shareLimiter = new RateLimiter();
const messageLimiter = new RateLimiter();
const errorLimiter = new RateLimiter();

let requestCount = 0;
function maybeCleanupRateLimiters() {
  if (++requestCount % 100 === 0) {
    promptLimiter.cleanup();
    shareLimiter.cleanup();
    messageLimiter.cleanup();
    errorLimiter.cleanup();
  }
}

type PermissionLevel = "readonly" | "readwrite" | "write" | "admin";

type HonoEnv = { Bindings: Env; Variables: { identity: AccessIdentity; userEmail: string; sessionPermission: PermissionLevel; sessionOwnerEmail: string } };

const app = new Hono<HonoEnv>();

app.use("*", cors({ origin: "*", allowHeaders: ["Content-Type", "x-dodo-session-id"], allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }));

// Clean up rate limiter windows periodically
app.use("*", async (c, next) => {
  maybeCleanupRateLimiters();
  return next();
});

// ─── Helper functions ───

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

async function proxyToUserControl(env: Env, email: string, path: string, init?: RequestInit): Promise<Response> {
  const stub = getUserControlStub(env, email);
  const headers = new Headers(init?.headers);
  headers.set("x-owner-email", email);
  return stub.fetch(`https://user-control${path}`, { ...init, headers });
}

async function proxyToSharedIndex(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const stub = getSharedIndexStub(env);
  return stub.fetch(`https://shared-index${path}`, init);
}

/** Catalog knownHosts are implicitly allowed (avoids requiring admin to manually allowlist them). */
const catalogHostnames = new Set(MCP_CATALOG.flatMap((entry) => entry.knownHosts ?? []).map((h) => h.toLowerCase()));

async function isHostAllowed(env: Env, hostname: string): Promise<boolean> {
  if (catalogHostnames.has(hostname)) return true;
  const checkRes = await proxyToSharedIndex(env, `/allowlist/check?hostname=${encodeURIComponent(hostname)}`);
  const checkBody = (await checkRes.json()) as { allowed: boolean };
  return checkBody.allowed;
}

function rateLimitedResponse(result: { remaining: number; retryAfter?: number }, route: string, email: string): Response {
  log("warn", "Rate limit hit", { email, route, retryAfter: result.retryAfter });
  return Response.json(
    { error: "Too many requests" },
    {
      status: 429,
      headers: {
        "Retry-After": String(result.retryAfter ?? 60),
        "X-RateLimit-Remaining": "0",
      },
    },
  );
}

async function readConfig(env: Env, email: string): Promise<AppConfig> {
  const stub = getUserControlStub(env, email);
  const response = await stub.fetch("https://user-control/config");
  return (await response.json()) as AppConfig;
}

/**
 * Determine the effective permission level for a user on a session.
 * - Session owner → "admin"
 * - Admin user → "admin"
 * - Granted permission via SharedIndex → "readonly" | "readwrite"
 * - Share cookie guest → permission from signed cookie
 * - Otherwise → null (no access)
 */
type SessionPermissionResult = { permission: PermissionLevel; ownerEmail: string } | null;

async function resolveSessionPermission(
  env: Env,
  email: string,
  sessionId: string,
  request: Request,
): Promise<SessionPermissionResult> {
  // Session owner gets admin
  const ownerStub = getUserControlStub(env, email);
  const ownerCheck = await ownerStub.fetch(`https://user-control/sessions/${encodeURIComponent(sessionId)}/check`);
  if (ownerCheck.ok) return { permission: "admin", ownerEmail: email };

  // Platform admin gets admin
  if (isAdmin(email, env)) return { permission: "admin", ownerEmail: email };

  // Check SharedIndex for granted permission (includes ownerEmail)
  const permRes = await proxyToSharedIndex(env, `/permissions/${encodeURIComponent(sessionId)}/${encodeURIComponent(email)}`);
  if (permRes.ok) {
    const perm = (await permRes.json()) as { permission: string; ownerEmail?: string };
    if (perm.permission === "readwrite") return { permission: "write", ownerEmail: perm.ownerEmail ?? "" };
    if (perm.permission === "readonly") return { permission: "readonly", ownerEmail: perm.ownerEmail ?? "" };
  }

  // Check share cookie
  const cookieSecret = env.COOKIE_SECRET;
  if (cookieSecret) {
    const cookieHeader = request.headers.get("Cookie") ?? "";
    for (const cookie of cookieHeader.split(";")) {
      const trimmed = cookie.trim();
      if (trimmed.startsWith("dodo_share=")) {
        const signedValue = trimmed.slice("dodo_share=".length);
        const payload = await verifyCookie(signedValue, cookieSecret);
        if (payload) {
          try {
            const parsed = JSON.parse(payload) as { sessionId?: string; permission?: string; ownerEmail?: string; expiresAt?: string };
            if (parsed.sessionId === sessionId) {
              if (parsed.expiresAt && new Date(parsed.expiresAt) <= new Date()) continue;
              const perm: PermissionLevel = parsed.permission === "readwrite" ? "write" : "readonly";
              return { permission: perm, ownerEmail: parsed.ownerEmail ?? "" };
            }
          } catch { /* invalid cookie payload */ }
        }
      }
    }
  }

  return null;
}

const PERMISSION_LEVELS: Record<string, number> = { readonly: 0, readwrite: 1, write: 1, admin: 2 };

/**
 * Check if the current session permission meets the required level.
 * Returns a 403 Response if insufficient, or null if OK.
 */
export function requirePermission(
  c: { get: (key: string) => unknown; json: (data: unknown, status?: number) => Response },
  required: "readonly" | "write" | "admin",
): Response | null {
  const perm = c.get("sessionPermission") as string;
  if ((PERMISSION_LEVELS[perm] ?? -1) < (PERMISSION_LEVELS[required] ?? 999)) {
    return c.json({ error: "Insufficient permission" }, 403);
  }
  return null;
}

// ─── MCP (token auth, no CF Access) ───

const MAX_MCP_DEPTH = 3;

app.all("/mcp", async (c) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");
  if (!c.env.DODO_MCP_TOKEN || token !== c.env.DODO_MCP_TOKEN) {
    return c.json({ error: "Invalid or missing MCP token" }, 401);
  }

  // Loop protection: reject requests that exceed recursion depth
  const depth = parseInt(c.req.header("x-dodo-mcp-depth") ?? "0", 10) || 0;
  if (depth >= MAX_MCP_DEPTH) {
    return c.json({ error: "MCP recursion depth exceeded" }, 429);
  }

  const server = createDodoMcpServer(c.env, depth);
  const handler = createMcpHandler(server);
  return handler(c.req.raw, c.env, c.executionCtx);
});

// Code-mode MCP: 2 tools (search + execute) instead of 40+.
// Use this endpoint for MCP connections from coding agents to minimize context usage.
app.all("/mcp/codemode", async (c) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");
  if (!c.env.DODO_MCP_TOKEN || token !== c.env.DODO_MCP_TOKEN) {
    return c.json({ error: "Invalid or missing MCP token" }, 401);
  }

  const depth = parseInt(c.req.header("x-dodo-mcp-depth") ?? "0", 10) || 0;
  if (depth >= MAX_MCP_DEPTH) {
    return c.json({ error: "MCP recursion depth exceeded" }, 429);
  }

  const server = createDodoCodeModeMcpServer(c.env, depth);
  const handler = createMcpHandler(server);
  return handler(c.req.raw, c.env, c.executionCtx);
});

// ─── Health (no auth) ───

app.get("/health", (c) => c.json({ status: "ok" }));



// ─── Bootstrap (one-time, only works when no users exist) ───

app.post("/api/bootstrap", async (c) => {
  const stub = getSharedIndexStub(c.env);
  const usersResp = await stub.fetch("https://shared-index/users");
  const { users } = (await usersResp.json()) as { users: unknown[] };
  if (users.length > 0) {
    return c.json({ error: "Already bootstrapped — users exist" }, 409);
  }
  const adminEmail = c.env.ADMIN_EMAIL;
  if (!adminEmail) {
    return c.json({ error: "ADMIN_EMAIL not configured" }, 500);
  }
  const addResp = await stub.fetch("https://shared-index/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: adminEmail, role: "admin" }),
  });
  if (!addResp.ok) {
    return c.json({ error: "Failed to seed admin user" }, 500);
  }
  log("info", "Bootstrap: admin user seeded", { email: adminEmail });
  return c.json({ bootstrapped: true, adminEmail }, 201);
});

// ─── Share link redemption (no auth required) ───

app.get("/shared/:token", async (c) => {
  const token = c.req.param("token");
  const verifyRes = await proxyToSharedIndex(c.env, "/shares/verify", {
    body: JSON.stringify({ token }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const result = (await verifyRes.json()) as { valid: boolean; sessionId?: string; permission?: string; ownerEmail?: string };
  if (!result.valid || !result.sessionId) {
    return c.json({ error: "Invalid or expired share link" }, 403);
  }

  const cookieSecret = c.env.COOKIE_SECRET;
  if (!cookieSecret) {
    return c.json({ error: "Sharing not configured" }, 500);
  }

  const payload = JSON.stringify({
    sessionId: result.sessionId,
    permission: result.permission,
    ownerEmail: result.ownerEmail,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });

  const signed = await signCookie(payload, cookieSecret);
  return new Response(null, {
    status: 302,
    headers: {
      Location: `/#session=${encodeURIComponent(result.sessionId)}`,
      "Set-Cookie": `dodo_share=${signed}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
    },
  });
});

// ─── Error ingestion (no auth — errors can happen before/during auth) ───

app.post("/api/errors", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const rl = errorLimiter.check(ip, 30, 3600); // 30 errors per hour per IP
  if (!rl.allowed) {
    return c.json({ error: "Too many error reports" }, 429);
  }
  const body = await c.req.json().catch(() => null);
  if (!body || !body.message) return c.json({ error: "Missing message" }, 400);

  const stub = getSharedIndexStub(c.env);
  await stub.fetch("https://shared-index/errors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: String(body.message).slice(0, 1000),
      source: String(body.source ?? "").slice(0, 500),
      lineno: Number(body.lineno) || 0,
      colno: Number(body.colno) || 0,
      stack: String(body.stack ?? "").slice(0, 5000),
      userAgent: String(body.userAgent ?? "").slice(0, 300),
      email: String(body.email ?? "").slice(0, 200),
      url: String(body.url ?? "").slice(0, 500),
    }),
  });
  return c.json({ received: true }, 201);
});

/**
 * Check if the request carries a valid, non-expired dodo_share cookie.
 * Used to let share-link guests bypass the user allowlist.
 */
async function checkShareCookie(request: Request, env: Env): Promise<boolean> {
  const cookieSecret = env.COOKIE_SECRET;
  if (!cookieSecret) return false;
  const cookieHeader = request.headers.get("Cookie") ?? "";
  for (const cookie of cookieHeader.split(";")) {
    const trimmed = cookie.trim();
    if (trimmed.startsWith("dodo_share=")) {
      const signedValue = trimmed.slice("dodo_share=".length);
      const payload = await verifyCookie(signedValue, cookieSecret);
      if (payload) {
        try {
          const parsed = JSON.parse(payload) as { sessionId?: string; expiresAt?: string };
          if (!parsed.sessionId) continue;
          if (parsed.expiresAt && new Date(parsed.expiresAt) <= new Date()) continue;
          return true;
        } catch { /* invalid payload */ }
      }
    }
  }
  return false;
}

// ─── Auth middleware ───

app.use("*", async (c, next) => {
  const path = new URL(c.req.raw.url).pathname;
  if (path === "/health" || path === "/api/bootstrap" || path === "/api/errors" || path === "/mcp" || path.startsWith("/mcp/") || path.startsWith("/shared/")) return next();

  let identity: AccessIdentity;
  try {
    identity = await verifyAccess(c.req.raw, c.env);
  } catch (error) {
    if (error instanceof AuthError) {
      log("warn", "Auth failure", { source: "unknown", error: error.message });
      return c.json({ error: error.message }, error.status as 401 | 403 | 500);
    }
    log("warn", "Auth failure", { source: "unknown", error: "Authentication failed" });
    return c.json({ error: "Authentication failed" }, 403);
  }

  if (!identity.email) {
    log("warn", "Auth failure", { source: identity.source, error: "No email in token" });
    return c.json({ error: "No email in token" }, 403);
  }

  // In dev mode, skip the allowlist check entirely
  if (!isDevMode(c.env)) {
    const { allowed } = await checkAllowlist(identity.email, c.env);
    if (!allowed) {
      // Share-link guests bypass the allowlist — session-level permissions
      // are enforced later by the resolveSessionPermission middleware.
      const hasValidShareCookie = await checkShareCookie(c.req.raw, c.env);
      if (!hasValidShareCookie) {
        log("warn", "Auth failure", { email: identity.email, source: identity.source, error: "Not on allowlist" });
        return c.json({ error: "Not authorized — not on Dodo allowlist" }, 403);
      }
      log("info", "Auth: share-cookie guest bypassed allowlist", { email: identity.email });
    }
  }

  log("info", "Auth success", { email: identity.email, source: identity.source });
  c.set("identity", identity);
  c.set("userEmail", identity.email);
  return next();
});

// ─── Cap'n Web RPC (authenticated) ───

app.all("/rpc", async (c) => {
  const api = new DodoPublicApi(c.env, c.get("userEmail"));
  return newRpcResponse(c, api);
});

// ─── Static assets ───

app.get("/", async (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return new Response("Dodo", { headers: { "content-type": "text/plain" } });
});

app.get("/docs", async (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(new Request(new URL("/docs.html", c.req.url), c.req.raw));
  }
  return new Response("Docs not available", { status: 404 });
});

app.get("/howto", async (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(new Request(new URL("/howto.html", c.req.url), c.req.raw));
  }
  return new Response("How-to guides not available", { status: 404 });
});

// ─── Admin routes (admin only) ───

const adminGuard = async (c: { get: (key: string) => unknown; env: Env; json: (data: unknown, status?: number) => Response }, next: () => Promise<void>): Promise<Response | void> => {
  const email = c.get("userEmail") as string;
  if (!isAdmin(email, c.env)) {
    return c.json({ error: "Admin access required" }, 403);
  }
  return next();
};

app.get("/api/admin/users", adminGuard as never, async (c) => proxyToSharedIndex(c.env, "/users"));
app.post("/api/admin/users", adminGuard as never, async (c) =>
  proxyToSharedIndex(c.env, "/users", {
    body: await c.req.raw.text(),
    headers: { "content-type": "application/json" },
    method: "POST",
  }),
);
app.delete("/api/admin/users/:email", adminGuard as never, async (c) =>
  proxyToSharedIndex(c.env, `/users/${encodeURIComponent(c.req.param("email"))}`, { method: "DELETE" }),
);
app.post("/api/admin/users/:email/block", adminGuard as never, async (c) =>
  proxyToSharedIndex(c.env, `/users/${encodeURIComponent(c.req.param("email"))}/block`, { method: "POST" }),
);
app.delete("/api/admin/users/:email/block", adminGuard as never, async (c) =>
  proxyToSharedIndex(c.env, `/users/${encodeURIComponent(c.req.param("email"))}/block`, { method: "DELETE" }),
);

// ─── Admin: browser access ───
app.post("/api/admin/users/:email/browser", adminGuard as never, async (c) =>
  proxyToSharedIndex(c.env, `/users/${encodeURIComponent(c.req.param("email"))}/browser`, { method: "POST" }),
);
app.delete("/api/admin/users/:email/browser", adminGuard as never, async (c) =>
  proxyToSharedIndex(c.env, `/users/${encodeURIComponent(c.req.param("email"))}/browser`, { method: "DELETE" }),
);

app.get("/api/admin/stats", adminGuard as never, async (c) => proxyToSharedIndex(c.env, "/stats"));

app.get("/api/admin/users/detailed", adminGuard as never, async (c) => proxyToSharedIndex(c.env, "/users/detailed"));

// ─── Admin: error monitoring ───

app.get("/api/admin/errors", adminGuard as never, async (c) => {
  const search = new URL(c.req.raw.url).search;
  return proxyToSharedIndex(c.env, `/errors${search}`);
});

app.get("/api/admin/errors/summary", adminGuard as never, async (c) => proxyToSharedIndex(c.env, "/errors/summary"));

app.delete("/api/admin/errors", adminGuard as never, async (c) => proxyToSharedIndex(c.env, "/errors", { method: "DELETE" }));

// ─── Admin: health check (manual trigger) ───

app.post("/api/admin/health-check", adminGuard as never, async (c) => {
  const report = await runHealthCheck(c.env, c.executionCtx);
  return c.json(report);
});

app.get("/api/admin/sessions", adminGuard as never, async (c) => {
  // Fetch all registered users from SharedIndex
  const usersRes = await proxyToSharedIndex(c.env, "/users");
  const { users } = (await usersRes.json()) as { users: Array<{ email: string }> };

  // Query each user's UserControl for their sessions
  const allSessions: Array<Record<string, unknown>> = [];
  await Promise.all(
    users.map(async (user) => {
      try {
        const sessionsRes = await proxyToUserControl(c.env, user.email, "/sessions");
        if (!sessionsRes.ok) return;
        const { sessions } = (await sessionsRes.json()) as { sessions: Array<Record<string, unknown>> };
        for (const session of sessions) {
          allSessions.push({ ...session, ownerEmail: user.email });
        }
      } catch {
        // Skip users whose UserControl is unavailable
      }
    }),
  );

  // Sort by updatedAt descending
  allSessions.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  return c.json({ sessions: allSessions });
});

// ─── User config (per-user via UserControl) ───

app.get("/api/config", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, "/config");
});

app.put("/api/config", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, "/config", {
    body: await c.req.raw.text(),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
});

// ─── Host allowlist (global via SharedIndex) ───

app.get("/api/allowlist", async (c) => proxyToSharedIndex(c.env, "/allowlist"));

app.post("/api/allowlist", adminGuard as never, async (c) =>
  proxyToSharedIndex(c.env, "/allowlist", {
    body: await c.req.raw.text(),
    headers: { "content-type": "application/json" },
    method: "POST",
  }),
);

app.delete("/api/allowlist/:hostname", adminGuard as never, async (c) =>
  proxyToSharedIndex(c.env, `/allowlist/${encodeURIComponent(c.req.param("hostname"))}`, { method: "DELETE" }),
);

app.get("/api/allowlist/check", async (c) => proxyToSharedIndex(c.env, `/allowlist/check${new URL(c.req.raw.url).search}`));

// ─── Memory (per-user via UserControl) ───

app.get("/api/memory", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, `/memory${new URL(c.req.raw.url).search}`);
});

app.post("/api/memory", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, "/memory", {
    body: await c.req.raw.text(),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
});

app.get("/api/memory/:id", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, `/memory/${encodeURIComponent(c.req.param("id"))}`);
});

app.put("/api/memory/:id", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, `/memory/${encodeURIComponent(c.req.param("id"))}`, {
    body: await c.req.raw.text(),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
});

app.delete("/api/memory/:id", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, `/memory/${encodeURIComponent(c.req.param("id"))}`, { method: "DELETE" });
});

// ─── Models (global via SharedIndex) ───

app.get("/api/models", async (c) => proxyToSharedIndex(c.env, `/models${new URL(c.req.raw.url).search}`));

// ─── Status (per-user) ───

app.get("/api/status", async (c) => {
  const email = c.get("userEmail");
  const res = await proxyToUserControl(c.env, email, "/status");
  // Inject commit hash from Worker env — DOs may not receive --var overrides
  const data = await res.json() as Record<string, unknown>;
  data.commit = c.env.DODO_COMMIT ?? data.commit ?? "";
  return Response.json(data);
});

// ─── Tasks (per-user via UserControl) ───

app.get("/api/tasks", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, `/tasks${new URL(c.req.raw.url).search}`);
});

app.post("/api/tasks", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, "/tasks", {
    body: await c.req.raw.text(),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
});

// Batch dispatch: dispatch multiple tasks in parallel (must be before :id routes)
app.post("/api/tasks/batch-dispatch", async (c) => {
  const email = c.get("userEmail");
  const body = (await c.req.json()) as { taskIds?: string[] };
  const taskIds = body.taskIds;
  if (!Array.isArray(taskIds) || taskIds.length === 0 || taskIds.length > 10) {
    return c.json({ error: "taskIds must be an array of 1-10 task IDs" }, 400);
  }

  // Fetch all tasks
  const listRes = await proxyToUserControl(c.env, email, "/tasks");
  const listBody = (await listRes.json()) as { tasks: Array<{ id: string; title: string; description: string; priority: string; status: string; sessionId: string | null }> };
  const taskMap = new Map(listBody.tasks.map((t) => [t.id, t]));

  const config = await readConfig(c.env, email);
  const checkRes = await proxyToSharedIndex(c.env, `/account-permissions/check?grantee=${encodeURIComponent(email)}`);
  const checkBody = (await checkRes.json()) as { hasCreate: boolean; accountOwner: string | null };
  const effectiveOwner = checkBody.hasCreate && checkBody.accountOwner ? checkBody.accountOwner : email;

  const results: Array<{ taskId: string; sessionId?: string; error?: string }> = [];

  for (const taskId of taskIds) {
    const task = taskMap.get(taskId);
    if (!task) { results.push({ taskId, error: "not found" }); continue; }
    if (task.status === "in_progress" || task.status === "done") { results.push({ taskId, error: `already ${task.status}` }); continue; }

    try {
      const sessionId = crypto.randomUUID();
      await proxyToUserControl(c.env, effectiveOwner, "/sessions", {
        body: JSON.stringify({ id: sessionId, ownerEmail: effectiveOwner, createdBy: email }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (effectiveOwner !== email) {
        await proxyToSharedIndex(c.env, "/permissions", {
          body: JSON.stringify({ sessionId, ownerEmail: effectiveOwner, granteeEmail: email, permission: "readwrite", grantedBy: "system" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
      }
      await proxyToSharedIndex(c.env, "/stats/increment", {
        body: JSON.stringify({ stat: "sessionCount", delta: 1 }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      const lines = [`# Task: ${task.title}`];
      if (task.description) lines.push("", task.description);
      lines.push("", `Priority: ${task.priority}`, "", "Complete this task. When finished, summarize what you did.");

      const promptReq = new Request(`https://dodo.example/session/${sessionId}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: lines.join("\n") }),
      });
      await proxyToAgent(promptReq, c.env, sessionId, "/prompt", {
        "x-dodo-ai-base-url": config.aiGatewayBaseURL,
        "x-dodo-gateway": config.activeGateway,
        "x-dodo-model": config.model,
        "x-dodo-opencode-base-url": config.opencodeBaseURL,
        "x-author-email": email,
        "x-owner-email": email,
      });

      await proxyToUserControl(c.env, email, `/tasks/${encodeURIComponent(taskId)}`, {
        body: JSON.stringify({ status: "in_progress", session_id: sessionId }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });

      results.push({ taskId, sessionId });
    } catch {
      results.push({ taskId, error: "dispatch failed" });
    }
  }

  log("info", "Batch dispatch", { email, count: taskIds.length, dispatched: results.filter((r) => r.sessionId).length });
  return c.json({ results });
});

app.put("/api/tasks/:id", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, `/tasks/${encodeURIComponent(c.req.param("id"))}`, {
    body: await c.req.raw.text(),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
});

app.delete("/api/tasks/:id", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, `/tasks/${encodeURIComponent(c.req.param("id"))}`, { method: "DELETE" });
});

app.get("/api/tasks/:id/check", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, `/tasks/${encodeURIComponent(c.req.param("id"))}/check`);
});

// Dispatch a task: create a session, send a prompt, link them together
app.post("/api/tasks/:id/dispatch", async (c) => {
  const email = c.get("userEmail");
  const taskId = c.req.param("id");

  // 1. Fetch the task
  const taskRes = await proxyToUserControl(c.env, email, `/tasks/${encodeURIComponent(taskId)}/check`);
  if (!taskRes.ok) return c.json({ error: "Task not found" }, 404);

  // Get full task data via list + filter (check only returns {found:true})
  const listRes = await proxyToUserControl(c.env, email, "/tasks");
  const listBody = (await listRes.json()) as { tasks: Array<{ id: string; title: string; description: string; priority: string; status: string; sessionId: string | null }> };
  const task = listBody.tasks.find((t) => t.id === taskId);
  if (!task) return c.json({ error: "Task not found" }, 404);

  // 2. Create a new session
  const sessionId = crypto.randomUUID();
  const ownerEmail = email;
  const createdBy = email;

  // Check for delegation (same logic as POST /session)
  const checkRes = await proxyToSharedIndex(c.env, `/account-permissions/check?grantee=${encodeURIComponent(email)}`);
  const checkBody = (await checkRes.json()) as { hasCreate: boolean; accountOwner: string | null };
  const effectiveOwner = checkBody.hasCreate && checkBody.accountOwner ? checkBody.accountOwner : ownerEmail;

  await proxyToUserControl(c.env, effectiveOwner, "/sessions", {
    body: JSON.stringify({ id: sessionId, ownerEmail: effectiveOwner, createdBy }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  // Auto-grant write if delegated
  if (effectiveOwner !== email) {
    await proxyToSharedIndex(c.env, "/permissions", {
      body: JSON.stringify({
        sessionId,
        ownerEmail: effectiveOwner,
        granteeEmail: email,
        permission: "readwrite",
        grantedBy: "system",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  }

  await proxyToSharedIndex(c.env, "/stats/increment", {
    body: JSON.stringify({ stat: "sessionCount", delta: 1 }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  // 3. Build a richer prompt
  const lines = [`# Task: ${task.title}`];
  if (task.description) lines.push("", task.description);
  lines.push("", `Priority: ${task.priority}`);
  lines.push("", "Complete this task. When finished, summarize what you did.");

  // 4. Send the prompt to the new session
  const config = await readConfig(c.env, email);
  const promptReq = new Request(`https://dodo.example/session/${sessionId}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: lines.join("\n") }),
  });
  await proxyToAgent(promptReq, c.env, sessionId, "/prompt", {
    "x-dodo-ai-base-url": config.aiGatewayBaseURL,
    "x-dodo-gateway": config.activeGateway,
    "x-dodo-model": config.model,
    "x-dodo-opencode-base-url": config.opencodeBaseURL,
    "x-author-email": email,
    "x-owner-email": email,
  });

  // 5. Update task: set status to in_progress and link session
  await proxyToUserControl(c.env, email, `/tasks/${encodeURIComponent(taskId)}`, {
    body: JSON.stringify({ status: "in_progress", session_id: sessionId }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });

  log("info", "Task dispatched", { email, taskId, sessionId });
  return c.json({ sessionId, taskId, status: "in_progress" });
});

// ─── Secrets (per-user via UserControl) ───

app.get("/api/secrets", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, "/secrets");
});

app.put("/api/secrets/:key", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, `/secrets/${encodeURIComponent(c.req.param("key"))}`, {
    body: await c.req.raw.text(),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
});

app.delete("/api/secrets/:key", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, `/secrets/${encodeURIComponent(c.req.param("key"))}`, { method: "DELETE" });
});

app.get("/api/secrets/:key/test", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, `/secrets/${encodeURIComponent(c.req.param("key"))}/test`);
});

// ─── MCP Configs (per-user via UserControl) ───

app.get("/api/mcp-configs", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, "/mcp-configs");
});

app.post("/api/mcp-configs", async (c) => {
  const email = c.get("userEmail");
  const body = await c.req.raw.text();
  // Validate URL hostname against host allowlist + catalog
  try {
    const parsed = JSON.parse(body) as { url?: string };
    if (parsed.url) {
      const hostname = new URL(parsed.url).hostname.toLowerCase();
      if (!(await isHostAllowed(c.env, hostname))) {
        return c.json({ error: `Host "${hostname}" is not on the allowlist` }, 403);
      }
    }
  } catch (e) {
    if (e instanceof SyntaxError) {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    if (!(e instanceof TypeError)) throw e;
  }
  return proxyToUserControl(c.env, email, "/mcp-configs", {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
});

app.put("/api/mcp-configs/:id", async (c) => {
  const email = c.get("userEmail");
  const body = await c.req.raw.text();
  // Validate URL hostname against host allowlist + catalog
  try {
    const parsed = JSON.parse(body) as { url?: string };
    if (parsed.url) {
      const hostname = new URL(parsed.url).hostname.toLowerCase();
      if (!(await isHostAllowed(c.env, hostname))) {
        return c.json({ error: `Host "${hostname}" is not on the allowlist` }, 403);
      }
    }
  } catch (e) {
    if (e instanceof SyntaxError) {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    if (!(e instanceof TypeError)) throw e;
  }
  return proxyToUserControl(c.env, email, `/mcp-configs/${encodeURIComponent(c.req.param("id"))}`, {
    body,
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
});

app.delete("/api/mcp-configs/:id", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, `/mcp-configs/${encodeURIComponent(c.req.param("id"))}`, { method: "DELETE" });
});

app.post("/api/mcp-configs/:id/test", async (c) => {
  const email = c.get("userEmail");
  // Fetch config to check URL against allowlist before testing connection
  const configRes = await proxyToUserControl(c.env, email, "/mcp-configs");
  if (configRes.ok) {
    const configBody = (await configRes.json()) as { configs: Array<{ id: string; url?: string }> };
    const config = configBody.configs.find((cfg) => cfg.id === c.req.param("id"));
    if (config?.url) {
      try {
        const hostname = new URL(config.url).hostname.toLowerCase();
        if (!(await isHostAllowed(c.env, hostname))) {
          return c.json({ error: `Host "${hostname}" is not on the allowlist` }, 403);
        }
      } catch (e) {
        if (e instanceof TypeError) {
          return c.json({ error: "Invalid MCP config URL" }, 400);
        }
        throw e;
      }
    }
  }
  return proxyToUserControl(c.env, email, `/mcp-configs/${encodeURIComponent(c.req.param("id"))}/test`, { method: "POST" });
});

// ─── MCP Catalog (static) ───

app.get("/api/mcp-catalog", (c) => c.json(MCP_CATALOG));

// ─── Browser Rendering Config ───

app.get("/api/browser-config", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, "/browser-config");
});

app.put("/api/browser-config", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, "/browser-config", {
    method: "PUT",
    body: await c.req.text(),
    headers: { "content-type": "application/json" },
  });
});

app.delete("/api/browser-config", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, "/browser-config", { method: "DELETE" });
});

// ─── Passkey / Onboarding ───

app.get("/api/passkey/status", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, "/passkey/status");
});

app.post("/api/passkey/init", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, "/passkey/init", {
    body: await c.req.raw.text(),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
});

app.post("/api/passkey/change", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, "/passkey/change", {
    body: await c.req.raw.text(),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
});

app.post("/api/passkey/rotate-server-key", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, "/passkey/rotate-server-key", {
    body: await c.req.raw.text(),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
});

// ─── Onboarding ───

app.get("/api/onboarding", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, "/onboarding");
});

app.post("/api/onboarding/advance", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, "/onboarding/advance", {
    body: await c.req.raw.text(),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
});

app.post("/api/onboarding/reset", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, "/onboarding/reset", { method: "POST" });
});

app.get("/api/onboarding/status", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, "/onboarding/status");
});

// ─── Identity ───

app.get("/api/identity", async (c) => {
  const email = c.get("userEmail");
  return c.json({ email, isAdmin: isAdmin(email, c.env) });
});

// ─── User-level SSE (per-user via UserControl) ───

app.get("/api/events", async (c) => {
  const email = c.get("userEmail");
  const stub = getUserControlStub(c.env, email);
  const headers = new Headers();
  headers.set("x-owner-email", email);
  return stub.fetch("https://user-control/events", { headers });
});

// ─── Sessions (per-user via UserControl) ───

app.post("/session", async (c) => {
  const email = c.get("userEmail");
  const body = await c.req.raw.json().catch(() => ({})) as { ownerOverride?: string };
  const sessionId = crypto.randomUUID();

  // Check for account-level create permission (delegation)
  let ownerEmail = email;
  let createdBy = email;
  let autoGrantWrite = false;

  if (body.ownerOverride && body.ownerOverride !== email) {
    // Explicit override: verify the user has create permission for that account
    const checkRes = await proxyToSharedIndex(c.env, `/account-permissions/check?grantee=${encodeURIComponent(email)}`);
    const checkBody = (await checkRes.json()) as { hasCreate: boolean; accountOwner: string | null };
    if (!checkBody.hasCreate || checkBody.accountOwner !== body.ownerOverride) {
      return c.json({ error: "No create permission for the specified account" }, 403);
    }
    ownerEmail = body.ownerOverride;
    createdBy = email;
    autoGrantWrite = true;
  } else if (!body.ownerOverride) {
    // No explicit override: check if user has create permission (default to that account)
    const checkRes = await proxyToSharedIndex(c.env, `/account-permissions/check?grantee=${encodeURIComponent(email)}`);
    const checkBody = (await checkRes.json()) as { hasCreate: boolean; accountOwner: string | null };
    if (checkBody.hasCreate && checkBody.accountOwner) {
      ownerEmail = checkBody.accountOwner;
      createdBy = email;
      autoGrantWrite = true;
    }
  }

  await proxyToUserControl(c.env, ownerEmail, "/sessions", {
    body: JSON.stringify({ id: sessionId, ownerEmail, createdBy }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  // Auto-grant readwrite permission to creator when creating in another's namespace
  if (autoGrantWrite && ownerEmail !== email) {
    await proxyToSharedIndex(c.env, "/permissions", {
      body: JSON.stringify({
        sessionId,
        ownerEmail,
        granteeEmail: email,
        permission: "readwrite",
        grantedBy: "system",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  }

  log("info", "Session created", { email, sessionId, ownerEmail, createdBy });
  // Increment global session counter
  await proxyToSharedIndex(c.env, "/stats/increment", {
    body: JSON.stringify({ stat: "sessionCount", delta: 1 }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return c.json({ id: sessionId, ownerEmail, createdBy }, 201);
});

app.get("/session", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, "/sessions");
});

// ─── Session ownership + permission middleware ───

app.use("/session/:id/*", async (c, next) => {
  const email = c.get("userEmail");
  const sessionId = c.req.param("id");
  const result = await resolveSessionPermission(c.env, email, sessionId, c.req.raw);
  if (!result) {
    return c.json({ error: "Session not found or access denied" }, 403);
  }
  c.set("sessionPermission", result.permission);
  c.set("sessionOwnerEmail", result.ownerEmail);
  return next();
});

app.use("/session/:id", async (c, next) => {
  // Skip ownership check for POST (handled by the create route above)
  if (c.req.method === "POST") return next();
  const email = c.get("userEmail");
  const sessionId = c.req.param("id");
  const result = await resolveSessionPermission(c.env, email, sessionId, c.req.raw);
  if (!result) {
    return c.json({ error: "Session not found or access denied" }, 403);
  }
  c.set("sessionPermission", result.permission);
  c.set("sessionOwnerEmail", result.ownerEmail);
  return next();
});

app.get("/session/:id", async (c) => {
  const denied = requirePermission(c, "readonly");
  if (denied) return denied;
  const ownerEmail = c.get("sessionOwnerEmail") || c.get("userEmail");
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/", { "x-owner-email": ownerEmail });
});

app.patch("/session/:id", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  const sessionId = c.req.param("id");
  const email = c.get("userEmail");
  const body = await c.req.raw.text();
  return proxyToUserControl(c.env, email, `/sessions/${sessionId}`, {
    body,
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
});

app.delete("/session/:id", async (c) => {
  const denied = requirePermission(c, "admin");
  if (denied) return denied;
  const sessionId = c.req.param("id");
  const email = c.get("userEmail");
  const result = await proxyToAgent(c.req.raw, c.env, sessionId, "/", { "x-owner-email": email });
  await proxyToUserControl(c.env, email, `/sessions/${sessionId}`, { method: "DELETE" });
  // Cascade: clean up shares and permissions for this session
  await proxyToSharedIndex(c.env, `/sessions/${encodeURIComponent(sessionId)}/cleanup`, { method: "DELETE" });
  return result;
});

app.get("/session/:id/debug/compaction", async (c) => {
  const denied = requirePermission(c, "readonly");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/debug/compaction");
});



app.get("/session/:id/messages", async (c) => {
  const denied = requirePermission(c, "readonly");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/messages");
});

app.get("/session/:id/prompts", async (c) => {
  const denied = requirePermission(c, "readonly");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/prompts");
});

app.get("/session/:id/prompt-queue", async (c) => {
  const denied = requirePermission(c, "readonly");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/prompt-queue");
});

app.delete("/session/:id/prompt-queue/:queueId", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), `/prompt-queue/${encodeURIComponent(c.req.param("queueId"))}`, {
    method: "DELETE",
  });
});

app.get("/session/:id/cron", async (c) => {
  const denied = requirePermission(c, "readonly");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/cron");
});

app.get("/session/:id/events", async (c) => {
  const denied = requirePermission(c, "readonly");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/events");
});

app.get("/session/:id/files", async (c) => {
  const denied = requirePermission(c, "readonly");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), `/files${new URL(c.req.raw.url).search}`);
});

app.get("/session/:id/file", async (c) => {
  const denied = requirePermission(c, "readonly");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), `/file${new URL(c.req.raw.url).search}`);
});

app.put("/session/:id/file", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), `/file${new URL(c.req.raw.url).search}`);
});

app.patch("/session/:id/file", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), `/file${new URL(c.req.raw.url).search}`);
});

app.delete("/session/:id/file", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), `/file${new URL(c.req.raw.url).search}`);
});

// Serve an image attachment (chat screenshot, user upload, generated image).
// Hono wildcard captures {messageId}/{filename} as the second path segment.
// ACL is inherited from the /session/:id/* middleware — if the caller can't
// read the session, they can't read its attachments.
app.get("/session/:id/attachment/:messageId/:filename", async (c) => {
  const denied = requirePermission(c, "readonly");
  if (denied) return denied;
  const sessionId = c.req.param("id");
  const messageId = c.req.param("messageId");
  const filename = c.req.param("filename");
  if (!sessionId || !messageId || !filename) {
    return c.json({ error: "Missing path segment" }, 400);
  }
  const response = await fetchAttachment(c.env, sessionId, `${messageId}/${filename}`);
  if (!response) return c.json({ error: "Attachment not found" }, 404);
  return response;
});

app.post("/session/:id/search", async (c) => {
  const denied = requirePermission(c, "readonly");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/search");
});

app.post("/session/:id/execute", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/execute");
});

app.post("/session/:id/git/init", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/git/init");
});
app.post("/session/:id/git/clone", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/git/clone", { "x-owner-email": c.get("userEmail") });
});
app.post("/session/:id/git/add", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/git/add");
});
app.post("/session/:id/git/commit", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/git/commit", { "x-owner-email": c.get("userEmail") });
});
app.post("/session/:id/git/branch", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/git/branch");
});
app.post("/session/:id/git/checkout", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/git/checkout");
});
app.post("/session/:id/git/pull", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/git/pull", { "x-owner-email": c.get("userEmail") });
});
app.post("/session/:id/git/push", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/git/push", { "x-owner-email": c.get("userEmail") });
});
app.post("/session/:id/git/remote", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/git/remote");
});
app.get("/session/:id/git/status", async (c) => {
  const denied = requirePermission(c, "readonly");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), `/git/status${new URL(c.req.raw.url).search}`);
});
app.get("/session/:id/git/log", async (c) => {
  const denied = requirePermission(c, "readonly");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), `/git/log${new URL(c.req.raw.url).search}`);
});
app.get("/session/:id/git/diff", async (c) => {
  const denied = requirePermission(c, "readonly");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), `/git/diff${new URL(c.req.raw.url).search}`);
});

app.post("/session/:id/message", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  const email = c.get("userEmail");
  const rl = messageLimiter.check(`msg:${email}`, 120, 60 * 60 * 1000);
  if (!rl.allowed) return rateLimitedResponse(rl, "message", email);
  // Use the session owner's config for model/gateway so guests don't override it
  const ownerEmail = c.get("sessionOwnerEmail") || email;
  const config = await readConfig(c.env, ownerEmail);
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/message", {
    "x-dodo-ai-base-url": config.aiGatewayBaseURL,
    "x-dodo-gateway": config.activeGateway,
    "x-dodo-model": config.model,
    "x-dodo-opencode-base-url": config.opencodeBaseURL,
    "x-author-email": email,
    "x-owner-email": ownerEmail,
  });
});

app.post("/session/:id/prompt", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  const email = c.get("userEmail");
  const rl = promptLimiter.check(`prompt:${email}`, 60, 60 * 60 * 1000);
  if (!rl.allowed) return rateLimitedResponse(rl, "prompt", email);
  // Use the session owner's config for model/gateway so guests don't override it
  const ownerEmail = c.get("sessionOwnerEmail") || email;
  const config = await readConfig(c.env, ownerEmail);
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/prompt", {
    "x-dodo-ai-base-url": config.aiGatewayBaseURL,
    "x-dodo-gateway": config.activeGateway,
    "x-dodo-model": config.model,
    "x-dodo-opencode-base-url": config.opencodeBaseURL,
    "x-author-email": email,
    "x-owner-email": ownerEmail,
  });
});

app.post("/session/:id/generate", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  const email = c.get("userEmail");
  const rl = promptLimiter.check(`generate:${email}`, 30, 60 * 60 * 1000);
  if (!rl.allowed) return rateLimitedResponse(rl, "generate", email);
  const ownerEmail = c.get("sessionOwnerEmail") || email;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/generate", {
    "x-author-email": email,
    "x-owner-email": ownerEmail,
  });
});

app.get("/session/:id/ws", async (c) => {
  const upgradeHeader = c.req.header("Upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return c.json({ error: "Expected WebSocket upgrade" }, 426);
  }

  const email = c.get("userEmail");
  const sessionId = c.req.param("id");
  const permission = c.get("sessionPermission") ?? "readonly";
  const agent = await getAgentByName(c.env.CODING_AGENT as never, sessionId);

  // Forward WebSocket upgrade to the CodingAgent DO
  const url = new URL(c.req.url);
  const wsUrl = new URL("https://coding-agent/ws");
  wsUrl.searchParams.set("email", email);
  wsUrl.searchParams.set("displayName", email);
  wsUrl.searchParams.set("permission", permission);
  // Preserve any extra query params from the original request
  for (const [key, value] of url.searchParams) {
    if (!wsUrl.searchParams.has(key)) {
      wsUrl.searchParams.set(key, value);
    }
  }

  return agent.fetch(new Request(wsUrl.toString(), {
    headers: c.req.raw.headers,
  }));
});

app.post("/session/:id/abort", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/abort");
});

app.get("/session/:id/browser", async (c) => {
  const denied = requirePermission(c, "readonly");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/browser");
});

app.put("/session/:id/browser", async (c) => {
  const denied = requirePermission(c, "admin");
  if (denied) return denied;
  // Non-admin users must have browser_enabled set by admin before they can toggle browser on sessions.
  const email = c.get("userEmail");
  if (!isAdmin(email, c.env)) {
    const allowed = await checkBrowserEnabled(email, c.env);
    if (!allowed) {
      return c.json({ error: "Browser access not enabled for your account. Ask your admin to enable it." }, 403);
    }
  }
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/browser");
});

app.post("/session/:id/cron", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/cron");
});

app.delete("/session/:id/cron/:cronId", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), `/cron/${encodeURIComponent(c.req.param("cronId"))}`);
});

app.post("/session/:id/fork", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  const email = c.get("userEmail");
  const sourceId = c.req.param("id");
  const sourceAgent = await getAgentByName(c.env.CODING_AGENT as never, sourceId);
  const snapshotResponse = await sourceAgent.fetch(new Request("https://coding-agent/snapshot", { method: "GET" }));
  const snapshot = await snapshotResponse.text();
  const snapshotStoreResponse = await proxyToUserControl(c.env, email, "/fork-snapshots", {
    body: snapshot,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const { id: snapshotId } = (await snapshotStoreResponse.json()) as { id: string };
  const sessionId = crypto.randomUUID();
  await proxyToUserControl(c.env, email, "/sessions", {
    body: JSON.stringify({ id: sessionId, ownerEmail: email, createdBy: email }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const targetAgent = await getAgentByName(c.env.CODING_AGENT as never, sessionId);
  const importResponse = await targetAgent.fetch(
    new Request(`https://coding-agent/snapshot/import?snapshotId=${encodeURIComponent(snapshotId)}`, {
      headers: {
        "x-dodo-session-id": sessionId,
        "x-owner-email": email,
      },
      method: "POST",
    }),
  );
  await proxyToUserControl(c.env, email, `/fork-snapshots/${encodeURIComponent(snapshotId)}`, { method: "DELETE" });
  if (!importResponse.ok) {
    return c.json({ error: await importResponse.text(), id: sessionId, sourceId }, 500);
  }
  return c.json({ id: sessionId, sourceId }, 201);
});

// ─── Share link management (session owner only) ───

app.post("/session/:id/share", async (c) => {
  const denied = requirePermission(c, "admin");
  if (denied) return denied;
  const sessionId = c.req.param("id");
  const email = c.get("userEmail");
  const rl = shareLimiter.check(`share:${sessionId}`, 20, 60 * 60 * 1000);
  if (!rl.allowed) return rateLimitedResponse(rl, "share", email);
  const body = await c.req.raw.json() as Record<string, unknown>;
  const result = await proxyToSharedIndex(c.env, "/shares", {
    body: JSON.stringify({
      sessionId,
      ownerEmail: email,
      permission: body.permission ?? "readonly",
      label: body.label,
      expiresAt: body.expiresAt,
      createdBy: email,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  log("info", "Share created", { email, sessionId, permission: body.permission ?? "readonly" });
  return result;
});

app.get("/session/:id/shares", async (c) => {
  const denied = requirePermission(c, "admin");
  if (denied) return denied;
  const sessionId = c.req.param("id");
  return proxyToSharedIndex(c.env, `/shares?sessionId=${encodeURIComponent(sessionId)}`);
});

app.delete("/session/:id/share/:shareId", async (c) => {
  const denied = requirePermission(c, "admin");
  if (denied) return denied;
  const shareId = c.req.param("shareId");
  const email = c.get("userEmail");
  log("info", "Share revoked", { email, sessionId: c.req.param("id"), shareId });
  return proxyToSharedIndex(c.env, `/shares/${encodeURIComponent(shareId)}`, { method: "DELETE" });
});

// ─── Permission management (session owner only) ───

app.get("/session/:id/permissions", async (c) => {
  const denied = requirePermission(c, "admin");
  if (denied) return denied;
  const sessionId = c.req.param("id");
  return proxyToSharedIndex(c.env, `/permissions?sessionId=${encodeURIComponent(sessionId)}`);
});

app.post("/session/:id/permissions", async (c) => {
  const denied = requirePermission(c, "admin");
  if (denied) return denied;
  const sessionId = c.req.param("id");
  const email = c.get("userEmail");
  const body = await c.req.raw.json() as Record<string, unknown>;
  return proxyToSharedIndex(c.env, "/permissions", {
    body: JSON.stringify({
      sessionId,
      ownerEmail: email,
      granteeEmail: body.granteeEmail,
      permission: body.permission ?? "readonly",
      grantedBy: email,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
});

app.delete("/session/:id/permissions/:email", async (c) => {
  const denied = requirePermission(c, "admin");
  if (denied) return denied;
  const sessionId = c.req.param("id");
  const granteeEmail = c.req.param("email");
  return proxyToSharedIndex(c.env, `/permissions/${encodeURIComponent(sessionId)}/${encodeURIComponent(granteeEmail)}`, { method: "DELETE" });
});

// ─── Session MCP Config Overrides ───

app.get("/session/:id/mcp-configs", async (c) => {
  const denied = requirePermission(c, "readonly");
  if (denied) return denied;
  const email = c.get("userEmail");
  const sessionId = c.req.param("id");
  return proxyToUserControl(c.env, email, `/sessions/${encodeURIComponent(sessionId)}/effective-mcp-configs`);
});

app.post("/session/:id/mcp-configs", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  const email = c.get("userEmail");
  const sessionId = c.req.param("id");
  return proxyToUserControl(c.env, email, `/sessions/${encodeURIComponent(sessionId)}/mcp-overrides`, {
    body: await c.req.raw.text(),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
});

app.delete("/session/:id/mcp-configs/:mcpId", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  const email = c.get("userEmail");
  const sessionId = c.req.param("id");
  const mcpId = c.req.param("mcpId");
  return proxyToUserControl(c.env, email, `/sessions/${encodeURIComponent(sessionId)}/mcp-overrides/${encodeURIComponent(mcpId)}`, {
    method: "DELETE",
  });
});

// ─── Admin: account-level permissions ───

app.post("/api/admin/account-permissions", adminGuard as never, async (c) => {
  const email = c.get("userEmail");
  const body = await c.req.raw.json() as Record<string, unknown>;
  return proxyToSharedIndex(c.env, "/account-permissions", {
    body: JSON.stringify({
      accountOwner: body.accountOwner,
      granteeEmail: body.granteeEmail,
      permission: body.permission,
      grantedBy: email,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
});

app.delete("/api/admin/account-permissions/:owner/:email", adminGuard as never, async (c) => {
  const owner = c.req.param("owner");
  const granteeEmail = c.req.param("email");
  return proxyToSharedIndex(c.env, `/account-permissions/${encodeURIComponent(owner)}/${encodeURIComponent(granteeEmail)}`, { method: "DELETE" });
});

app.get("/api/admin/account-permissions", adminGuard as never, async (c) => {
  const owner = new URL(c.req.raw.url).searchParams.get("owner") ?? "";
  return proxyToSharedIndex(c.env, `/account-permissions?owner=${encodeURIComponent(owner)}`);
});

export { AllowlistOutbound, CodingAgent, SharedIndex, UserControl };

export default {
  fetch(request: Request, env: Env, executionContext: ExecutionContext): Promise<Response> {
    return Promise.resolve(app.fetch(request, env, executionContext));
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await runHealthCheck(env, ctx);
  },
};
