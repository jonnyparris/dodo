import { WorkspaceFileSystem } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import type { Workspace } from "@cloudflare/shell";
import { getUserControlStub } from "./auth";
import type { AppConfig, Env } from "./types";

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Map a git remote URL hostname to the secret key name in UserControl. */
function secretKeyForHost(host: string): string | null {
  if (host.includes("github.com")) return "github_token";
  if (host.includes("gitlab")) return "gitlab_token";
  return null;
}

/**
 * Try to fetch a token from UserControl's encrypted secrets.
 * Falls back to env vars for backward compatibility.
 */
async function fetchUserToken(secretKey: string, env: Env, ownerEmail?: string): Promise<string | undefined> {
  // Try per-user encrypted secrets first
  if (ownerEmail) {
    try {
      const stub = getUserControlStub(env, ownerEmail);
      const response = await stub.fetch(`https://user-control/internal/secret/${encodeURIComponent(secretKey)}`, {
        headers: { "x-owner-email": ownerEmail },
      });
      if (response.ok) {
        const { value } = (await response.json()) as { value: string };
        if (value) return value;
      }
    } catch {
      // Fall through to env vars
    }
  }
  return undefined;
}

function chooseTokenForUrl(url: string, env: Env): string | undefined {
  const host = hostFromUrl(url);
  if (host.includes("github.com")) return env.GITHUB_TOKEN;
  if (host.includes("gitlab")) return env.GITLAB_TOKEN;
  return undefined;
}

export function createWorkspaceGit(workspace: Workspace) {
  return createGit(new WorkspaceFileSystem(workspace));
}

export async function resolveRemoteToken(input: {
  dir?: string;
  env: Env;
  git: ReturnType<typeof createGit>;
  ownerEmail?: string;
  remote?: string;
  url?: string;
}): Promise<string | undefined> {
  const resolvedUrl = input.url ?? await resolveRemoteUrl(input.git, input.dir, input.remote);
  if (!resolvedUrl) return undefined;

  const host = hostFromUrl(resolvedUrl);
  const secretKey = secretKeyForHost(host);

  // Try per-user secret first
  if (secretKey && input.ownerEmail) {
    const userToken = await fetchUserToken(secretKey, input.env, input.ownerEmail);
    if (userToken) return userToken;
  }

  // Fall back to env vars
  return chooseTokenForUrl(resolvedUrl, input.env);
}

async function resolveRemoteUrl(git: ReturnType<typeof createGit>, dir?: string, remote?: string): Promise<string | undefined> {
  const remotes = await git.remote({ dir, list: true });
  if (!Array.isArray(remotes)) return undefined;
  const remoteName = remote ?? "origin";
  const match = remotes.find((entry: { remote: string; url: string }) => entry.remote === remoteName);
  return match?.url;
}

export function defaultAuthor(config: AppConfig) {
  return {
    email: config.gitAuthorEmail,
    name: config.gitAuthorName,
  };
}
