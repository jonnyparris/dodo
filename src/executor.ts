import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";
import type { Workspace } from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";
import type { ExecuteResult } from "@cloudflare/codemode";
import type { Env } from "./types";

/**
 * Header name for injecting the session owner ID into outbound requests.
 * Retained for potential future use once per-request owner context is
 * plumbed through @cloudflare/codemode. Currently unused by runSandboxedCode.
 */
export const OWNER_ID_HEADER = "x-dodo-owner-id";

export async function runSandboxedCode(input: {
  code: string;
  env: Env;
  workspace: Workspace;
  // ownerId retained in the signature for caller compatibility, but not
  // currently wired into the sandbox. Per-request ownership context needs
  // a WorkerEntrypoint-based injection, not a duck-typed Fetcher wrapper.
  // TODO: plumb ownerId via AllowlistOutbound reading from a DO-local
  // request-scoped context, or via an explicit state tool.
  ownerId?: string;
}): Promise<ExecuteResult> {
  if (!input.env.LOADER) {
    throw new Error("Dynamic Worker loader is not configured");
  }

  // Pass the real OUTBOUND ServiceStub directly. The Workers runtime enforces
  // that globalOutbound must be a Fetcher produced by a service binding —
  // plain objects cast via `as Fetcher` fail with a type error at runtime.
  const outbound = input.env.OUTBOUND ?? null;

  const executor = new DynamicWorkerExecutor({
    globalOutbound: outbound,
    loader: input.env.LOADER,
    timeout: 30000,
  });

  void input.ownerId; // reserved — see TODO above

  return executor.execute(input.code, [resolveProvider(stateTools(input.workspace))]);
}
