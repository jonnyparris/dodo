import { WorkerEntrypoint } from "cloudflare:workers";
import { getSharedIndexStub } from "./auth";
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
 * WorkerEntrypoint that intercepts all outbound fetch() calls from sandboxed
 * dynamic workers. Checks the hostname against the SharedIndex allowlist and
 * blocks requests to hosts that are not explicitly allowed.
 *
 * For allowlisted hosts that match a known provider (GitHub, GitLab), injects
 * authentication headers from the parent worker's secrets so sandboxed code
 * can make authenticated API calls without directly accessing tokens.
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

    // Inject authentication headers for known providers.
    // This keeps tokens out of the sandbox while enabling authenticated requests.
    const headers = new Headers(request.headers);
    this.injectAuth(hostname, headers);

    // Clone via the original request to preserve all properties (cf, signal, etc.)
    const outboundRequest = new Request(request, { headers });

    return fetch(outboundRequest);
  }

  /**
   * Injects auth headers for known providers if a token is available and
   * the request doesn't already carry its own auth headers.
   */
  private injectAuth(hostname: string, headers: Headers): void {
    if (GITHUB_HOSTS.has(hostname)) {
      if (headers.has("Authorization")) return;
      const token = this.env.GITHUB_TOKEN;
      if (token) {
        headers.set("Authorization", `token ${token}`);
        if (!headers.has("User-Agent")) {
          headers.set("User-Agent", "dodo-agent");
        }
      }
    } else if (isGitLabHost(hostname)) {
      if (headers.has("Authorization") || headers.has("PRIVATE-TOKEN")) return;
      const token = this.env.GITLAB_TOKEN;
      if (token) {
        headers.set("PRIVATE-TOKEN", token);
      }
    }
  }
}
