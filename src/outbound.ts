import { WorkerEntrypoint } from "cloudflare:workers";
import { getSharedIndexStub } from "./auth";
import { OWNER_ID_HEADER } from "./executor";
import type { Env } from "./types";

const GITHUB_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
]);

const GITLAB_HOSTS = new Set([
  "gitlab.com",
  "gitlab.cfdata.org",
]);

/**
 * Returns true if the hostname is a known GitLab instance —
 * either an exact match or a subdomain of a known host.
 */
function isGitLabHost(hostname: string): boolean {
  if (GITLAB_HOSTS.has(hostname)) return true;
  for (const known of GITLAB_HOSTS) {
    if (hostname.endsWith(`.${known}`)) return true;
  }
  return false;
}

/**
 * Return the encrypted secret key for a known provider host, or undefined.
 */
function secretKeyForHost(hostname: string): string | undefined {
  if (GITHUB_HOSTS.has(hostname)) return "github_token";
  if (isGitLabHost(hostname)) return "gitlab_token";
  return undefined;
}

/**
 * WorkerEntrypoint that intercepts all outbound fetch() calls from sandboxed
 * dynamic workers. Checks the hostname against the SharedIndex allowlist and
 * blocks requests to hosts that are not explicitly allowed.
 *
 * For allowlisted hosts that match a known provider (GitHub, GitLab), resolves
 * per-user authentication tokens from the owner's UserControl DO via the
 * `x-dodo-owner-id` header. Falls back to env var tokens only for the admin
 * account.
 *
 * Configured as a self-referencing service binding (OUTBOUND) in wrangler.jsonc
 * and passed as `globalOutbound` to DynamicWorkerExecutor.
 */
export class AllowlistOutbound extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const hostname = url.hostname.toLowerCase();

    const stub = getSharedIndexStub(this.env);
    const checkResponse = await stub.fetch(
      `https://shared-index/allowlist/check?hostname=${encodeURIComponent(hostname)}`,
    );
    const { allowed } = (await checkResponse.json()) as { allowed: boolean };

    if (!allowed) {
      return new Response(
        JSON.stringify({ error: `Outbound request to ${hostname} blocked — not in allowlist` }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }

    // Extract and strip owner identity header before forwarding
    const ownerId = request.headers.get(OWNER_ID_HEADER);
    const headers = new Headers(request.headers);
    headers.delete(OWNER_ID_HEADER);

    // Inject authentication headers for known providers
    await this.injectAuth(hostname, headers, ownerId);

    // Clone via the original request to preserve all properties (cf, signal, etc.)
    const outboundRequest = new Request(request, { headers });

    return fetch(outboundRequest);
  }

  /**
   * Resolve and inject auth headers for known providers.
   *
   * Priority:
   * 1. Per-user encrypted secret from UserControl DO (if ownerId present)
   * 2. Env var fallback — only if the owner is the admin account
   * 3. No auth — request proceeds unauthenticated
   */
  private async injectAuth(hostname: string, headers: Headers, ownerId: string | null): Promise<void> {
    const secretKey = secretKeyForHost(hostname);
    if (!secretKey) return;

    // Skip if the request already carries its own auth
    if (GITHUB_HOSTS.has(hostname) && headers.has("Authorization")) return;
    if (isGitLabHost(hostname) && (headers.has("Authorization") || headers.has("PRIVATE-TOKEN"))) return;

    // Try per-user secret
    let token: string | undefined;
    if (ownerId) {
      token = await this.fetchUserSecret(ownerId, secretKey);
    }

    // Restricted env var fallback — admin account only
    if (!token && ownerId) {
      const adminEmail = this.env.ADMIN_EMAIL ?? "ruskin.constant@gmail.com";
      const adminId = this.env.USER_CONTROL.idFromName(adminEmail).toString();
      if (ownerId === adminId) {
        token = this.envTokenForHost(hostname);
      }
    }

    if (!token) return;

    // Inject the appropriate header
    if (GITHUB_HOSTS.has(hostname)) {
      headers.set("Authorization", `token ${token}`);
      if (!headers.has("User-Agent")) {
        headers.set("User-Agent", "dodo-agent");
      }
    } else if (isGitLabHost(hostname)) {
      headers.set("PRIVATE-TOKEN", token);
    }
  }

  /**
   * Fetch a decrypted secret from the owner's UserControl DO.
   * The ownerId is the hex string of the DO ID — we reconstruct the stub directly.
   */
  private async fetchUserSecret(ownerId: string, secretKey: string): Promise<string | undefined> {
    try {
      const doId = this.env.USER_CONTROL.idFromString(ownerId);
      const stub = this.env.USER_CONTROL.get(doId);
      const res = await stub.fetch(
        `https://user-control/internal/secret/${encodeURIComponent(secretKey)}`,
      );
      if (res.ok) {
        const { value } = (await res.json()) as { value: string };
        return value || undefined;
      }
    } catch {
      // Log but don't fail the request — secret resolution is best-effort
    }
    return undefined;
  }

  /** Read a token from env vars for the given hostname. */
  private envTokenForHost(hostname: string): string | undefined {
    if (GITHUB_HOSTS.has(hostname)) return this.env.GITHUB_TOKEN;
    if (isGitLabHost(hostname)) return this.env.GITLAB_TOKEN;
    return undefined;
  }
}
