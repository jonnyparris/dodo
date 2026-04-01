import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { StateBackend } from "@cloudflare/shell";
import { jsonSchema, tool, zodSchema } from "ai";
import { z } from "zod";
import type { Workspace } from "@cloudflare/shell";
import { createWorkspaceGit, defaultAuthor, resolveRemoteToken } from "./git";
import type { McpGatekeeper, McpToolInfo } from "./mcp-gatekeeper";
import { createWorkspaceTools, createExecuteTool } from "./think-adapter";
import type { AppConfig, Env } from "./types";

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
      description: "Clone a git repo into the workspace. Auth is automatic for GitHub/GitLab. Clones are shallow (depth 1) by default. Pass depth 0 for full history.",
      inputSchema: zodSchema(z.object({
        url: z.string().describe("Git repo URL (e.g. https://github.com/owner/repo)"),
        dir: z.string().optional().describe("Target directory (default: repo name)"),
        branch: z.string().optional().describe("Branch to clone"),
        depth: z.number().optional().describe("Clone depth. Default: 1 (shallow). Use 0 for full history."),
      })),
      execute: async ({ url, dir, branch, depth }) => {
        const token = await resolveRemoteToken({ dir, env, git, url, ownerEmail });
        // depth 0 = full history (pass undefined to isomorphic-git), undefined = shallow default of 1
        const cloneDepth = depth === 0 ? undefined : (depth ?? 1);
        return git.clone({ branch, depth: cloneDepth, dir, singleBranch: true, token, url });
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
 * If mcpGatekeepers are provided, their tools are merged into the set.
 */
export function buildToolsForThink(
  env: Env,
  workspace: Workspace,
  config: AppConfig,
  options?: { authorEmail?: string; ownerEmail?: string; stateBackend?: StateBackend; mcpGatekeepers?: McpGatekeeper[] },
): Record<string, AnyTool> {
  const tools = buildTools(env, workspace, config, options);

  if (options?.mcpGatekeepers?.length) {
    const mcpTools = buildMcpTools(options.mcpGatekeepers);
    Object.assign(tools, mcpTools);
  }

  return tools;
}

/**
 * Convert connected MCP gatekeeper tools into AI SDK tool() objects.
 *
 * Each gatekeeper's tools are already namespaced (e.g. "agent-memory__read")
 * by the gatekeeper's listTools(). We use jsonSchema() passthrough for the
 * input schema since MCP tools define JSON Schema directly, not Zod.
 */
function buildMcpTools(gatekeepers: McpGatekeeper[]): Record<string, AnyTool> {
  const tools: Record<string, AnyTool> = {};

  for (const gk of gatekeepers) {
    // listTools() returns cached results after initial connect — synchronous-safe
    // if the gatekeeper has already been connected and tools listed.
    const cachedTools = gk.getCachedTools();
    if (!cachedTools) continue;

    for (const mcpTool of cachedTools) {
      tools[mcpTool.name] = tool({
        description: mcpTool.description ?? `MCP tool: ${mcpTool.name}`,
        inputSchema: mcpTool.inputSchema
          ? jsonSchema(mcpTool.inputSchema as Record<string, unknown>)
          : jsonSchema({ type: "object", properties: {} }),
        execute: async (args: unknown) => {
          const result = await gk.callTool(mcpTool.name, args);
          if (result.isError) {
            const errText = result.content.map((c) => c.text ?? "").join("\n");
            return { error: errText || "MCP tool call failed" };
          }
          // Return text content joined — the LLM can parse it
          return result.content
            .map((c) => c.text ?? "")
            .filter(Boolean)
            .join("\n");
        },
      });
    }
  }

  return tools;
}

/**
 * Check if the caller is the session owner (i.e. should have access to memory tools).
 */
export function isCallerOwner(authorEmail?: string, ownerEmail?: string): boolean {
  if (!authorEmail || !ownerEmail) return true;
  return authorEmail === ownerEmail;
}
