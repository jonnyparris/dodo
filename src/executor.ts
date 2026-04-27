import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";
import type { Workspace } from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";
import type { ExecuteResult } from "@cloudflare/codemode";
import type { Env } from "./types";

/**
 * Header name for injecting the session owner ID into outbound requests.
 * Read by AllowlistOutbound.injectAuth to look up per-user secrets in
 * UserControl. The header is stripped before the request leaves the
 * Worker (see src/outbound.ts).
 */
export const OWNER_ID_HEADER = "x-dodo-owner-id";

/**
 * Wrap the OUTBOUND service binding so every fetch() the sandbox makes
 * carries an `x-dodo-owner-id` header bound to the calling user.
 *
 * Without this wrapper, AllowlistOutbound has no way to resolve which
 * user's encrypted secrets to use, so per-user GitHub/GitLab tokens
 * never reach outbound requests from codemode and the env-var fallback
 * is also skipped (audit finding H4).
 *
 * Exported because the AI-tool codemode path in `agentic.ts` also needs
 * to apply the same wrapper — without it, owner-id was only injected
 * for the HTTP `/execute` route, not for sandbox fetches issued via the
 * agent loop's `codemode` tool.
 */
export function wrapOutboundWithOwner(outbound: Fetcher | null, ownerId: string | undefined): Fetcher | null {
  if (!outbound || !ownerId) return outbound;

  // Return a Fetcher-shaped object. Workers runtime requires the real
  // ServiceStub at the binding level, but accepts any object exposing
  // `fetch(...)` once codemode has captured the reference.
  const wrapped = {
    fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
      const request = new Request(input, init);
      const headers = new Headers(request.headers);
      // Don't allow the sandboxed code to spoof the owner header — always
      // overwrite with the server-resolved value.
      headers.set(OWNER_ID_HEADER, ownerId);
      return outbound.fetch(new Request(request, { headers }));
    },
  } as unknown as Fetcher;

  return wrapped;
}

export async function runSandboxedCode(input: {
  code: string;
  env: Env;
  workspace: Workspace;
  /**
   * Stable identifier for the calling user (typically the hex string of
   * their UserControl DO ID). Forwarded to AllowlistOutbound so per-user
   * secrets resolve correctly inside the sandbox.
   */
  ownerId?: string;
}): Promise<ExecuteResult> {
  if (!input.env.LOADER) {
    throw new Error("Dynamic Worker loader is not configured");
  }

  // Pass the real OUTBOUND ServiceStub directly. The Workers runtime enforces
  // that globalOutbound must be a Fetcher produced by a service binding —
  // plain objects cast via `as Fetcher` fail with a type error at runtime.
  const baseOutbound = input.env.OUTBOUND ?? null;
  const outbound = wrapOutboundWithOwner(baseOutbound, input.ownerId);

  const executor = new DynamicWorkerExecutor({
    globalOutbound: outbound,
    loader: input.env.LOADER,
    timeout: 30000,
  });

  return executor.execute(input.code, [resolveProvider(stateTools(input.workspace))]);
}
