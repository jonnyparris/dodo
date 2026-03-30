import { getAgentByName } from "agents";
import { createMcpHandler } from "agents/mcp";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { AppControl } from "./app-control";
import { AuthError, checkAllowlist, getSharedIndexStub, getUserControlStub, isAdmin, isDevMode, verifyAccess } from "./auth";
import { CodingAgent } from "./coding-agent";
import { log } from "./logger";
import { createDodoMcpServer } from "./mcp";
import { MCP_CATALOG } from "./mcp-catalog";
import { AllowlistOutbound } from "./outbound";
import { RateLimiter } from "./rate-limit";
import { signCookie, verifyCookie } from "./share";
import { SharedIndex } from "./shared-index";
import { UserControl } from "./user-control";
import type { AccessIdentity, AppConfig, Env } from "./types";

// ─── Per-isolate rate limiters ───

const promptLimiter = new RateLimiter();
const shareLimiter = new RateLimiter();
const messageLimiter = new RateLimiter();

// Cleanup expired windows every 5 minutes
setInterval(() => {
  promptLimiter.cleanup();
  shareLimiter.cleanup();
  messageLimiter.cleanup();
}, 5 * 60 * 1000);

type PermissionLevel = "readonly" | "readwrite" | "write" | "admin";

type HonoEnv = { Bindings: Env; Variables: { identity: AccessIdentity; userEmail: string; sessionPermission: PermissionLevel } };

const app = new Hono<HonoEnv>();

app.use("*", cors({ origin: "*", allowHeaders: ["Content-Type", "x-dodo-session-id"], allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }));

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

async function verifySessionAccess(env: Env, email: string, sessionId: string): Promise<boolean> {
  const stub = getUserControlStub(env, email);
  const response = await stub.fetch(`https://user-control/sessions/${encodeURIComponent(sessionId)}/check`);
  if (response.ok) return true;
  if (isAdmin(email, env)) return true;
  return false;
}

/**
 * Determine the effective permission level for a user on a session.
 * - Session owner → "admin"
 * - Admin user → "admin"
 * - Granted permission via SharedIndex → "readonly" | "readwrite"
 * - Share cookie guest → permission from signed cookie
 * - Otherwise → null (no access)
 */
async function resolveSessionPermission(
  env: Env,
  email: string,
  sessionId: string,
  request: Request,
): Promise<PermissionLevel | null> {
  // Session owner gets admin
  const ownerStub = getUserControlStub(env, email);
  const ownerCheck = await ownerStub.fetch(`https://user-control/sessions/${encodeURIComponent(sessionId)}/check`);
  if (ownerCheck.ok) return "admin";

  // Platform admin gets admin
  if (isAdmin(email, env)) return "admin";

  // Check SharedIndex for granted permission
  const permRes = await proxyToSharedIndex(env, `/permissions/${encodeURIComponent(sessionId)}/${encodeURIComponent(email)}`);
  if (permRes.ok) {
    const perm = (await permRes.json()) as { permission: string };
    if (perm.permission === "readwrite") return "write";
    if (perm.permission === "readonly") return "readonly";
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
            const parsed = JSON.parse(payload) as { sessionId?: string; permission?: string; expiresAt?: string };
            if (parsed.sessionId === sessionId) {
              if (parsed.expiresAt && new Date(parsed.expiresAt) <= new Date()) continue;
              if (parsed.permission === "readwrite") return "write";
              return "readonly";
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

app.all("/mcp", async (c) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");
  if (!c.env.DODO_MCP_TOKEN || token !== c.env.DODO_MCP_TOKEN) {
    return c.json({ error: "Invalid or missing MCP token" }, 401);
  }
  const server = createDodoMcpServer(c.env);
  const handler = createMcpHandler(server);
  return handler(c.req.raw, c.env, c.executionCtx);
});

// ─── Health (no auth) ───

app.get("/health", (c) => c.json({ status: "ok" }));

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
  return c.json(
    { sessionId: result.sessionId, permission: result.permission },
    200,
    { "Set-Cookie": `dodo_share=${signed}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400` },
  );
});

// ─── Auth middleware ───

