import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";
import type { Workspace } from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";
import type { ExecuteResult } from "@cloudflare/codemode";
import type { Env } from "./types";

/**
 * Header injected into outbound sandbox requests to identify the session owner.
 * Carries the hex DO ID (not email) so no PII is in transit.
 * AllowlistOutbound reads this to resolve per-user secrets.
 */
export const OWNER_ID_HEADER = "x-dodo-owner-id";

/**
 * Wrap an outbound Fetcher to inject the owner's DO ID on every request.
 * AllowlistOutbound strips this header before forwarding.
 */
export function wrapOutboundWithOwner(outbound: Fetcher, ownerId: string): Fetcher {
  return {
    fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
      const request = new Request(input, init);
      request.headers.set(OWNER_ID_HEADER, ownerId);
      return outbound.fetch(request);
    },
  } as Fetcher;
}

export async function runSandboxedCode(input: {
  code: string;
  env: Env;
  workspace: Workspace;
  ownerId?: string;
}): Promise<ExecuteResult> {
  if (!input.env.LOADER) {
    throw new Error("Dynamic Worker loader is not configured");
  }

  const outbound = input.ownerId && input.env.OUTBOUND
    ? wrapOutboundWithOwner(input.env.OUTBOUND, input.ownerId)
    : input.env.OUTBOUND ?? null;

  const executor = new DynamicWorkerExecutor({
    globalOutbound: outbound,
    loader: input.env.LOADER,
    timeout: 30000,
  });

  return executor.execute(input.code, [resolveProvider(stateTools(input.workspace))]);
}
