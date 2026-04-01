import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { StateBackend } from "@cloudflare/shell";
import { generateText, streamText, stepCountIs, tool, zodSchema, type ModelMessage } from "ai";
import { z } from "zod";
import type { Workspace } from "@cloudflare/shell";
import { createWorkspaceGit, defaultAuthor, resolveRemoteToken } from "./git";
import { createWorkspaceTools, createExecuteTool } from "./think-adapter";
import type { AppConfig, Env } from "./types";

const MAX_TOOL_STEPS = 10;

export interface AgenticResult {
  gateway: string;
  model: string;
  steps: number;
  text: string;
  tokenInput: number;
  tokenOutput: number;
  toolCalls: Array<{ code: string; result: unknown }>;
}

function trimBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function buildProvider(config: AppConfig, env: Env) {
  const isOpencode = config.activeGateway === "opencode";
  const baseURL = isOpencode
    ? `${trimBaseUrl(config.opencodeBaseURL)}`
    : `${trimBaseUrl(config.aiGatewayBaseURL)}`;

  const headers: Record<string, string> = isOpencode
    ? { "cf-access-token": env.OPENCODE_GATEWAY_TOKEN ?? "" }
    : { "x-api-key": env.AI_GATEWAY_KEY ?? "" };

  return createOpenAICompatible({
    baseURL,
    headers,
    includeUsage: true,
    name: config.activeGateway,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = any;

function buildGitTools(
  env: Env,
  workspace: Workspace,
  config: AppConfig,
  ownerEmail?: string,
): Record<string, AnyTool> {
  const git = createWorkspaceGit(workspace);

  const dirSchema = zodSchema(z.object({ dir: z.string().optional().describe("Repo directory") }));

  return {
    git_clone: tool({
      description: "Clone a git repo into the workspace. Auth is automatic for GitHub/GitLab.",
      inputSchema: zodSchema(z.object({
        url: z.string().describe("Git repo URL (e.g. https://github.com/owner/repo)"),
        dir: z.string().optional().describe("Target directory (default: repo name)"),
        branch: z.string().optional().describe("Branch to clone"),
        depth: z.number().optional().describe("Shallow clone depth"),
      })),
      execute: async ({ url, dir, branch, depth }) => {
        const token = await resolveRemoteToken({ dir, env, git, url, ownerEmail });
        return git.clone({ branch, depth, dir, singleBranch: true, token, url });
      },
    }),

    git_status: tool({
      description: "Show working tree status (modified, added, deleted files).",
      inputSchema: dirSchema,
      execute: async ({ dir }) => {
        const entries = await git.status({ dir });
        return { entries };
      },
    }),

    git_add: tool({
      description: "Stage files for commit.",
      inputSchema: zodSchema(z.object({
        filepath: z.string().describe("File or directory to stage (use '.' for all)"),
        dir: z.string().optional().describe("Repo directory"),
      })),
      execute: async ({ filepath, dir }) => git.add({ dir, filepath }),
    }),

    git_commit: tool({
      description: "Commit staged changes.",
      inputSchema: zodSchema(z.object({
        message: z.string().describe("Commit message"),
        dir: z.string().optional().describe("Repo directory"),
      })),
      execute: async ({ message, dir }) =>
        git.commit({ author: defaultAuthor(config), dir, message }),
    }),

    git_push: tool({
      description: "Push commits to the remote.",
      inputSchema: zodSchema(z.object({
        dir: z.string().optional().describe("Repo directory"),
        remote: z.string().optional().describe("Remote name (default: origin)"),
        ref: z.string().optional().describe("Branch ref to push"),
        force: z.boolean().optional().describe("Force push"),
      })),
      execute: async ({ dir, remote, ref, force }) => {
        const token = await resolveRemoteToken({ dir, env, git, remote, ownerEmail });
        return git.push({ dir, force, ref, remote, token });
      },
    }),

    git_branch: tool({
      description: "List, create, or delete branches.",
      inputSchema: zodSchema(z.object({
        dir: z.string().optional().describe("Repo directory"),
        name: z.string().optional().describe("Branch name to create"),
        list: z.boolean().optional().describe("List all branches"),
        delete: z.string().optional().describe("Branch name to delete"),
      })),
      execute: async ({ dir, name, list, delete: del }) =>
        git.branch({ delete: del, dir, list, name }),
    }),

    git_checkout: tool({
      description: "Switch branches or restore files.",
      inputSchema: zodSchema(z.object({
        dir: z.string().optional().describe("Repo directory"),
        branch: z.string().optional().describe("Branch to checkout"),
        ref: z.string().optional().describe("Ref (commit/tag) to checkout"),
        force: z.boolean().optional().describe("Force checkout"),
      })),
      execute: async ({ dir, branch, ref, force }) =>
        git.checkout({ branch, dir, force, ref }),
    }),

    git_diff: tool({
      description: "Show unstaged changes in the working tree.",
      inputSchema: dirSchema,
      execute: async ({ dir }) => {
        const entries = await git.diff({ dir });
        return { entries };
      },
    }),

    git_log: tool({
      description: "Show commit history.",
      inputSchema: zodSchema(z.object({
        dir: z.string().optional().describe("Repo directory"),
        depth: z.number().optional().describe("Number of commits to show"),
      })),
      execute: async ({ dir, depth }) => {
        const entries = await git.log({ depth, dir });
        return { entries };
      },
    }),

    git_pull: tool({
      description: "Pull changes from the remote.",
      inputSchema: zodSchema(z.object({
        dir: z.string().optional().describe("Repo directory"),
        remote: z.string().optional().describe("Remote name (default: origin)"),
        ref: z.string().optional().describe("Branch ref to pull"),
      })),
      execute: async ({ dir, remote, ref }) => {
        const token = await resolveRemoteToken({ dir, env, git, remote, ownerEmail });
        return git.pull({ author: defaultAuthor(config), dir, ref, remote, token });
      },
    }),
  };
}

function buildTools(
  env: Env,
  workspace: Workspace,
  config: AppConfig,
  options?: { authorEmail?: string; ownerEmail?: string; stateBackend?: StateBackend },
): Record<string, AnyTool> {
  const tools: Record<string, AnyTool> = {};

  const workspaceTools = createWorkspaceTools(workspace);
  const gitTools = buildGitTools(env, workspace, config, options?.ownerEmail);

  if (env.LOADER) {
    tools.codemode = createExecuteTool({
      tools: workspaceTools,
      state: options?.stateBackend,
      loader: env.LOADER,
      timeout: 30_000,
      globalOutbound: env.OUTBOUND ?? null,
      providers: [
        { name: "git", tools: gitTools },
      ],
    });
  }

  // Workspace tools — available as top-level tools alongside codemode
  Object.assign(tools, workspaceTools);

  // Git tools — always available as top-level tools
  Object.assign(tools, gitTools);

  return tools;
}

/**
 * Build the tool set for Think's getTools() override.
 * Same as buildTools but exported and with explicit stateBackend option.
 */
export function buildToolsForThink(
  env: Env,
  workspace: Workspace,
  config: AppConfig,
  options?: { authorEmail?: string; ownerEmail?: string; stateBackend?: StateBackend },
): Record<string, AnyTool> {
  return buildTools(env, workspace, config, options);
}

/**
 * Browser tools are conditionally loaded based on user's browser_enabled flag.
 * This will be wired up when agents/browser/ai is available.
 */
export function buildBrowserTools(_env: Env, browserEnabled: boolean): Record<string, unknown> {
  if (!browserEnabled) return {};
  // TODO: import createBrowserTools from agents/browser/ai when available
  return {};
}

// TODO: Memory strategy integration
// When MCP tools are wired into the agentic loop, use resolveMemoryStrategy()
// from ../memory-resolver.ts to determine whether to route memory tool calls
// to the external MCP server or the built-in UserControl memory endpoints.
// If external is selected but the connection fails, fall back to builtin.
// See: src/memory-resolver.ts

// TODO: Approval queue integration
// When MCP tools are included in the agentic tool set:
// 1. Before executing a side-effecting MCP tool call, submit to approval queue
// 2. Await approval from the user (via WebSocket callback or polling)
// 3. Only execute if approved
// See: CodingAgent.submitApproval() for the queue infrastructure

function buildMessages(messages: Array<{ content: string; role: string }>): ModelMessage[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ content: m.content, role: m.role as "user" | "assistant" }));
}