app.use("*", async (c, next) => {
  const path = new URL(c.req.raw.url).pathname;
  if (path === "/health" || path === "/mcp" || path.startsWith("/shared/")) return next();

  let identity: AccessIdentity;
  try {
    identity = await verifyAccess(c.req.raw, c.env);
  } catch (error) {
    if (error instanceof AuthError) {
      log("warn", "Auth failure", { source: "unknown", error: error.message });
      return c.json({ error: error.message }, error.status as 401 | 403);
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
      log("warn", "Auth failure", { email: identity.email, source: identity.source, error: "Not on allowlist" });
      return c.json({ error: "Not authorized — not on Dodo allowlist" }, 403);
    }
  }

  log("info", "Auth success", { email: identity.email, source: identity.source });
  c.set("identity", identity);
  c.set("userEmail", identity.email);
  return next();
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

app.post("/api/allowlist", async (c) =>
  proxyToSharedIndex(c.env, "/allowlist", {
    body: await c.req.raw.text(),
    headers: { "content-type": "application/json" },
    method: "POST",
  }),
);

app.delete("/api/allowlist/:hostname", async (c) =>
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
  return proxyToUserControl(c.env, email, "/status");
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
  // Validate URL hostname against host allowlist
  try {
    const parsed = JSON.parse(body) as { url?: string };
    if (parsed.url) {
      const hostname = new URL(parsed.url).hostname.toLowerCase();
      const checkRes = await proxyToSharedIndex(c.env, `/allowlist/check?hostname=${encodeURIComponent(hostname)}`);
      const checkBody = (await checkRes.json()) as { allowed: boolean };
      if (!checkBody.allowed) {
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
  return proxyToUserControl(c.env, email, `/mcp-configs/${encodeURIComponent(c.req.param("id"))}`, {
    body: await c.req.raw.text(),
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
        const checkRes = await proxyToSharedIndex(c.env, `/allowlist/check?hostname=${encodeURIComponent(hostname)}`);
        const checkBody = (await checkRes.json()) as { allowed: boolean };
        if (!checkBody.allowed) {
          return c.json({ error: `Host "${hostname}" is not on the allowlist` }, 403);
        }
      } catch { /* URL parse error — let UserControl handle */ }
    }
  }
  return proxyToUserControl(c.env, email, `/mcp-configs/${encodeURIComponent(c.req.param("id"))}/test`, { method: "POST" });
});

// ─── MCP Catalog (static) ───

app.get("/api/mcp-catalog", (c) => c.json(MCP_CATALOG));

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

// ─── Sessions (per-user via UserControl) ───

app.post("/session", async (c) => {
  const email = c.get("userEmail");
  const sessionId = crypto.randomUUID();
  await proxyToUserControl(c.env, email, "/sessions", {
    body: JSON.stringify({ id: sessionId, ownerEmail: email, createdBy: email }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  log("info", "Session created", { email, sessionId });
  // Increment global session counter
  await proxyToSharedIndex(c.env, "/stats/increment", {
    body: JSON.stringify({ stat: "sessionCount", delta: 1 }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return c.json({ id: sessionId }, 201);
});

app.get("/session", async (c) => {
  const email = c.get("userEmail");
  return proxyToUserControl(c.env, email, "/sessions");
});

// ─── Session ownership + permission middleware ───

app.use("/session/:id/*", async (c, next) => {
  const email = c.get("userEmail");
  const sessionId = c.req.param("id");
  const permission = await resolveSessionPermission(c.env, email, sessionId, c.req.raw);
  if (!permission) {
    return c.json({ error: "Session not found or access denied" }, 403);
  }
  c.set("sessionPermission", permission);
  return next();
});

app.use("/session/:id", async (c, next) => {
  // Skip ownership check for POST (handled by the create route above)
  if (c.req.method === "POST") return next();
  const email = c.get("userEmail");
  const sessionId = c.req.param("id");
  const permission = await resolveSessionPermission(c.env, email, sessionId, c.req.raw);
  if (!permission) {
    return c.json({ error: "Session not found or access denied" }, 403);
  }
  c.set("sessionPermission", permission);
  return next();
});

app.get("/session/:id", async (c) => {
  const denied = requirePermission(c, "readonly");
  if (denied) return denied;
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/", { "x-owner-email": c.get("userEmail") });
});

app.delete("/session/:id", async (c) => {
  const denied = requirePermission(c, "admin");
  if (denied) return denied;
  const sessionId = c.req.param("id");
  const email = c.get("userEmail");
  const result = await proxyToAgent(c.req.raw, c.env, sessionId, "/", { "x-owner-email": email });
  await proxyToUserControl(c.env, email, `/sessions/${sessionId}`, { method: "DELETE" });
  return result;
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
  const config = await readConfig(c.env, email);
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/message", {
    "x-dodo-ai-base-url": config.aiGatewayBaseURL,
    "x-dodo-gateway": config.activeGateway,
    "x-dodo-model": config.model,
    "x-dodo-opencode-base-url": config.opencodeBaseURL,
    "x-author-email": email,
    "x-owner-email": email,
  });
});

app.post("/session/:id/prompt", async (c) => {
  const denied = requirePermission(c, "write");
  if (denied) return denied;
  const email = c.get("userEmail");
  const rl = promptLimiter.check(`prompt:${email}`, 60, 60 * 60 * 1000);
  if (!rl.allowed) return rateLimitedResponse(rl, "prompt", email);
  const config = await readConfig(c.env, email);
  return proxyToAgent(c.req.raw, c.env, c.req.param("id"), "/prompt", {
    "x-dodo-ai-base-url": config.aiGatewayBaseURL,
    "x-dodo-gateway": config.activeGateway,
    "x-dodo-model": config.model,
    "x-dodo-opencode-base-url": config.opencodeBaseURL,
    "x-author-email": email,
    "x-owner-email": email,
  });
});

app.get("/session/:id/ws", async (c) => {
  const upgradeHeader = c.req.header("Upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return c.json({ error: "Expected WebSocket upgrade" }, 426);
  }

  const email = c.get("userEmail");
  const sessionId = c.req.param("id");
  const agent = await getAgentByName(c.env.CODING_AGENT as never, sessionId);

  // Forward WebSocket upgrade to the CodingAgent DO
  const url = new URL(c.req.url);
  const wsUrl = new URL("https://coding-agent/ws");
  wsUrl.searchParams.set("email", email);
  wsUrl.searchParams.set("displayName", email);
  wsUrl.searchParams.set("permission", "readwrite");
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

// ─── Migration endpoint (admin only, one-time) ───

app.post("/api/admin/migrate", adminGuard as never, async (c) => {
  const email = c.get("userEmail");
  try {
    // Read all data from AppControl
    const appControlStub = c.env.APP_CONTROL.get(c.env.APP_CONTROL.idFromName("global"));

    // Migrate sessions
    const sessionsRes = await appControlStub.fetch("https://app-control/sessions");
    const { sessions } = (await sessionsRes.json()) as { sessions: Array<{ id: string; title: string | null; status: string }> };
    for (const session of sessions) {
      await proxyToUserControl(c.env, email, "/sessions", {
        body: JSON.stringify({ id: session.id, title: session.title, ownerEmail: email, createdBy: email }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    }

    // Migrate config
    const configRes = await appControlStub.fetch("https://app-control/config");
    const config = await configRes.json();
    await proxyToUserControl(c.env, email, "/config", {
      body: JSON.stringify(config),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });

    // Migrate memory
    const memoryRes = await appControlStub.fetch("https://app-control/memory");
    const { entries } = (await memoryRes.json()) as { entries: Array<{ title: string; content: string; tags: string[] }> };
    for (const entry of entries) {
      await proxyToUserControl(c.env, email, "/memory", {
        body: JSON.stringify({ title: entry.title, content: entry.content, tags: entry.tags }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    }

    // Migrate tasks
    const tasksRes = await appControlStub.fetch("https://app-control/tasks");
    const { tasks } = (await tasksRes.json()) as { tasks: Array<{ title: string; description: string; priority: string; status: string }> };
    for (const task of tasks) {
      const createRes = await proxyToUserControl(c.env, email, "/tasks", {
        body: JSON.stringify({ title: task.title, description: task.description, priority: task.priority }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (task.status !== "backlog") {
        const created = (await createRes.json()) as { id: string };
        await proxyToUserControl(c.env, email, `/tasks/${created.id}`, {
          body: JSON.stringify({ status: task.status }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        });
      }
    }

    // Migrate allowlist
    const allowlistRes = await appControlStub.fetch("https://app-control/allowlist");
    const { hosts } = (await allowlistRes.json()) as { hosts: Array<{ hostname: string }> };
    for (const host of hosts) {
      await proxyToSharedIndex(c.env, "/allowlist", {
        body: JSON.stringify({ hostname: host.hostname }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    }

    return c.json({
      migrated: true,
      sessions: sessions.length,
      memory: entries.length,
      tasks: tasks.length,
      hosts: hosts.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Migration failed";
    return c.json({ error: message }, 500);
  }
});

export { AllowlistOutbound, AppControl, CodingAgent, SharedIndex, UserControl };

export default {
  fetch(request: Request, env: Env, executionContext: ExecutionContext): Promise<Response> {
    return Promise.resolve(app.fetch(request, env, executionContext));
  },
};
