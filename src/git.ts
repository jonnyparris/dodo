import { WorkspaceFileSystem } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import type { Workspace } from "@cloudflare/shell";
import { isGitHubHost, isGitLabHost } from "./hosts";
import { log } from "./logger";
import { parseRemoteSpec } from "./repos";
import { resolveProviderToken } from "./git-auth";
import type { AppConfig, Env } from "./types";

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function providerForHost(host: string): "github" | "gitlab" | undefined {
  if (isGitHubHost(host)) return "github";
  if (isGitLabHost(host)) return "gitlab";
  return undefined;
}

interface RemoteBranchVerification {
  aheadBy: number;
  baseRef: string;
  branch: string;
  changedFiles: string[];
  compareUrl?: string;
  error?: string;
  ok: boolean;
  provider?: "github" | "gitlab";
  remoteUrl?: string;
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
  if (!resolvedUrl) {
    log("warn", "git: no remote URL resolved, cannot look up token", { dir: input.dir, remote: input.remote });
    return undefined;
  }

  const host = hostFromUrl(resolvedUrl);
  const provider = providerForHost(host);
  if (!provider) {
    log("warn", "git: unsupported host for token resolution", { host });
    return undefined;
  }

  const token = await resolveProviderToken(input.env, provider, input.ownerEmail, host);
  if (!token) {
    log("warn", "git: no token found — request will be unauthenticated", { host, provider, hasOwnerEmail: !!input.ownerEmail });
  }
  return token;
}

async function resolveRemoteUrl(git: ReturnType<typeof createGit>, dir?: string, remote?: string): Promise<string | undefined> {
  const remotes = await git.remote({ dir, list: true });
  if (!Array.isArray(remotes)) return undefined;
  const remoteName = remote ?? "origin";
  const match = remotes.find((entry: { remote: string; url: string }) => entry.remote === remoteName);
  return match?.url;
}

async function verifyGitHubBranch(input: {
  baseRef: string;
  expectedFiles?: string[];
  parsed: NonNullable<ReturnType<typeof parseRemoteSpec>>;
  ref: string;
  remoteUrl: string;
  token?: string;
}): Promise<RemoteBranchVerification> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "dodo-agent",
  };
  if (input.token) {
    headers.Authorization = `Bearer ${input.token}`;
  }
  const compareUrl = `https://api.github.com/repos/${encodeURIComponent(input.parsed.owner)}/${encodeURIComponent(input.parsed.repo)}/compare/${encodeURIComponent(input.baseRef)}...${encodeURIComponent(input.ref)}`;
  const response = await fetch(compareUrl, { headers });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      aheadBy: 0,
      baseRef: input.baseRef,
      branch: input.ref,
      changedFiles: [],
      compareUrl,
      error: `GitHub compare failed (${response.status}): ${text.slice(0, 200)}`,
      ok: false,
      provider: "github",
      remoteUrl: input.remoteUrl,
    };
  }
  const data = await response.json() as { ahead_by?: number; files?: Array<{ filename?: string }>; status?: string };
  const changedFiles = (data.files ?? [])
    .map((file) => file.filename ?? "")
    .filter(Boolean)
    .sort();
  const missingFiles = (input.expectedFiles ?? []).filter((file) => !changedFiles.includes(file));
  const aheadBy = Number(data.ahead_by ?? 0);
  return {
    aheadBy,
    baseRef: input.baseRef,
    branch: input.ref,
    changedFiles,
    compareUrl,
    error: missingFiles.length > 0
      ? `Branch is missing expected changed files: ${missingFiles.join(", ")}`
      : aheadBy <= 0
        ? `Branch '${input.ref}' has no commits ahead of '${input.baseRef}'`
        : undefined,
    ok: aheadBy > 0 && missingFiles.length === 0,
    provider: "github",
    remoteUrl: input.remoteUrl,
  };
}

