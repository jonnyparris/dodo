import { isGitHubHost, isGitLabHost } from "./hosts";

export type KnownRepoId = "dodo";

export interface KnownRepo {
  defaultBranch: string;
  dir: string;
  id: KnownRepoId;
  name: string;
  url: string;
}

const KNOWN_REPOS: Record<KnownRepoId, KnownRepo> = {
  dodo: {
    defaultBranch: "main",
    dir: "/dodo",
    id: "dodo",
    name: "Dodo",
    url: "https://github.com/jonnyparris/dodo",
  },
};

export function listKnownRepos(): KnownRepo[] {
  return Object.values(KNOWN_REPOS);
}

function isKnownRepoId(value: string): value is KnownRepoId {
  return Object.prototype.hasOwnProperty.call(KNOWN_REPOS, value);
}

export function getKnownRepo(repoId: string): KnownRepo {
  if (!isKnownRepoId(repoId)) {
    throw new Error(`Unknown repo id '${repoId}'. Run list_known_repos to see valid options.`);
  }
  return KNOWN_REPOS[repoId];
}

export interface ParsedRemoteSpec {
  fullName: string;
  host: string;
  owner: string;
  provider: "github" | "gitlab";
  repo: string;
}

/**
 * Classify a hostname using exact + subdomain matching against the same
 * known-host sets used by the auth/outbound layer. Substring matching (e.g.
 * `host.includes("github.com")`) would treat hostile hostnames like
 * `github.com.attacker.example` as GitHub and could leak tokens; we avoid
 * that here by reusing the strict checks from src/git.ts.
 */
function classifyHost(host: string): "github" | "gitlab" | null {
  if (isGitHubHost(host)) return "github";
  if (isGitLabHost(host)) return "gitlab";
  return null;
}

export function parseRemoteSpec(url: string): ParsedRemoteSpec | null {
  const normalized = url.trim();
  const httpsMatch = normalized.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (httpsMatch) {
    const host = httpsMatch[1].toLowerCase();
    const owner = httpsMatch[2];
    const repo = httpsMatch[3];
    const provider = classifyHost(host);
    if (provider) {
      return { fullName: `${owner}/${repo}`, host, owner, provider, repo };
    }
    return null;
  }

  const sshMatch = normalized.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    const host = sshMatch[1].toLowerCase();
    const owner = sshMatch[2];
    const repo = sshMatch[3];
    const provider = classifyHost(host);
    if (provider) {
      return { fullName: `${owner}/${repo}`, host, owner, provider, repo };
    }
  }

  return null;
}