function extractToolCalls(steps: Array<{ toolCalls: unknown[]; toolResults: unknown[] }>): AgenticResult["toolCalls"] {
  const toolCalls: AgenticResult["toolCalls"] = [];
  for (const step of steps) {
    for (const call of step.toolCalls) {
      const args = "args" in (call as Record<string, unknown>) ? ((call as Record<string, unknown>).args as unknown) : undefined;
      const code = typeof args === "object" && args !== null && "code" in args ? String((args as { code: string }).code) : "";
      const toolCallId = "toolCallId" in (call as Record<string, unknown>) ? (call as Record<string, unknown>).toolCallId : undefined;
      const toolResult = step.toolResults.find((r) => "toolCallId" in (r as Record<string, unknown>) && (r as Record<string, unknown>).toolCallId === toolCallId);
      const resultValue = toolResult && "result" in (toolResult as Record<string, unknown>) ? (toolResult as Record<string, unknown>).result : null;
      toolCalls.push({ code, result: resultValue });
    }
  }
  return toolCalls;
}

/**
 * Check if the caller is the session owner (i.e. should have access to memory tools).
 * Non-owner guests should not have access to the owner's memory tools.
 */
export function isCallerOwner(authorEmail?: string, ownerEmail?: string): boolean {
  if (!authorEmail || !ownerEmail) return true; // default to owner if unknown
  return authorEmail === ownerEmail;
}

