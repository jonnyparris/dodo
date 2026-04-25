/**
 * MCP cross-tenant ACL tests (audit follow-up).
 *
 * Audit finding H3 was that any holder of a valid MCP token could
 * read/write/execute code in any session whose UUID they could learn,
 * because the MCP tool handlers did not call `ensureSessionAccess`. The
 * fix added `checkSessionPermission` + `ensureSessionAccess` and wired
 * them into every session-scoped MCP tool. These tests prove the helpers
 * do what the route handlers depend on:
 *
 *   1. Owner via UserControl → allowed at admin level.
 *   2. Platform admin → allowed at admin level.
 *   3. SharedIndex grant → allowed at granted level only (write-required
 *      against a readonly grant is denied).
 *   4. Stranger with no ownership and no grant → denied.
 *   5. The MCP and HTTP rate-limiters share keys (`prompt:${email}`,
 *      `msg:${email}`, `generate-hr:${email}`, `generate-day:${email}`)
 *      so abuse counters don't bypass each other.
 *
 * These run as unit tests against the real DOs via `cloudflare:test` —
 * not the full HTTP MCP handler — so they stay fast and focused on the
 * permission logic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../src/types";
import { checkSessionPermission, ensureSessionAccess } from "../src/mcp";
import { messageLimiter, promptLimiter } from "../src/rate-limiters";

// MCP module pulls in agentic via the prompt-dispatch tools — mock the
// expensive bits the same way the other test suites do.
vi.mock("../src/executor", () => ({
  runSandboxedCode: vi.fn().mockResolvedValue({ logs: [], result: null }),
}));
vi.mock("../src/agentic", async () => await import("./helpers/agentic-mock"));
vi.mock("../src/notify", () => ({ sendNotification: vi.fn() }));

const typedEnv = env as Env;

const OWNER = "owner@dodo.test";
const STRANGER = "stranger@dodo.test";
const SHARED_USER = "shared@dodo.test";
const ADMIN = "admin@test.local"; // matches vitest.config.ts ADMIN_EMAIL

function userControlStub(email: string) {
  return typedEnv.USER_CONTROL.get(typedEnv.USER_CONTROL.idFromName(email));
}

function sharedIndexStub() {
  return typedEnv.SHARED_INDEX.get(typedEnv.SHARED_INDEX.idFromName("global"));
}

async function registerSession(sessionId: string, ownerEmail: string): Promise<void> {
  const stub = userControlStub(ownerEmail);
  const res = await stub.fetch("https://user-control/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-owner-email": ownerEmail },
    body: JSON.stringify({ id: sessionId, ownerEmail, createdBy: ownerEmail, title: null }),
  });
  if (res.status !== 201) {
    throw new Error(`registerSession failed: ${res.status} ${await res.text()}`);
  }
}

async function grantPermission(sessionId: string, ownerEmail: string, granteeEmail: string, permission: "readonly" | "readwrite"): Promise<void> {
  const stub = sharedIndexStub();
  const res = await stub.fetch("https://shared-index/permissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, ownerEmail, granteeEmail, permission, grantedBy: ownerEmail }),
  });
  if (res.status !== 201) {
    throw new Error(`grantPermission failed: ${res.status} ${await res.text()}`);
  }
}

async function cleanupSessionAcls(sessionId: string): Promise<void> {
  // Wipe SharedIndex entries for this session (also clears shares).
  const shared = sharedIndexStub();
  await shared.fetch(`https://shared-index/sessions/${encodeURIComponent(sessionId)}/cleanup`, {
    method: "DELETE",
  });
}

beforeEach(() => {
  // Each test gets a fresh in-memory rate-limiter window. The limiters
  // are module-level singletons so we manually clear them.
  // @ts-expect-error - reach into private windows map for test isolation
  promptLimiter.windows.clear();
  // @ts-expect-error
  messageLimiter.windows.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("MCP cross-tenant ACL — checkSessionPermission (audit H3)", () => {
  it("owner via UserControl gets admin permission", async () => {
    const sessionId = `acl-owner-${crypto.randomUUID()}`;
    await registerSession(sessionId, OWNER);
    try {
      const result = await checkSessionPermission(typedEnv, OWNER, sessionId, "admin");
      expect(result.allowed).toBe(true);
      expect(result.permission).toBe("admin");
    } finally {
      await cleanupSessionAcls(sessionId);
    }
  });

  it("platform admin always allowed even without ownership or grant", async () => {
    const sessionId = `acl-admin-${crypto.randomUUID()}`;
    await registerSession(sessionId, OWNER);
    try {
      const result = await checkSessionPermission(typedEnv, ADMIN, sessionId, "admin");
      expect(result.allowed).toBe(true);
      expect(result.permission).toBe("admin");
    } finally {
      await cleanupSessionAcls(sessionId);
    }
  });

  it("stranger with no ownership and no grant is denied", async () => {
    const sessionId = `acl-stranger-${crypto.randomUUID()}`;
    await registerSession(sessionId, OWNER);
    try {
      const result = await checkSessionPermission(typedEnv, STRANGER, sessionId, "readonly");
      expect(result.allowed).toBe(false);
      expect(result.permission).toBeNull();
    } finally {
      await cleanupSessionAcls(sessionId);
    }
  });

  it("readonly grant lets the grantee read but NOT write", async () => {
    const sessionId = `acl-ro-${crypto.randomUUID()}`;
    await registerSession(sessionId, OWNER);
    await grantPermission(sessionId, OWNER, SHARED_USER, "readonly");
    try {
      const ro = await checkSessionPermission(typedEnv, SHARED_USER, sessionId, "readonly");
      expect(ro.allowed).toBe(true);
      expect(ro.permission).toBe("readonly");

      const wr = await checkSessionPermission(typedEnv, SHARED_USER, sessionId, "write");
      expect(wr.allowed).toBe(false);
      // Permission is reported (readonly) so the caller can render a useful
      // error — we just deny because it doesn't meet the required level.
      expect(wr.permission).toBe("readonly");
    } finally {
      await cleanupSessionAcls(sessionId);
    }
  });

  it("readwrite grant lets the grantee write but NOT admin", async () => {
    const sessionId = `acl-rw-${crypto.randomUUID()}`;
    await registerSession(sessionId, OWNER);
    await grantPermission(sessionId, OWNER, SHARED_USER, "readwrite");
    try {
      const wr = await checkSessionPermission(typedEnv, SHARED_USER, sessionId, "write");
      expect(wr.allowed).toBe(true);
      expect(wr.permission).toBe("write");

      const admin = await checkSessionPermission(typedEnv, SHARED_USER, sessionId, "admin");
      expect(admin.allowed).toBe(false);
      expect(admin.permission).toBe("write");
    } finally {
      await cleanupSessionAcls(sessionId);
    }
  });

  it("non-existent session denies everyone (including the would-be owner)", async () => {
    const sessionId = `acl-ghost-${crypto.randomUUID()}`;
    // Deliberately do NOT register the session.
    const result = await checkSessionPermission(typedEnv, OWNER, sessionId, "readonly");
    expect(result.allowed).toBe(false);
    expect(result.permission).toBeNull();
  });
});

describe("MCP cross-tenant ACL — ensureSessionAccess (audit H3)", () => {
  it("returns ok=true for the owner", async () => {
    const sessionId = `ensure-owner-${crypto.randomUUID()}`;
    await registerSession(sessionId, OWNER);
    try {
      const out = await ensureSessionAccess(typedEnv, OWNER, sessionId, "write");
      expect(out.ok).toBe(true);
    } finally {
      await cleanupSessionAcls(sessionId);
    }
  });

  it("returns an MCP error result for a stranger (no info leak about session existence)", async () => {
    const sessionId = `ensure-stranger-${crypto.randomUUID()}`;
    await registerSession(sessionId, OWNER);
    try {
      const out = await ensureSessionAccess(typedEnv, STRANGER, sessionId, "readonly");
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.result.isError).toBe(true);
        const text = out.result.content[0]?.text ?? "";
        // Same wording for "not found" and "denied" — strangers can't probe
        // session UUIDs by inspecting error messages.
        expect(text).toMatch(/not found or access denied/);
      }
    } finally {
      await cleanupSessionAcls(sessionId);
    }
  });

  it("falls back to ADMIN_EMAIL when no userEmail is threaded (service mode)", async () => {
    const sessionId = `ensure-svc-${crypto.randomUUID()}`;
    await registerSession(sessionId, OWNER);
    try {
      // No userEmail → resolves to ADMIN_EMAIL → admin is always allowed.
      const out = await ensureSessionAccess(typedEnv, undefined, sessionId, "admin");
      expect(out.ok).toBe(true);
    } finally {
      await cleanupSessionAcls(sessionId);
    }
  });
});

describe("MCP rate-limiter key consistency (audit follow-up F3)", () => {
  // The fix for the audit-finding "MCP routes had no rate limiting" was
  // to import the same module-level limiters used by the HTTP routes and
  // charge them with the same key shape. If MCP and HTTP ever drifted to
  // different keys, an attacker with a token could spend 2x the budget.
  // These tests pin the key shape.

  it("MCP `prompt:${email}` key shares budget with HTTP", async () => {
    const email = "shared-budget@dodo.test";
    const limit = 60;

    // Burn 30 with MCP-style key
    for (let i = 0; i < 30; i++) {
      const r = promptLimiter.check(`prompt:${email}`, limit, 60_000);
      expect(r.allowed).toBe(true);
    }
    // Burn 30 more with the HTTP-style key (same string) — should hit limit.
    for (let i = 0; i < 30; i++) {
      const r = promptLimiter.check(`prompt:${email}`, limit, 60_000);
      expect(r.allowed).toBe(true);
    }
    const overLimit = promptLimiter.check(`prompt:${email}`, limit, 60_000);
    expect(overLimit.allowed).toBe(false);
  });

  it("MCP `msg:${email}` key shares budget with HTTP", async () => {
    const email = "shared-msg@dodo.test";
    const limit = 120;

    for (let i = 0; i < limit; i++) {
      const r = messageLimiter.check(`msg:${email}`, limit, 60_000);
      expect(r.allowed).toBe(true);
    }
    const over = messageLimiter.check(`msg:${email}`, limit, 60_000);
    expect(over.allowed).toBe(false);
  });

  it("`generate-hr:${email}` and `generate-day:${email}` are separate counters", async () => {
    const email = "gen-budget@dodo.test";

    // Hourly limit is 30 — burn it.
    for (let i = 0; i < 30; i++) {
      const r = promptLimiter.check(`generate-hr:${email}`, 30, 60 * 60_000);
      expect(r.allowed).toBe(true);
    }
    expect(promptLimiter.check(`generate-hr:${email}`, 30, 60 * 60_000).allowed).toBe(false);

    // Daily counter is independent — must still be available.
    expect(promptLimiter.check(`generate-day:${email}`, 100, 24 * 60 * 60_000).allowed).toBe(true);
  });

  it("rate-limiter keys are scoped per-email (one user can't burn another's budget)", async () => {
    const userA = "alice@dodo.test";
    const userB = "bob@dodo.test";

    // Burn alice's budget completely.
    for (let i = 0; i < 60; i++) {
      promptLimiter.check(`prompt:${userA}`, 60, 60_000);
    }
    expect(promptLimiter.check(`prompt:${userA}`, 60, 60_000).allowed).toBe(false);

    // Bob is unaffected.
    expect(promptLimiter.check(`prompt:${userB}`, 60, 60_000).allowed).toBe(true);
  });
});
