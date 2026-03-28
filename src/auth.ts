import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AccessIdentity, Env } from "./types";

const DEV_EMAIL = "dev@dodo.local";

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

export async function verifyAccess(request: Request, env: Env): Promise<AccessIdentity> {
  if (env.ALLOW_UNAUTHENTICATED_DEV === "true") {
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
