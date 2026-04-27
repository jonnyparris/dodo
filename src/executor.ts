import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";
import type { Workspace } from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";
import type { ExecuteResult } from "@cloudflare/codemode";
import type { AllowlistOutbound } from "./outbound";
import type { Env } from "./types";

/**
 * Bind the OUTBOUND self-binding with per-call props carrying the owner
 * identity, so AllowlistOutbound can resolve per-user secrets without
 * trusting any sandbox-controlled channel.
 *
 * Why props, not a wrapper: workerd has two rules in tension that ruled
 * out earlier attempts at this:
 *
 *   1. `globalOutbound` must be a real `Fetcher` produced by the runtime
 *      — not a duck-typed `{ fetch }` cast `as Fetcher`.
 *   2. The Fetcher must be transferable across the `LOADER.get()` boundary
 *      into the codemode-spawned sandbox — a stub from another `LOADER.get()`
 *      is NOT transferable.
 *
 * `LoopbackServiceStub({ props })` returns a real, transferable Fetcher that
 * carries `props` through workerd's RPC mechanism. The receiving entrypoint
 * (AllowlistOutbound) reads them from `this.ctx.props`. Sandboxed code never
 * sees the owner identity and cannot forge it.
 *
 * Returns the original outbound unchanged when there's no ownerId or no
 * outbound — both safe (AllowlistOutbound treats missing props as "no
 * per-user auth available", same as before).
 */
export function bindOutboundWithOwner(
  outbound: LoopbackServiceStub<AllowlistOutbound> | undefined,
  ownerId: string | undefined,
): Fetcher | null {
  if (!outbound) return null;
  if (!ownerId) return outbound;
  return outbound({ props: { ownerId } });
}

export async function runSandboxedCode(input: {
  code: string;
  env: Env;
  workspace: Workspace;
  /**
   * Stable identifier for the calling user (typically the hex string of
   * their UserControl DO ID). Forwarded to AllowlistOutbound via per-call
   * props so per-user secrets resolve correctly inside the sandbox.
   */
  ownerId?: string;
}): Promise<ExecuteResult> {
  if (!input.env.LOADER) {
    throw new Error("Dynamic Worker loader is not configured");
  }

  const outbound = bindOutboundWithOwner(input.env.OUTBOUND, input.ownerId);

  const executor = new DynamicWorkerExecutor({
    globalOutbound: outbound,
    loader: input.env.LOADER,
    timeout: 30000,
  });

  return executor.execute(input.code, [resolveProvider(stateTools(input.workspace))]);
}
