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
  if (options.state) providers.push(withJsonSafeBytes(stateToolsFromBackend(options.state) as ToolProvider));
  return createCodeTool({ tools: providers, executor, description: options.description } as never);
}

/**
 * Codemode sends sandbox → host calls as JSON, so a Uint8Array arrives as
 * {"0":137,"1":80,...} (writeFileBytes then failed with "NOT NULL
 * constraint failed: vfs_nodes.size") and comes back the same way (and
 * `new Uint8Array(thatObject)` is empty). Rebuild bytes on the way in and
 * return plain number arrays, which `new Uint8Array(x)` accepts.
 */
export function withJsonSafeBytes(provider: ToolProvider): ToolProvider {
  const tools = { ...(provider.tools as Record<string, { execute: (...a: unknown[]) => unknown }>) };
  const wrap = (name: string, fn: (orig: (...a: unknown[]) => unknown) => (...a: unknown[]) => unknown) => {
    const t = tools[name];
    if (t) tools[name] = { ...t, execute: fn(t.execute) };
  };
  wrap("writeFileBytes", (orig) => (path, data, ...rest) => orig(path, toBytes(data), ...rest));
  wrap("appendFile", (orig) => (path, data, ...rest) => orig(path, typeof data === "string" ? data : toBytes(data), ...rest));
  wrap("readFileBytes", (orig) => async (...a) => {
    const out = await orig(...a);
    return out instanceof Uint8Array ? Array.from(out) : out;
  });
  return { ...provider, tools } as ToolProvider;
}

export function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  if (data && typeof data === "object") {
    const keys = Object.keys(data);
    if (keys.every((k, i) => k === String(i))) return Uint8Array.from(Object.values(data as Record<string, number>));
  }
  throw new TypeError("expected bytes: a Uint8Array or an array of numbers");
}
