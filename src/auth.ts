import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AccessIdentity, Env } from "./types";

const DEV_EMAIL = "dev@dodo.local";
const PLACEHOLDER_VALUES = new Set(["your-cf-access-audience-tag", "https://your-team.cloudflareaccess.com", ""]);

/** Resolve the admin email from env. Returns undefined when not configured.
 *  Always returns the canonical (lowercased+trimmed) form so admin checks
 *  match regardless of how ADMIN_EMAIL was provisioned. */
export function resolveAdminEmail(env: Env): string | undefined {
  if (!env.ADMIN_EMAIL || env.ADMIN_EMAIL === "you@example.com") return undefined;
  const canonical = env.ADMIN_EMAIL.trim().toLowerCase();
  return canonical || undefined;
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

/**
 * Canonicalize an email for consistent DO keying, admin checks, and
 * SharedIndex lookups. Trims whitespace and lowercases. Returns null for
 * empty / non-string input.
 *
 * Every place that derives a DO ID from an email or compares an email
 * against `resolveAdminEmail` MUST use this helper. Mixed casing in
 * different parts of the system silently routes a user to a different
 * UserControl DO and bypasses admin checks (audit finding H5).
 */
export function canonicalizeEmail(email: string | null | undefined): string | null {
  if (typeof email !== "string") return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed || null;
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

  // When Access is not configured, ONLY trust the client-set
  // Cf-Access-Authenticated-User-Email header in dev mode. In production
  // (no dev flag, no Access JWT validation), there is no way to verify
  // that header came from an Access edge — refuse the request rather than
  // accept arbitrary identities. (audit finding M1)
  if (!isAccessConfigured(env)) {
    if (!isDevMode(env)) {
      throw new AuthError(
        "Cloudflare Access is not configured (CF_ACCESS_AUD / CF_ACCESS_TEAM_DOMAIN). Configure Access or set ALLOW_UNAUTHENTICATED_DEV=true for local dev.",
        500,
      );
    }
    const headerEmail = canonicalizeEmail(request.headers.get("Cf-Access-Authenticated-User-Email"));
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

  const rawEmail = (typeof payload.email === "string" ? payload.email : null) ??
    request.headers.get("Cf-Access-Authenticated-User-Email");
  return {
    email: canonicalizeEmail(rawEmail),
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

/** Check if an email is the admin. Compares canonical forms so the check
 *  is case-insensitive (audit finding H5). */
export function isAdmin(email: string | null, env: Env): boolean {
  const canonical = canonicalizeEmail(email);
  if (!canonical) return false;
  return canonical === resolveAdminEmail(env);
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
  // Always canonicalize so DO routing is deterministic regardless of caller
  // casing (audit finding H5).
  const canonical = canonicalizeEmail(email);
  if (!canonical) {
    throw new Error("getUserControlStub: email is required");
  }
  return env.USER_CONTROL.get(env.USER_CONTROL.idFromName(canonical));
}
