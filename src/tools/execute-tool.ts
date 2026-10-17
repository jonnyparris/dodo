/**
 * Codemode `execute` tool: the model writes JavaScript that calls Dodo's
 * tools (`codemode.*`, plus extra namespaces like `git.*` and the `state.*`
 * filesystem API), run in a sandboxed Dynamic Worker. Ported from
 * @cloudflare/think's createExecuteTool (MIT); the same wiring over
 * @cloudflare/codemode and @cloudflare/shell.
 */
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { ToolProvider } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";
import type { StateBackend } from "@cloudflare/shell";
import { stateToolsFromBackend } from "@cloudflare/shell/workers";
import type { ToolSet } from "ai";

export interface ExecuteToolOptions {
  /** Exposed to the sandbox as `codemode.*`. */
  tools: ToolSet;
  /** Extra namespaces, e.g. `{ name: "git", tools }`. */
  providers?: ToolProvider[];
  /** Exposed as `state.*` (filesystem API) when given. */
  state?: StateBackend;
  loader: WorkerLoader;
  timeout?: number;
  globalOutbound?: Fetcher | null;
  description?: string;
}

export function createExecuteTool(options: ExecuteToolOptions) {
  const executor = new DynamicWorkerExecutor({
    loader: options.loader,
    timeout: options.timeout,
    globalOutbound: options.globalOutbound,
  });
  const providers: ToolProvider[] = [{ tools: options.tools } as ToolProvider, ...(options.providers ?? [])];
  if (options.state) providers.push(stateToolsFromBackend(options.state) as ToolProvider);
  return createCodeTool({ tools: providers, executor, description: options.description } as never);
}
