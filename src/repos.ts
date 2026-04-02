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

export function isKnownRepoId(value: string): value is KnownRepoId {
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

export function parseRemoteSpec(url: string): ParsedRemoteSpec | null {
  const normalized = url.trim();
  const httpsMatch = normalized.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (httpsMatch) {
    const host = httpsMatch[1].toLowerCase();
    const owner = httpsMatch[2];
    const repo = httpsMatch[3];
    if (host.includes("github.com")) {
      return { fullName: `${owner}/${repo}`, host, owner, provider: "github", repo };
    }
    if (host.includes("gitlab")) {
      return { fullName: `${owner}/${repo}`, host, owner, provider: "gitlab", repo };
    }
    return null;
  }

  const sshMatch = normalized.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    const host = sshMatch[1].toLowerCase();
    const owner = sshMatch[2];
    const repo = sshMatch[3];
    if (host.includes("github.com")) {
      return { fullName: `${owner}/${repo}`, host, owner, provider: "github", repo };
    }
    if (host.includes("gitlab")) {
      return { fullName: `${owner}/${repo}`, host, owner, provider: "gitlab", repo };
    }
  }

  return null;
}
