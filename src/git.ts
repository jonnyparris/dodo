import { WorkspaceFileSystem } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import type { Workspace } from "@cloudflare/shell";
import type { AppConfig, Env } from "./types";

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function chooseTokenForUrl(url: string, env: Env): string | undefined {
  const host = hostFromUrl(url);
  if (host.includes("github.com")) {
    return env.GITHUB_TOKEN;
  }
  if (host.includes("gitlab")) {
    return env.GITLAB_TOKEN;
  }
  return undefined;
}

export function createWorkspaceGit(workspace: Workspace) {
  return createGit(new WorkspaceFileSystem(workspace));
}

export async function resolveRemoteToken(input: {
  dir?: string;
  env: Env;
  git: ReturnType<typeof createGit>;
  remote?: string;
  url?: string;
}): Promise<string | undefined> {
  if (input.url) {
    return chooseTokenForUrl(input.url, input.env);
  }

  const remotes = await input.git.remote({ dir: input.dir, list: true });
  if (!Array.isArray(remotes)) {
    return undefined;
  }
  const remoteName = input.remote ?? "origin";
  const match = remotes.find((entry: { remote: string; url: string }) => entry.remote === remoteName);
  return match ? chooseTokenForUrl(match.url, input.env) : undefined;
}

export function defaultAuthor(config: AppConfig) {
  return {
    email: config.gitAuthorEmail,
    name: config.gitAuthorName,
  };
}