async function verifyGitLabBranch(input: {
  baseRef: string;
  expectedFiles?: string[];
  parsed: NonNullable<ReturnType<typeof parseRemoteSpec>>;
  ref: string;
  remoteUrl: string;
  token?: string;
}): Promise<RemoteBranchVerification> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (input.token) {
    headers["PRIVATE-TOKEN"] = input.token;
  }
  const project = encodeURIComponent(input.parsed.fullName);
  const compareUrl = `https://${input.parsed.host}/api/v4/projects/${project}/repository/compare?from=${encodeURIComponent(input.baseRef)}&to=${encodeURIComponent(input.ref)}`;
  const response = await fetch(compareUrl, { headers });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      aheadBy: 0,
      baseRef: input.baseRef,
      branch: input.ref,
      changedFiles: [],
      compareUrl,
      error: `GitLab compare failed (${response.status}): ${text.slice(0, 200)}`,
      ok: false,
      provider: "gitlab",
      remoteUrl: input.remoteUrl,
    };
  }
  const data = await response.json() as { commits?: Array<unknown>; diffs?: Array<{ new_path?: string; old_path?: string }> };
  const changedFiles = (data.diffs ?? [])
    .map((diff) => diff.new_path ?? diff.old_path ?? "")
    .filter(Boolean)
    .sort();
  const missingFiles = (input.expectedFiles ?? []).filter((file) => !changedFiles.includes(file));
  const aheadBy = Array.isArray(data.commits) ? data.commits.length : 0;
  return {
    aheadBy,
    baseRef: input.baseRef,
    branch: input.ref,
    changedFiles,
    compareUrl,
    error: missingFiles.length > 0
      ? `Branch is missing expected changed files: ${missingFiles.join(", ")}`
      : aheadBy <= 0
        ? `Branch '${input.ref}' has no commits ahead of '${input.baseRef}'`
        : undefined,
    ok: aheadBy > 0 && missingFiles.length === 0,
    provider: "gitlab",
    remoteUrl: input.remoteUrl,
  };
}

export async function verifyRemoteBranch(input: {
  baseRef?: string;
  dir?: string;
  env: Env;
  expectedFiles?: string[];
  git: ReturnType<typeof createGit>;
  ownerEmail?: string;
  ref: string;
  remote?: string;
}): Promise<RemoteBranchVerification> {
  const baseRef = input.baseRef ?? "main";
  const remoteUrl = await resolveRemoteUrl(input.git, input.dir, input.remote);
  if (!remoteUrl) {
    return {
      aheadBy: 0,
      baseRef,
      branch: input.ref,
      changedFiles: [],
      error: "No remote URL configured",
      ok: false,
    };
  }

  const parsed = parseRemoteSpec(remoteUrl);
  if (!parsed) {
    return {
      aheadBy: 0,
      baseRef,
      branch: input.ref,
      changedFiles: [],
      error: `Unsupported remote URL '${remoteUrl}' for branch verification`,
      ok: false,
      remoteUrl,
    };
  }

  const token = await resolveRemoteToken({
    dir: input.dir,
    env: input.env,
    git: input.git,
    ownerEmail: input.ownerEmail,
    remote: input.remote,
    url: remoteUrl,
  });

  if (parsed.provider === "github") {
    return verifyGitHubBranch({
      baseRef,
      expectedFiles: input.expectedFiles,
      parsed,
      ref: input.ref,
      remoteUrl,
      token,
    });
  }

  return verifyGitLabBranch({
    baseRef,
    expectedFiles: input.expectedFiles,
    parsed,
    ref: input.ref,
    remoteUrl,
    token,
  });
}

/**
 * Build the git commit author identity.
 *
 * Prefers an explicit `authorOverride` (typically the request's
 * `x-author-email` so guests on a shared session commit as themselves
 * rather than as the session owner). Falls back to the session config
 * when no override is supplied. (audit finding M10)
 */
export function defaultAuthor(config: AppConfig, authorOverride?: string | null) {
  const trimmed = typeof authorOverride === "string" ? authorOverride.trim() : "";
  return {
    email: trimmed || config.gitAuthorEmail,
    name: config.gitAuthorName,
  };
}
