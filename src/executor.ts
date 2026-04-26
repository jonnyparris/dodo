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
 * Why a dynamically-loaded Worker rather than a plain JS object?
 * `globalOutbound` must be a real `Fetcher` produced by the runtime —
 * a duck-typed `{ fetch }` object cast via `as Fetcher` is rejected at
 * runtime with:
 *
 *   Incorrect type for the 'globalOutbound' field on 'WorkerCode':
 *   the provided value is not of type 'Fetcher'.
 *
 * `WorkerLoader.get()` returns a `WorkerStub` whose `getEntrypoint()`
 * is a real `Fetcher` the runtime accepts. We load a tiny passthrough
 * Worker whose own `globalOutbound` is the parent's `OUTBOUND` binding,
 * and whose code injects `x-dodo-owner-id` before forwarding via the
 * implicit-pass-through `fetch()` (which routes through globalOutbound).
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
export function wrapOutboundWithOwner(
  loader: WorkerLoader | undefined,
  outbound: Fetcher | null,
  ownerId: string | undefined,
): Fetcher | null {
  if (!outbound || !ownerId) return outbound;
  if (!loader) return outbound;

  // JSON-encode the ownerId to make string injection into the wrapper
  // module source safe even if the value contained quotes or newlines.
  const ownerIdLiteral = JSON.stringify(ownerId);
  const headerLiteral = JSON.stringify(OWNER_ID_HEADER);

  const wrapperSource = `
    export default {
      async fetch(request) {
        const headers = new Headers(request.headers);
        // Server-resolved owner ID — sandboxed code cannot spoof it.
        headers.set(${headerLiteral}, ${ownerIdLiteral});
        return fetch(new Request(request, { headers }));
      },
    };
  `;

  // Stable name keyed on ownerId so repeated executions reuse the
  // already-loaded wrapper isolate (workerd caches by name).
  const stub = loader.get(`outbound-wrapper-${ownerId}`, () => ({
    compatibilityDate: "2024-12-01",
    mainModule: "wrapper.js",
    modules: { "wrapper.js": wrapperSource },
    // The wrapper's own outbound IS the parent's OUTBOUND binding —
    // its top-level `fetch()` calls go straight to AllowlistOutbound.
    globalOutbound: outbound,
  }));

  return stub.getEntrypoint();
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

  const baseOutbound = input.env.OUTBOUND ?? null;
  const outbound = wrapOutboundWithOwner(input.env.LOADER, baseOutbound, input.ownerId);

  const executor = new DynamicWorkerExecutor({
    globalOutbound: outbound,
    loader: input.env.LOADER,
    timeout: 30000,
  });

  return executor.execute(input.code, [resolveProvider(stateTools(input.workspace))]);
}