/**
 * Non-streaming agentic chat. Used for async prompts and cron callbacks.
 */
export async function runAgenticChat(input: {
  authorEmail?: string;
  config: AppConfig;
  env: Env;
  messages: Array<{ content: string; role: "assistant" | "system" | "tool" | "user" }>;
  ownerEmail?: string;
  signal?: AbortSignal;
  stateBackend?: StateBackend;
  systemPrompt: string;
  workspace: Workspace;
}): Promise<AgenticResult> {
  const provider = buildProvider(input.config, input.env);
  const model = provider.chatModel(input.config.model);
  const tools = buildTools(input.env, input.workspace, input.config, {
    authorEmail: input.authorEmail,
    ownerEmail: input.ownerEmail,
    stateBackend: input.stateBackend,
  });

  const result = await generateText({
    abortSignal: input.signal,
    stopWhen: stepCountIs(MAX_TOOL_STEPS),
    system: input.systemPrompt,
    messages: buildMessages(input.messages),
    model,
    temperature: 0.2,
    tools,
  });

  return {
    gateway: input.config.activeGateway,
    model: input.config.model,
    steps: result.steps.length,
    text: result.text,
    tokenInput: result.usage?.inputTokens ?? 0,
    tokenOutput: result.usage?.outputTokens ?? 0,
    toolCalls: extractToolCalls(result.steps as Array<{ toolCalls: unknown[]; toolResults: unknown[] }>),
  };
}

/**
 * Streaming agentic chat. Used for synchronous /message endpoint.
 * Calls onTextDelta for each token chunk and onToolCall for each tool invocation.
 * Returns the full AgenticResult once the stream is consumed.
 */
export async function streamAgenticChat(input: {
  authorEmail?: string;
  config: AppConfig;
  env: Env;
  messages: Array<{ content: string; role: "assistant" | "system" | "tool" | "user" }>;
  onTextDelta: (delta: string) => void;
  onToolCall: (tc: { code: string; result: unknown }) => void;
  ownerEmail?: string;
  signal?: AbortSignal;
  stateBackend?: StateBackend;
  systemPrompt: string;
  workspace: Workspace;
}): Promise<AgenticResult> {
  const provider = buildProvider(input.config, input.env);
  const model = provider.chatModel(input.config.model);
  const tools = buildTools(input.env, input.workspace, input.config, {
    authorEmail: input.authorEmail,
    ownerEmail: input.ownerEmail,
    stateBackend: input.stateBackend,
  });

  const result = streamText({
    abortSignal: input.signal,
    stopWhen: stepCountIs(MAX_TOOL_STEPS),
    system: input.systemPrompt,
    messages: buildMessages(input.messages),
    model,
    temperature: 0.2,
    tools,
    onStepFinish: (event) => {
      const stepToolCalls = extractToolCalls([event as unknown as { toolCalls: unknown[]; toolResults: unknown[] }]);
      for (const tc of stepToolCalls) {
        input.onToolCall(tc);
      }
    },
  });

  for await (const delta of result.textStream) {
    input.onTextDelta(delta);
  }

  const [text, totalUsage, steps] = await Promise.all([result.text, result.totalUsage, result.steps]);

  return {
    gateway: input.config.activeGateway,
    model: input.config.model,
    steps: steps.length,
    text,
    tokenInput: totalUsage?.inputTokens ?? 0,
    tokenOutput: totalUsage?.outputTokens ?? 0,
    toolCalls: extractToolCalls(steps as Array<{ toolCalls: unknown[]; toolResults: unknown[] }>),
  };
}
