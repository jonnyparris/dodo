import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AccessIdentity, Env } from "./types";

const DEV_EMAIL = "dev@dodo.local";

/** Resolve the admin email from env, with a hardcoded fallback. */
export function resolveAdminEmail(env: Env): string {
  return env.ADMIN_EMAIL ?? "you@example.com";
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

// ─── DO Stub Helpers ───

export function getSharedIndexStub(env: Env): DurableObjectStub {
  return env.SHARED_INDEX.get(env.SHARED_INDEX.idFromName("global"));
}

export function getUserControlStub(env: Env, email: string): DurableObjectStub {
  return env.USER_CONTROL.get(env.USER_CONTROL.idFromName(email));
}
