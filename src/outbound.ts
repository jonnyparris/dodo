import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./types";

/**
 * WorkerEntrypoint that intercepts all outbound fetch() calls from sandboxed
 * dynamic workers. Checks the hostname against the AppControl allowlist and
 * blocks requests to hosts that are not explicitly allowed.
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

    // Forward the request to the actual destination
    return fetch(request);
  }
}
