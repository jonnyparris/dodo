import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";
import type { Workspace } from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";
import type { ExecuteResult } from "@cloudflare/codemode";
import type { Env } from "./types";

export async function runSandboxedCode(input: {
  code: string;
  env: Env;
  workspace: Workspace;
}): Promise<ExecuteResult> {
  if (!input.env.LOADER) {
    throw new Error("Dynamic Worker loader is not configured");
  }

  const executor = new DynamicWorkerExecutor({
    globalOutbound: input.env.OUTBOUND ?? null,
    loader: input.env.LOADER,
    timeout: 30000,
  });

  return executor.execute(input.code, [resolveProvider(stateTools(input.workspace))]);
}
