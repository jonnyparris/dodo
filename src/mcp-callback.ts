/**
 * The development-only loopback value shipped as the default `WORKER_URL`
 * in wrangler.jsonc. It must never be used as a public callback host.
 */
export const DEV_LOOPBACK_WORKER_URL = "http://localhost:8787";

/**
 * Resolve the public base URL used to build an MCP OAuth redirect URI.
 *
 * Prefers an explicit `WORKER_URL` override, but treats the development
 * loopback default as "unset" and falls back to the live request origin.
 * Production deploys that never overrode `WORKER_URL` therefore still
 * register a reachable callback instead of `http://localhost:8787/...`.
 */
export function resolveMcpCallbackHost(workerUrl: string | undefined, requestUrl: string): string {
  if (workerUrl && workerUrl !== DEV_LOOPBACK_WORKER_URL) return workerUrl;
  const url = new URL(requestUrl);
  return `${url.protocol}//${url.host}`;
}
