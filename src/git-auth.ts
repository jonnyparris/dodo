import { getUserControlStub, isAdmin } from "./auth";
import { isGitHubHost, isGitLabHost } from "./hosts";
import { log } from "./logger";
import type { Env } from "./types";

export type GitProvider = "github" | "gitlab";

/**
 * Resolve a Git provider token. Prefers per-user encrypted secret
 * (`github_token` / `gitlab_token`), falls back to env vars
 * (`GITHUB_TOKEN` / `GITLAB_TOKEN`) for admin accounts only.
 *
 * If `host` is supplied, it is validated against `hosts.ts` predicates
 * to ensure the provider matches the host (audit finding H7).
 */
export async function resolveProviderToken(
  env: Env,
  provider: GitProvider,
  ownerEmail: string | null | undefined,
  host?: string,
): Promise<string | undefined> {
  // Validate host if supplied.
  if (host) {
    const isValidProvider =
      (provider === "github" && isGitHubHost(host)) ||
      (provider === "gitlab" && isGitLabHost(host));
    if (!isValidProvider) {
      log("warn", "git-auth: host does not match provider", { host, provider });
      return undefined;
    }
  }

  const secretKey = provider === "github" ? "github_token" : "gitlab_token";

  // Try per-user encrypted secret first.
  if (ownerEmail) {
    try {
      const stub = getUserControlStub(env, ownerEmail);
      const response = await stub.fetch(
        `https://user-control/internal/secret/${encodeURIComponent(secretKey)}`,
        { headers: { "x-owner-email": ownerEmail } },
      );
      if (response.ok) {
        const { value } = (await response.json()) as { value: string };
        if (value) return value;
      }
    } catch {
      // Fall through to env
    }
  }

  // Restricted env var fallback — admin account only. Mirrors the policy in
  // src/outbound.ts so non-admin tenants can't accidentally use the admin's
  // provider tokens.
  if (ownerEmail && isAdmin(ownerEmail, env)) {
    const envToken = provider === "github" ? env.GITHUB_TOKEN : env.GITLAB_TOKEN;
    if (envToken) return envToken;
  }

  log("warn", "git-auth: no token available for provider", { provider, hasOwnerEmail: !!ownerEmail });
  return undefined;
}
