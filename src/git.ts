import { WorkspaceFileSystem } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import type { Workspace } from "@cloudflare/shell";
import { getUserControlStub, isAdmin } from "./auth";
import { isGitHubHost, isGitLabHost } from "./hosts";
import { log } from "./logger";
import { parseRemoteSpec } from "./repos";
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
  if (isGitHubHost(host)) return "github_token";
  if (isGitLabHost(host)) return "gitlab_token";
  return null;
}

/**
 * Try to fetch a token from UserControl's encrypted secrets.
 * Returns undefined (with a warning log) if the lookup fails.
 */
async function fetchUserToken(secretKey: string, env: Env, ownerEmail?: string): Promise<string | undefined> {
  if (!ownerEmail) {
    log("warn", "git: no ownerEmail provided, skipping per-user secret lookup", { secretKey });
    return undefined;
  }

  try {
    const stub = getUserControlStub(env, ownerEmail);
    const response = await stub.fetch(`https://user-control/internal/secret/${encodeURIComponent(secretKey)}`, {
      headers: { "x-owner-email": ownerEmail },
    });
    if (response.ok) {
      const { value } = (await response.json()) as { value: string };
      if (value) {
        log("info", "git: resolved per-user secret", { secretKey, ownerEmail });
        return value;
      }
      log("warn", "git: per-user secret exists but value is empty", { secretKey, ownerEmail });
    } else {
      const body = await response.text().catch(() => "");
      log("warn", "git: per-user secret lookup failed", { secretKey, ownerEmail, status: response.status, body: body.slice(0, 200) });
    }
  } catch (error) {
    log("error", "git: per-user secret lookup threw", { secretKey, ownerEmail, error: error instanceof Error ? error.message : String(error) });
  }

  return undefined;
}

function chooseTokenForUrl(url: string, env: Env): string | undefined {
  const host = hostFromUrl(url);
  if (isGitHubHost(host)) return env.GITHUB_TOKEN;
  if (isGitLabHost(host)) return env.GITLAB_TOKEN;
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
  const secretKey = secretKeyForHost(host);

  // Try per-user secret first
  if (secretKey && input.ownerEmail) {
    const userToken = await fetchUserToken(secretKey, input.env, input.ownerEmail);
    if (userToken) {
      log("info", "git: using per-user secret for auth", { host, secretKey });
      return userToken;
    }
  }

  // Restricted env var fallback — admin account only.
  // Mirrors the policy in src/outbound.ts to prevent non-admin tenants from
  // accidentally sending the admin's tokens to the configured provider.
  if (input.ownerEmail && isAdmin(input.ownerEmail, input.env)) {
    const envToken = chooseTokenForUrl(resolvedUrl, input.env);
    if (envToken) {
      log("info", "git: using env var fallback for auth (admin)", { host });
      return envToken;
    }
  }

  log("warn", "git: no token found — request will be unauthenticated", { host, secretKey, hasOwnerEmail: !!input.ownerEmail });
  return undefined;
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
