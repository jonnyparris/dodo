import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import type { Env } from "../src/types";
import worker from "../src/index";

const BASE_URL = "https://dodo.example";

export async function fetchJson(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, init), env as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export async function fetchWithoutWaiting(path: string, init?: RequestInit): Promise<{ ctx: ExecutionContext; response: Response }> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, init), env as Env, ctx);
  return { ctx, response };
}

export async function createSession(): Promise<string> {
  const response = await fetchJson("/session", { method: "POST" });
  if (response.status !== 201) {
    throw new Error(`Failed to create session: ${response.status} ${await response.text()}`);
  }
  return ((await response.json()) as { id: string }).id;
}

/**
 * Add a hostname to the allowlist via direct SharedIndex DO access (bypasses adminGuard).
 * Use this in tests instead of `POST /api/allowlist` which now requires admin.
 */
export async function addAllowlistHostDirect(hostname: string): Promise<void> {
  const testEnv = env as Env;
  const stub = testEnv.SHARED_INDEX.get(testEnv.SHARED_INDEX.idFromName("global"));
  const res = await stub.fetch("https://shared-index/allowlist", {
    body: JSON.stringify({ hostname }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!res.ok && res.status !== 201) {
    throw new Error(`Failed to add allowlist host ${hostname}: ${res.status}`);
  }
}

/**
 * Remove a hostname from the allowlist via direct SharedIndex DO access.
 */
export async function removeAllowlistHostDirect(hostname: string): Promise<void> {
  const testEnv = env as Env;
  const stub = testEnv.SHARED_INDEX.get(testEnv.SHARED_INDEX.idFromName("global"));
  await stub.fetch(`https://shared-index/allowlist/${encodeURIComponent(hostname)}`, { method: "DELETE" });
}

export async function eventually(assertion: () => Promise<void>, attempts = 20): Promise<void> {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}
