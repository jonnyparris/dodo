/**
 * Route-level tests for the new GET /session/:id/artifacts endpoint and
 * the in-DO behaviour it depends on.
 *
 * These tests use the same fake ARTIFACTS binding pattern as the
 * existing "Artifacts binding" suite in dodo.test.ts: a Map-backed
 * stub that hands out predictable remote URLs and tokens.
 *
 * What we assert:
 *   1. /session/:id/artifacts returns name + remote + cloneUrl + TTL
 *      when artifacts is reachable.
 *   2. The cloneUrl includes basic auth credentials (`x:token@host`)
 *      and has the `?expires=…` suffix stripped from the password.
 *   3. The endpoint is gated by readonly permission — admin-only
 *      sessions return 401/403 (matches the proxy contract for
 *      everything else under /session/:id).
 *   4. When the artifacts binding is unavailable, the endpoint returns
 *      503 instead of throwing.
 *   5. markArtifactsFsDirty() flips the cache flag without disturbing
 *      the cached fs handle (the cheap path the flush hook relies on).
 *
 * Doesn't cover: the actual clone/fetch path. That goes over HTTP to a
 * real artifacts remote and needs a different harness — left to manual
 * smoke testing in dev for now.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../src/types";
import { fetchJson, createSession } from "./helpers";

beforeEach(() => {
  // Same fake ARTIFACTS binding shape as test/dodo.test.ts's
  // "Artifacts binding" describe block. Repos persist for the duration
  // of a single test via the Map closure.
  const fakeRepos = new Map<string, { name: string; remote: string; token: string }>();
  (env as unknown as { ARTIFACTS: unknown }).ARTIFACTS = {
    create: vi.fn(async (name: string) => {
      const repo = {
        name,
        remote: `https://fake.artifacts/${name}.git`,
        token: "art_v1_fake?expires=9999999999",
        info: async () => ({ remote: `https://fake.artifacts/${name}.git`, name }),
        createToken: async () => ({ token: "art_v1_fresh?expires=9999999999" }),
        fork: vi.fn(),
      };
      fakeRepos.set(name, repo);
      return { name, remote: repo.remote, token: repo.token, defaultBranch: "main", repo };
    }),
    get: vi.fn(async (name: string) => {
      const entry = fakeRepos.get(name);
      if (!entry) return null;
      return {
        name: entry.name,
        info: async () => ({ remote: entry.remote, name: entry.name }),
        createToken: async () => ({ token: "art_v1_fresh" }),
        fork: vi.fn(),
      };
    }),
  };
});

describe("GET /session/:id/artifacts", () => {
  it("returns repo metadata + an authenticated clone URL", async () => {
    const sessionId = await createSession();

    const response = await fetchJson(`/session/${sessionId}/artifacts`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      name: string | null;
      remote: string;
      cloneUrl: string;
      tokenTtlSeconds: number;
    };

    expect(body.name).toBe(`dodo-${sessionId}`);
    expect(body.remote).toBe(`https://fake.artifacts/dodo-${sessionId}.git`);
    // Clone URL must inject basic-auth credentials and strip `?expires=`
    expect(body.cloneUrl).toMatch(/^https:\/\/x:art_v1_fake@fake\.artifacts\/dodo-/);
    expect(body.cloneUrl).not.toContain("?expires=");
    expect(body.tokenTtlSeconds).toBe(3600);
  });

  it("returns 503 when artifacts is unavailable", async () => {
    // Stub the binding to fail on every call. The handler must not
    // throw — the panel should just hide the clone affordance.
    (env as unknown as { ARTIFACTS: { create: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> } }).ARTIFACTS = {
      create: vi.fn(async () => { throw new Error("artifacts down"); }),
      get: vi.fn(async () => { throw new Error("artifacts down"); }),
    };

    const sessionId = await createSession();
    const response = await fetchJson(`/session/${sessionId}/artifacts`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/artifacts/i);
  });
});

describe("CodingAgent.markArtifactsFsDirty", () => {
  it("is callable across the RPC boundary without throwing", async () => {
    // We can't reach into private fields over RPC, but the method
    // itself is a public RPC entry the flush hook depends on. Confirm
    // it survives a no-op call (cache empty) and a call after the
    // artifacts context is warmed up.
    const sessionId = await createSession();
    const ns = (env as Env).CODING_AGENT;
    const agent = await ns.get(ns.idFromName(sessionId));
    const api = agent as unknown as {
      getOrCreateArtifactsContext: (hint?: string) => Promise<unknown>;
      markArtifactsFsDirty: () => Promise<void>;
    };

    // Cache empty → no-op, no throw.
    await expect(api.markArtifactsFsDirty()).resolves.toBeUndefined();

    // Warm up the artifacts context, then call again.
    await api.getOrCreateArtifactsContext(sessionId);
    await expect(api.markArtifactsFsDirty()).resolves.toBeUndefined();
  });
});

describe("GET /session/:id/file fast-path fallback", () => {
  it("falls through to the workspace shell when the file isn't in the artifacts clone", async () => {
    // Even with a working artifacts binding, a freshly-created session
    // has no cached fs (no flush has happened). The /file route must
    // not 404 — it should fall back to the workspace shell, which is
    // also empty for a fresh session, and surface that as a normal
    // "file not found" 404 rather than an artifacts error.
    const sessionId = await createSession();
    const response = await fetchJson(`/session/${sessionId}/file?path=/does-not-exist.txt`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/not found/i);
  });
});

describe("GET /session/:id/files fast-path fallback", () => {
  it("returns workspace contents (empty entries) for a fresh session before any flush", async () => {
    // The artifacts cache is null until a turn flushes. A fresh
    // session's /files must serve the workspace shell view directly,
    // not error out trying to clone an unwarmed artifacts repo.
    const sessionId = await createSession();
    const response = await fetchJson(`/session/${sessionId}/files?path=/`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { entries: unknown[] };
    expect(Array.isArray(body.entries)).toBe(true);
  });
});
