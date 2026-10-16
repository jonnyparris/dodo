// Adapter: Dodo's AI SDK `tool()` objects → pi-durable tool registrations.
//
// The tools themselves (workspace, git, MCP, browser, codemode, ...) are
// Dodo's product surface and stay as they are. What changes is who runs
// them: each call becomes a durable pi `pi.tool` task whose intent is
// committed before execute() runs. After an eviction, read-only tools rerun;
// everything else returns an `interrupted` result to the model instead of
// silently repeating a side effect (git push, PR create, file writes).

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { asSchema, type ToolSet } from "ai";

/**
 * Tools with no external side effects. Safe to rerun after a crash, so an
 * eviction mid-call costs a retry rather than an `interrupted` result.
 * Anything not listed is treated as unsafe — the conservative default.
 */
export const REPLAY_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "list",
  "grep",
  "find",
  "glob",
  "stat",
  "git_status",
  "git_diff",
  "git_log",
  "git_verify_remote_branch",
  "todo_list",
  "read_attachment",
  "browser_markdown",
  "browser_triage",
  "browser_search",
  "web_search",
  "web_fetch",
  "skill",
  "explore",
  "typecheck",
]);

type AiTool = {
  description?: string;
  inputSchema?: unknown;
  execute?: (input: unknown, options: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }) => unknown;
  toModelOutput?: (options: { toolCallId: string; input: unknown; output: unknown }) => unknown;
};

type Content = TextContent | ImageContent;

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stripDataUrl(data: string): string {
  const comma = data.indexOf(",");
  return data.startsWith("data:") && comma >= 0 ? data.slice(comma + 1) : data;
}

/** AI SDK ToolResultOutput (from toModelOutput) → pi content blocks. */
export function modelOutputToContent(output: unknown): { content: Content[]; isError: boolean } {
  const o = output as { type?: string; value?: unknown } | null;
  switch (o?.type) {
    case "text":
      return { content: [{ type: "text", text: String(o.value ?? "") }], isError: false };
    case "json":
      return { content: [{ type: "text", text: stringify(o.value) }], isError: false };
    case "error-text":
      return { content: [{ type: "text", text: String(o.value ?? "") }], isError: true };
    case "error-json":
      return { content: [{ type: "text", text: stringify(o.value) }], isError: true };
    case "content": {
      const parts = Array.isArray(o.value) ? o.value : [];
      const content: Content[] = [];
      for (const part of parts as Array<Record<string, unknown>>) {
        if (part.type === "text") content.push({ type: "text", text: String(part.text ?? "") });
        else if ((part.type === "media" || part.type === "image-data") && typeof part.data === "string") {
          const mimeType = String(part.mediaType ?? "image/png");
          if (mimeType.startsWith("image/")) content.push({ type: "image", data: stripDataUrl(part.data), mimeType });
        }
      }
      return { content, isError: false };
    }
    default:
      return { content: [{ type: "text", text: stringify(output) }], isError: false };
  }
}

async function jsonSchemaOf(tool: AiTool): Promise<Record<string, unknown>> {
  if (!tool.inputSchema) return { type: "object", properties: {} };
  const schema = asSchema(tool.inputSchema as Parameters<typeof asSchema>[0]);
  const resolved = (await schema.jsonSchema) as Record<string, unknown>;
  // Providers reject a top-level $schema key on some gateways.
  const { $schema: _ignored, ...rest } = resolved;
  return rest;
}

export interface AdaptOptions {
  /** Called when a tool call starts executing, by name — Dodo's per-turn tool-name set. */
  onCall?: (name: string) => void;
}

/** Adapt one AI SDK tool. */
export async function adaptTool(name: string, tool: AiTool, options: AdaptOptions = {}): Promise<ToolRegistration> {
  const parameters = await jsonSchemaOf(tool);
  return {
    name,
    description: tool.description ?? name,
    // pi-ai validates plain JSON Schema as well as TypeBox schemas.
    parameters: parameters as unknown as ToolRegistration["parameters"],
    replay: REPLAY_SAFE_TOOLS.has(name) ? "safe" : "unsafe",
    execute: async (args, api, context) => {
      if (!tool.execute) throw new Error(`Tool ${name} has no execute()`);
      options.onCall?.(name);
      const output = await tool.execute(args, {
        toolCallId: api.callId,
        messages: [],
        abortSignal: context.abortSignal,
      });
      if (tool.toModelOutput) {
        const { content, isError } = modelOutputToContent(
          await tool.toModelOutput({ toolCallId: api.callId, input: args, output }),
        );
        return { output: content, isError };
      }
      return { output: [{ type: "text", text: stringify(output) }] };
    },
  };
}

export const DODO_TOOLS_EXTENSION = "dodo-tools";

/** Build the extension carrying the session's current tool set. */
export async function buildToolsExtension(tools: ToolSet, options: AdaptOptions = {}): Promise<Extension> {
  const registrations: ToolRegistration[] = [];
  for (const [name, t] of Object.entries(tools)) {
    registrations.push(await adaptTool(name, t as unknown as AiTool, options));
  }
  return defineExtension({ name: DODO_TOOLS_EXTENSION, tools: registrations });
}
