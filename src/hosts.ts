/**
 * Provider host classification used by anything that handles auth tokens
 * (git pushes, PR/MR creation, sandboxed outbound). Substring matching
 * (e.g. `host.includes("github.com")`) would treat hostile hostnames like
 * `github.com.attacker.example` as GitHub and could ship a user's token
 * to the attacker — we use exact + subdomain matching here. (audit
 * finding H7)
 *
 * Kept in its own module so both `git.ts` and `repos.ts` can import it
 * without creating a circular dependency. `outbound.ts` keeps its own
 * copy because it runs in a different worker entrypoint context, but the
 * sets must stay in sync.
 */

const GITHUB_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
]);

const GITLAB_HOSTS = new Set([
  "gitlab.com",
  "gitlab.cfdata.org",
]);

export function isGitHubHost(host: string): boolean {
  if (GITHUB_HOSTS.has(host)) return true;
  for (const known of GITHUB_HOSTS) {
    if (host.endsWith(`.${known}`)) return true;
  }
  return false;
}

export function isGitLabHost(host: string): boolean {
  if (GITLAB_HOSTS.has(host)) return true;
  for (const known of GITLAB_HOSTS) {
    if (host.endsWith(`.${known}`)) return true;
  }
  return false;
}
