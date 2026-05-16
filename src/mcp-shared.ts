import { canonicalizeEmail, resolveAdminEmail } from "./auth";
import type { Env } from "./types";

/**
 * Resolve the MCP caller's email. Prefers an explicit userEmail (from a
 * user-scoped dodo_* token validated upstream), falls back to ADMIN_EMAIL
 * for service-mode callers using the shared DODO_MCP_TOKEN.
 *
 * When the fallback is taken we log a warning so operators can audit
 * operations that get attributed to the admin. In production, review the
 * log stream periodically to confirm the expected service-mode callers
 * (CI etc.) are the only ones hitting this path.
 */
export function mcpUserEmail(env: Env, userEmail?: string, label = "mcp"): string {
  const canonical = canonicalizeEmail(userEmail ?? null);
  if (canonical) return canonical;
  const email = resolveAdminEmail(env);
  if (!email) throw new Error("ADMIN_EMAIL must be configured for MCP access. Set it as a secret or in wrangler.jsonc vars.");
  console.warn(`[${label}] Operation attributed to admin via service-mode fallback (no userEmail threaded).`);
  return email;
}

export function errorResult(data: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: true };
}

export function propagateMcpDepth(headers: Headers, depth: number): void {
  headers.set("x-dodo-mcp-depth", String(depth + 1));
}
