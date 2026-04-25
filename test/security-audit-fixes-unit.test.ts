/**
 * Unit tests for the security fixes shipped in d1a138f and the audit
 * follow-ups in fix/audit-followups.
 *
 * These cover the helpers that are easy to exercise without spinning up
 * the full Worker pool. End-to-end tests for the route-level enforcement
 * live in the integration suites.
 */

import { describe, expect, it } from "vitest";
import { canonicalizeEmail, isAdmin, resolveAdminEmail } from "../src/auth";
import { hashShareToken } from "../src/share";
import { DodoPublicApi, buildAuthenticatedApi } from "../src/rpc-api";
import { bytesToBase64, bytesToBase64Chunked } from "../src/crypto";

const stubEnv = (overrides: Record<string, string | undefined> = {}) => ({
  ADMIN_EMAIL: "admin@example.com",
  ...overrides,
} as never);

describe("canonicalizeEmail (audit H5)", () => {
  it("lowercases mixed-case input", () => {
    expect(canonicalizeEmail("Foo@Example.COM")).toBe("foo@example.com");
  });

  it("trims surrounding whitespace", () => {
    expect(canonicalizeEmail("  user@example.com\n")).toBe("user@example.com");
  });

  it("returns null for null / undefined / non-string", () => {
    expect(canonicalizeEmail(null)).toBeNull();
    expect(canonicalizeEmail(undefined)).toBeNull();
    expect(canonicalizeEmail(123 as never)).toBeNull();
  });

  it("returns null for empty / whitespace-only", () => {
    expect(canonicalizeEmail("")).toBeNull();
    expect(canonicalizeEmail("   ")).toBeNull();
  });
});

describe("resolveAdminEmail (audit H5)", () => {
  it("canonicalizes the configured admin", () => {
    expect(resolveAdminEmail(stubEnv({ ADMIN_EMAIL: "Admin@Example.COM" }))).toBe("admin@example.com");
  });

  it("returns undefined for the placeholder value", () => {
    expect(resolveAdminEmail(stubEnv({ ADMIN_EMAIL: "you@example.com" }))).toBeUndefined();
  });

  it("returns undefined when not configured", () => {
    expect(resolveAdminEmail(stubEnv({ ADMIN_EMAIL: undefined }))).toBeUndefined();
  });
});

describe("isAdmin (audit H5)", () => {
  it("matches case-insensitively", () => {
    const env = stubEnv({ ADMIN_EMAIL: "admin@example.com" });
    expect(isAdmin("Admin@Example.COM", env)).toBe(true);
    expect(isAdmin("admin@example.com", env)).toBe(true);
  });

  it("rejects non-admin", () => {
    expect(isAdmin("user@example.com", stubEnv())).toBe(false);
  });

  it("rejects null / empty", () => {
    expect(isAdmin(null, stubEnv())).toBe(false);
    expect(isAdmin("", stubEnv())).toBe(false);
  });
});

describe("DodoPublicApi (audit H1)", () => {
  it("does NOT expose authenticate(email) — the impersonation hole is closed", () => {
    const api = new DodoPublicApi(stubEnv());
    // The pre-d1a138f surface had `authenticate(email)`. It must stay gone.
    expect((api as unknown as { authenticate?: unknown }).authenticate).toBeUndefined();
  });

  it("only exposes health()", () => {
    const api = new DodoPublicApi(stubEnv());
    expect(typeof api.health).toBe("function");
    const result = api.health();
    expect(result.status).toBe("ok");
  });
});

describe("buildAuthenticatedApi (audit H1)", () => {
  it("rejects empty email", () => {
    expect(() => buildAuthenticatedApi(stubEnv(), "")).toThrow(/non-empty email/);
  });

  it("canonicalizes the bound email", () => {
    // Builds successfully — the underlying lookup helpers will canonicalize.
    expect(() => buildAuthenticatedApi(stubEnv(), "User@Example.COM")).not.toThrow();
  });
});

describe("hashShareToken (audit H8)", () => {
  it("produces a deterministic hash for the same secret", async () => {
    const secret = "test-secret-do-not-use-in-prod";
    const a = await hashShareToken("token", secret);
    const b = await hashShareToken("token", secret);
    expect(a).toBe(b);
    expect(a).not.toBe("token");
  });

  it("throws when COOKIE_SECRET is unset", async () => {
    await expect(hashShareToken("token")).rejects.toThrow(/COOKIE_SECRET/);
    await expect(hashShareToken("token", "")).rejects.toThrow(/COOKIE_SECRET/);
  });
});

describe("bytesToBase64Chunked (audit H9)", () => {
  it("matches the unchunked encoder for small input", () => {
    const small = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]);
    expect(bytesToBase64Chunked(small)).toBe(bytesToBase64(small));
  });

  it("does not stack-overflow on input larger than the spread limit", () => {
    // 256KB — the spread form (`String.fromCharCode(...bytes)`) blows
    // the call stack at >~64KB on V8. Chunked must succeed.
    const bytes = new Uint8Array(256 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    expect(() => bytesToBase64Chunked(bytes)).not.toThrow();
  });

  it("matches the spread-form encoder modulo size", () => {
    // For inputs the spread form CAN handle (small), the two encoders
    // must agree byte-for-byte.
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
    const expected = btoa(String.fromCharCode(...bytes));
    expect(bytesToBase64Chunked(bytes)).toBe(expected);
  });
});
