import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./types";

/**
 * WorkerEntrypoint that intercepts all outbound fetch() calls from sandboxed
 * dynamic workers. Checks the hostname against the AppControl allowlist and
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

    const stub = this.env.APP_CONTROL.get(this.env.APP_CONTROL.idFromName("global"));
    const checkResponse = await stub.fetch(
      `https://app-control/allowlist/check?hostname=${encodeURIComponent(hostname)}`,
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

    const outboundRequest = new Request(request.url, {
      body: request.body,
      headers,
      method: request.method,
      redirect: request.redirect,
    });

    return fetch(outboundRequest);
  }

  /**
   * Injects auth headers for known providers if a token is available and
   * the request doesn't already carry its own Authorization header.
   */
  private injectAuth(hostname: string, headers: Headers): void {
    if (headers.has("Authorization")) {
      return;
    }

    if (
      hostname === "api.github.com" ||
      hostname === "github.com" ||
      hostname === "raw.githubusercontent.com" ||
      hostname === "objects.githubusercontent.com"
    ) {
      const token = this.env.GITHUB_TOKEN;
      if (token) {
        headers.set("Authorization", `token ${token}`);
        if (!headers.has("User-Agent")) {
          headers.set("User-Agent", "dodo-agent");
        }
      }
    } else if (hostname.includes("gitlab")) {
      const token = this.env.GITLAB_TOKEN;
      if (token) {
        headers.set("PRIVATE-TOKEN", token);
      }
    }
  }
}
