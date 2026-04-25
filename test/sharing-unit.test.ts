/**
 * Pure unit tests for share token utilities.
 * Extracted from sharing.test.ts to avoid importing the main worker module.
 * See: https://github.com/cloudflare/workers-sdk/issues/13191
 */
import { describe, expect, it } from "vitest";

describe("Share token utilities", () => {
  it("signCookie and verifyCookie round-trip", async () => {
    const { signCookie, verifyCookie } = await import("../src/share");
    const secret = "test-secret-key";
    const payload = JSON.stringify({ sessionId: "abc", permission: "readonly" });

    const signed = await signCookie(payload, secret);
    expect(signed).toContain(":");

    const verified = await verifyCookie(signed, secret);
    expect(verified).toBe(payload);
  });

  it("verifyCookie rejects tampered payload", async () => {
    const { signCookie, verifyCookie } = await import("../src/share");
    const secret = "test-secret-key";
    const payload = JSON.stringify({ sessionId: "abc", permission: "readonly" });

    const signed = await signCookie(payload, secret);
    const [, sig] = signed.split(":");
    const tamperedPayload = btoa(JSON.stringify({ sessionId: "abc", permission: "readwrite" }));
    const tampered = `${tamperedPayload}:${sig}`;

    const verified = await verifyCookie(tampered, secret);
    expect(verified).toBeNull();
  });

  it("verifyCookie rejects wrong secret", async () => {
    const { signCookie, verifyCookie } = await import("../src/share");
    const payload = JSON.stringify({ test: true });

    const signed = await signCookie(payload, "secret-1");
    const verified = await verifyCookie(signed, "secret-2");
    expect(verified).toBeNull();
  });

  it("generateShareToken returns 64-char hex string", async () => {
    const { generateShareToken } = await import("../src/share");
    const token = generateShareToken();
    expect(token.length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);
  });

  it("hashShareToken produces consistent hash", async () => {
    const { hashShareToken } = await import("../src/share");
    const token = "a".repeat(64);
    const secret = "test-secret-do-not-use-in-prod";
    const hash1 = await hashShareToken(token, secret);
    const hash2 = await hashShareToken(token, secret);
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(token);
  });

  it("hashShareToken throws when secret is missing", async () => {
    const { hashShareToken } = await import("../src/share");
    await expect(hashShareToken("token")).rejects.toThrow("COOKIE_SECRET");
  });
});
