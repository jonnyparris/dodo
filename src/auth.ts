import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AccessIdentity, Env } from "./types";

const DEV_EMAIL = "dev@dodo.local";
const PLACEHOLDER_VALUES = new Set(["your-cf-access-audience-tag", "https://your-team.cloudflareaccess.com", ""]);

/** Resolve the admin email from env. Returns undefined when not configured. */
export function resolveAdminEmail(env: Env): string | undefined {
  if (!env.ADMIN_EMAIL || env.ADMIN_EMAIL === "you@example.com") return undefined;
  return env.ADMIN_EMAIL;
}

/** Check whether Cloudflare Access JWT validation is configured. */
export function isAccessConfigured(env: Env): boolean {
  return !!(
    env.CF_ACCESS_AUD &&
    env.CF_ACCESS_TEAM_DOMAIN &&
    !PLACEHOLDER_VALUES.has(env.CF_ACCESS_AUD) &&
    !PLACEHOLDER_VALUES.has(env.CF_ACCESS_TEAM_DOMAIN)
  );
}

function readAccessToken(request: Request): string | null {
  const headerToken = request.headers.get("Cf-Access-Jwt-Assertion");
  if (headerToken) {
    return headerToken;
  }

  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) {
    return null;
  }

  for (const cookie of cookieHeader.split(";")) {
    const trimmed = cookie.trim();
    if (trimmed.startsWith("CF_Authorization=")) {
      return trimmed.slice("CF_Authorization=".length);
    }
  }

  return null;
}

export class AuthError extends Error {
  readonly status: number;

  constructor(message: string, status = 403) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export function isDevMode(env: Env): boolean {
  return env.ALLOW_UNAUTHENTICATED_DEV === "true";
}

export async function verifyAccess(request: Request, env: Env): Promise<AccessIdentity> {
  if (isDevMode(env)) {
    return { email: DEV_EMAIL, source: "dev" };
  }

  // When Access is not configured, trust the email header (if Access is in
  // front at the network level) or fall back to the admin email.
  if (!isAccessConfigured(env)) {
    const headerEmail = request.headers.get("Cf-Access-Authenticated-User-Email");
    if (headerEmail) return { email: headerEmail, source: "access" };
    const admin = resolveAdminEmail(env);
    if (admin) return { email: admin, source: "dev" };
    throw new AuthError("ADMIN_EMAIL is not configured. Set it with: wrangler secret put ADMIN_EMAIL", 500);
  }

  const token = readAccessToken(request);
  if (!token) {
    throw new AuthError("Missing Cloudflare Access token", 403);
  }

  let payload: Record<string, unknown>;
  try {
    const jwks = createRemoteJWKSet(new URL(`${env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
    const result = await jwtVerify(token, jwks, {
      audience: env.CF_ACCESS_AUD,
      issuer: env.CF_ACCESS_TEAM_DOMAIN,
    });
    payload = result.payload as Record<string, unknown>;
  } catch {
    throw new AuthError("Invalid or expired Access token", 401);
  }

  return {
    email:
      (typeof payload.email === "string" ? payload.email : null) ??
      request.headers.get("Cf-Access-Authenticated-User-Email"),
    source: "access",
  };
}

/** Check if user is on the Dodo allowlist (SharedIndex DO). */
export async function checkAllowlist(email: string, env: Env): Promise<{ allowed: boolean; role?: string }> {
  const stub = getSharedIndexStub(env);
  const response = await stub.fetch(`https://shared-index/users/check?email=${encodeURIComponent(email)}`);
  if (!response.ok) return { allowed: false };
  return (await response.json()) as { allowed: boolean; role?: string };
}

/** Check if an email is the admin. */
export function isAdmin(email: string | null, env: Env): boolean {
  if (!email) return false;
  return email === resolveAdminEmail(env);
}

/** Check if a user has browser access enabled (admin-controlled flag in SharedIndex). */
export async function checkBrowserEnabled(email: string, env: Env): Promise<boolean> {
  // Admin always has browser access
  if (isAdmin(email, env)) return true;
  const stub = getSharedIndexStub(env);
  const response = await stub.fetch(`https://shared-index/users/${encodeURIComponent(email)}/browser`);
  if (!response.ok) return false;
  const data = (await response.json()) as { browserEnabled: boolean };
  return data.browserEnabled;
}

// ─── DO Stub Helpers ───

export function getSharedIndexStub(env: Env): DurableObjectStub {
  return env.SHARED_INDEX.get(env.SHARED_INDEX.idFromName("global"));
}

export function getUserControlStub(env: Env, email: string): DurableObjectStub {
  return env.USER_CONTROL.get(env.USER_CONTROL.idFromName(email));
}
