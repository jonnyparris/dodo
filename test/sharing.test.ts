import { beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env } from "../src/types";

// Mock modules that depend on unavailable packages in the test runtime
vi.mock("../src/executor", () => ({
  runSandboxedCode: vi.fn().mockResolvedValue({ logs: [], result: null }),
}));
vi.mock("../src/agentic", async () => await import("./helpers/agentic-mock"));
vi.mock("../src/notify", () => ({
  sendNotification: vi.fn(),
}));

import worker from "../src/index";

const BASE_URL = "https://dodo.example";

async function fetchJson(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, init), env as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function createSession(): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetchJson("/session", { method: "POST" });
    if (response.status === 201) {
      return ((await response.json()) as { id: string }).id;
    }
    if (response.status === 500 && attempt < 2) {
      await new Promise(r => setTimeout(r, 10));
      continue;
    }
    throw new Error(`Failed to create session: ${response.status}`);
  }
  throw new Error("Failed to create session after retries");
}

describe("Sharing & Permissions", () => {
  // Warm up: absorb any DO invalidation from module changes between test files
  beforeAll(async () => {
    for (let i = 0; i < 5; i++) {
      try {
        await fetchJson("/health");
        break;
      } catch {
        await new Promise(r => setTimeout(r, 10));
      }
    }
  });

  describe("Share links", () => {
    let sessionId: string;
    let shareToken: string;
    let shareId: string;

    beforeAll(async () => {
      // Create session with retries to absorb any remaining invalidation
      for (let i = 0; i < 5; i++) {
        try {
          sessionId = await createSession();
          if (sessionId) break;
        } catch { /* retry */ }
      }
    });

    it("create share link for owned session returns token + hash", async () => {
      const res = await fetchJson(`/session/${sessionId}/share`, {
        body: JSON.stringify({ permission: "readonly", label: "test-share" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; token: string; permission: string; sessionId: string };
      expect(body.token).toBeTruthy();
      expect(body.token.length).toBe(64); // 32 bytes hex
      expect(body.id).toBeTruthy();
      expect(body.id).not.toBe(body.token); // hash != plaintext
      expect(body.permission).toBe("readonly");
      expect(body.sessionId).toBe(sessionId);

      shareToken = body.token;
      shareId = body.id;
    });

    it("list shares for session includes created share", async () => {
      const res = await fetchJson(`/session/${sessionId}/shares`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { shares: Array<{ id: string; sessionId: string; permission: string; label: string | null }> };
      expect(body.shares.length).toBeGreaterThanOrEqual(1);
      const share = body.shares.find((s) => s.id === shareId);
      expect(share).toBeTruthy();
      expect(share!.permission).toBe("readonly");
      expect(share!.label).toBe("test-share");
      expect(share!.sessionId).toBe(sessionId);
    });

    it("verify share token redirects to session with correct sessionId", async () => {
      // The /shared/:token route mints a cookie and redirects to the app
      const res = await fetchJson(`/shared/${shareToken}`);
      expect(res.status).toBe(302);
      const location = res.headers.get("location");
      expect(location).toBe(`/#session=${sessionId}`);
    });

    it("verify sets a signed cookie on redirect", async () => {
      const res = await fetchJson(`/shared/${shareToken}`);
      expect(res.status).toBe(302);
      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain("dodo_share=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("Secure");
    });

    it("revoke share then verify returns invalid", async () => {
      // Revoke
      const revokeRes = await fetchJson(`/session/${sessionId}/share/${shareId}`, { method: "DELETE" });
      expect(revokeRes.status).toBe(200);
      const revokeBody = (await revokeRes.json()) as { revoked: boolean };
      expect(revokeBody.revoked).toBe(true);

      // Verify — should fail
      const verifyRes = await fetchJson(`/shared/${shareToken}`);
      expect(verifyRes.status).toBe(403);
      const verifyBody = (await verifyRes.json()) as { error: string };
      expect(verifyBody.error).toContain("Invalid");
    });

    it("share with expired date returns invalid on verify", async () => {
      // Create share with already-expired date
      const createRes = await fetchJson(`/session/${sessionId}/share`, {
        body: JSON.stringify({
          permission: "readonly",
          expiresAt: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { token: string };

      // Verify — should fail because expired
      const verifyRes = await fetchJson(`/shared/${created.token}`);
      expect(verifyRes.status).toBe(403);
    });

    it("invalid token returns 403", async () => {
      const res = await fetchJson("/shared/0000000000000000000000000000000000000000000000000000000000000000");
      expect(res.status).toBe(403);
    });
  });

  describe("Session permissions", () => {
    let sessionId: string;

    beforeAll(async () => {
      sessionId = await createSession();
    });

    it("grant permission to a grantee", async () => {
      const res = await fetchJson(`/session/${sessionId}/permissions`, {
        body: JSON.stringify({ granteeEmail: "collaborator@test.local", permission: "readwrite" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { granted: boolean; granteeEmail: string; permission: string };
      expect(body.granted).toBe(true);
      expect(body.granteeEmail).toBe("collaborator@test.local");
      expect(body.permission).toBe("readwrite");
    });

    it("list permissions for session includes granted permission", async () => {
      const res = await fetchJson(`/session/${sessionId}/permissions`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { permissions: Array<{ granteeEmail: string; permission: string; sessionId: string }> };
      expect(body.permissions.length).toBeGreaterThanOrEqual(1);
      const perm = body.permissions.find((p) => p.granteeEmail === "collaborator@test.local");
      expect(perm).toBeTruthy();
      expect(perm!.permission).toBe("readwrite");
      expect(perm!.sessionId).toBe(sessionId);
    });

    it("revoke permission", async () => {
      const res = await fetchJson(`/session/${sessionId}/permissions/${encodeURIComponent("collaborator@test.local")}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { revoked: boolean };
      expect(body.revoked).toBe(true);

      // Verify permission is gone
      const listRes = await fetchJson(`/session/${sessionId}/permissions`);
      const listBody = (await listRes.json()) as { permissions: Array<{ granteeEmail: string }> };
      const perm = listBody.permissions.find((p) => p.granteeEmail === "collaborator@test.local");
      expect(perm).toBeUndefined();
    });

    it("grant then update permission (upsert)", async () => {
      // Grant readonly
      await fetchJson(`/session/${sessionId}/permissions`, {
        body: JSON.stringify({ granteeEmail: "upsert@test.local", permission: "readonly" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      // Update to readwrite
      const res = await fetchJson(`/session/${sessionId}/permissions`, {
        body: JSON.stringify({ granteeEmail: "upsert@test.local", permission: "readwrite" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(res.status).toBe(201);

      // Verify updated
      const listRes = await fetchJson(`/session/${sessionId}/permissions`);
      const listBody = (await listRes.json()) as { permissions: Array<{ granteeEmail: string; permission: string }> };
      const perm = listBody.permissions.find((p) => p.granteeEmail === "upsert@test.local");
      expect(perm).toBeTruthy();
      expect(perm!.permission).toBe("readwrite");
    });
  });

  describe("Account permissions (admin only)", () => {
    it("non-admin cannot create account permissions", async () => {
      // dev@dodo.local is NOT admin@test.local
      const res = await fetchJson("/api/admin/account-permissions", {
        body: JSON.stringify({
          accountOwner: "owner@test.local",
          granteeEmail: "grantee@test.local",
          permission: "readonly",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(res.status).toBe(403);
    });

    it("non-admin cannot list account permissions", async () => {
      const res = await fetchJson("/api/admin/account-permissions?owner=owner@test.local");
      expect(res.status).toBe(403);
    });

    it("non-admin cannot delete account permissions", async () => {
      const res = await fetchJson(
        `/api/admin/account-permissions/${encodeURIComponent("owner@test.local")}/${encodeURIComponent("grantee@test.local")}`,
        { method: "DELETE" },
      );
      expect(res.status).toBe(403);
    });
  });

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
      // Tamper with the payload part
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
      const secret = "test-secret";
      const hash1 = await hashShareToken(token, secret);
      const hash2 = await hashShareToken(token, secret);
      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(token);
    });

    it("hashShareToken throws when secret is missing (audit H8)", async () => {
      const { hashShareToken } = await import("../src/share");
      await expect(hashShareToken("token")).rejects.toThrow("COOKIE_SECRET");
    });
  });
});
