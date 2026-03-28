import type { Env } from "./types";

/**
 * Creates a Fetcher that checks the AppControl allowlist before proxying outbound requests.
 * Rejects requests to hosts not in the allowlist.
 */
export function createAllowlistFetcher(env: Env): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      const hostname = url.hostname.toLowerCase();

      const stub = env.APP_CONTROL.get(env.APP_CONTROL.idFromName("global"));
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

      return fetch(input, init);
    },
    connect: () => {
      throw new Error("Outbound TCP connections are not allowed from sandboxed code");
    },
  } as unknown as Fetcher;
}
