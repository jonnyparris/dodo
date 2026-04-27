import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";
import type { Workspace } from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";
import type { ExecuteResult } from "@cloudflare/codemode";
import type { Env } from "./types";

/**
 * Header name historically used to inject the session owner ID into outbound
 * requests for per-user token resolution. Currently unused — the duck-typed
 * wrapper that set it broke `globalOutbound` (workerd rejects non-ServiceStub
 * Fetchers at WorkerCode validation time). Three attempts at restoring per-user
 * auth via different routes (PR #52 LOADER.get, PR #54 per-call props,
 * PR #55 revert) all failed for runtime/architectural reasons.
 *
 * Kept exported for the constant + future reuse if a proxy-Worker approach
 * (Option C) is implemented. The current AllowlistOutbound only enforces the
 * hostname allowlist; sandbox `fetch()` calls run unauthenticated against the
 * remote, and codemode tool authors must include their own auth headers when
 * needed. Git operations are unaffected — auth resolves in the parent DO via
 * resolveRemoteToken() and is passed directly to isomorphic-git.
 */
export const OWNER_ID_HEADER = "x-dodo-owner-id";

export async function runSandboxedCode(input: {
  code: string;
  env: Env;
  workspace: Workspace;
  /**
   * Stable identifier for the calling user. Currently accepted for API
   * compatibility but not threaded through — see OWNER_ID_HEADER docstring
   * for the history. Kept on the signature so callers don't need to change
   * if/when per-user injection is restored.
   */
  ownerId?: string;
}): Promise<ExecuteResult> {
  if (!input.env.LOADER) {
    throw new Error("Dynamic Worker loader is not configured");
  }

  // Pass the real OUTBOUND ServiceStub directly. workerd validates that
  // globalOutbound is a Fetcher produced by a service binding — plain
  // objects cast via `as Fetcher` fail at WorkerCode construction with
  // "Incorrect type for the 'globalOutbound' field on 'WorkerCode'".
  // The allowlist still applies because OUTBOUND points at AllowlistOutbound.
  const outbound = input.env.OUTBOUND ?? null;

  const executor = new DynamicWorkerExecutor({
    globalOutbound: outbound,
    loader: input.env.LOADER,
    timeout: 30000,
  });

  void input.ownerId; // see docstring — accepted but unused

  return executor.execute(input.code, [resolveProvider(stateTools(input.workspace))]);
}
