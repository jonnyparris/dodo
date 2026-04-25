/**
 * Tests for previously dead columns now wired into responses (audit
 * follow-up). The /audit-stubs review (memory/reviews/2026-04-25-dodo-
 * audit-stubs.md) flagged 14 write-only columns. Five of them looked
 * like forgotten wiring rather than truly dead schema:
 *
 *   - encrypted_secrets.created_at, encrypted_secrets.updated_at
 *   - key_envelope.created_at, key_envelope.rotated_at
 *   - message_attachments.source
 *
 * These tests pin the new contract so we don't silently regress to
 * write-only.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env } from "../src/types";

vi.mock("../src/executor", () => ({
  runSandboxedCode: vi.fn().mockResolvedValue({ logs: [], result: null }),
}));
vi.mock("../src/agentic", async () => await import("./helpers/agentic-mock"));
vi.mock("../src/notify", () => ({ sendNotification: vi.fn() }));

import worker from "../src/index";

const BASE_URL = "https://dodo.example";

async function fetchJson(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, init), env as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

// The dev-mode UserControl DO is shared across the entire test run. The
// passkey envelope may already be initialized (because architecture-gaps
// or onboarding tests ran first). If not, set one with a known value so
// setSecret has a DEK to encrypt with.
const TEST_PASSKEY = "deadcol-test-passkey-7777";

async function ensurePasskeyInitialized(): Promise<void> {
  const statusRes = await fetchJson("/api/passkey/status");
  if (!statusRes.ok) return;
  const status = (await statusRes.json()) as { initialized: boolean };
  if (status.initialized) return;
  await fetchJson("/api/passkey/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passkey: TEST_PASSKEY }),
  });
}

describe("encrypted_secrets timestamps surfaced in /api/secrets", () => {
  beforeAll(async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetchJson("/health");
      if (res.status === 200) break;
    }
    try { await fetchJson("/api/secrets"); } catch { /* absorb invalidation */ }
    await ensurePasskeyInitialized();
  });

  it("returns secrets[].createdAt and updatedAt as ISO strings", async () => {
    const secretKey = "DEADCOL_TEST_TIMESTAMPS";
    const setRes = await fetchJson(`/api/secrets/${secretKey}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "test-value-12345" }),
    });
    expect(setRes.status).toBe(200);

    const listRes = await fetchJson("/api/secrets");
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as {
      keys: string[];
      secrets: Array<{ key: string; createdAt: string; updatedAt: string }>;
    };

    // Legacy `keys` shape preserved for backwards compat.
    expect(body.keys).toContain(secretKey);

    // New `secrets` shape carries the timestamps.
    const entry = body.secrets.find((s) => s.key === secretKey);
    expect(entry).toBeDefined();
    expect(entry!.createdAt).toMatch(ISO_8601);
    expect(entry!.updatedAt).toMatch(ISO_8601);

    await fetchJson(`/api/secrets/${secretKey}`, { method: "DELETE" });
  });

  it("updatedAt advances on overwrite while createdAt is stable", async () => {
    const secretKey = "DEADCOL_TEST_OVERWRITE";

    const initialPut = await fetchJson(`/api/secrets/${secretKey}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "initial" }),
    });
    expect(initialPut.status).toBe(200);

    const first = (await (await fetchJson("/api/secrets")).json()) as {
      secrets: Array<{ key: string; createdAt: string; updatedAt: string }>;
    };
    const initial = first.secrets.find((s) => s.key === secretKey);
    expect(initial).toBeDefined();

    // Wait so the second-precision epoch can advance.
    await new Promise((r) => setTimeout(r, 1100));

    const overwrite = await fetchJson(`/api/secrets/${secretKey}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "rotated" }),
    });
    expect(overwrite.status).toBe(200);

    const second = (await (await fetchJson("/api/secrets")).json()) as {
      secrets: Array<{ key: string; createdAt: string; updatedAt: string }>;
    };
    const after = second.secrets.find((s) => s.key === secretKey);
    expect(after).toBeDefined();

    // createdAt must be unchanged on a PUT-overwrite (ON CONFLICT DO UPDATE
    // does NOT touch created_at). updatedAt must move forward.
    expect(after!.createdAt).toBe(initial!.createdAt);
    expect(Date.parse(after!.updatedAt)).toBeGreaterThan(Date.parse(initial!.updatedAt));

    await fetchJson(`/api/secrets/${secretKey}`, { method: "DELETE" });
  });
});

describe("key_envelope timestamps surfaced in /api/passkey/status", () => {
  beforeAll(async () => {
    await ensurePasskeyInitialized();
  });

  it("returns initialized=true with createdAt when an envelope exists", async () => {
    const res = await fetchJson("/api/passkey/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      initialized: boolean;
      createdAt?: string;
      rotatedAt?: string | null;
    };

    // ensurePasskeyInitialized() ran in beforeAll, so this MUST be true.
    expect(body.initialized).toBe(true);
    expect(body.createdAt).toMatch(ISO_8601);
    // rotatedAt is null when never rotated, ISO when rotated.
    if (body.rotatedAt !== null && body.rotatedAt !== undefined) {
      expect(body.rotatedAt).toMatch(ISO_8601);
    }
  });
});

describe("message_attachments.source — schema + select shape", () => {
  it("schema retains the source column with NOT NULL", async () => {
    const typedEnv = env as Env;
    const stub = typedEnv.CODING_AGENT.get(typedEnv.CODING_AGENT.idFromName("dead-col-source-test"));

    // Boot the DO storage by hitting an endpoint that triggers schema setup.
    await stub.fetch("https://coding-agent/messages", {
      headers: { "x-owner-email": "dev@dodo.local", "x-dodo-session-id": "dead-col-source-test" },
    });

    const sourceColumn = await runInDurableObject(stub, async (_, state) => {
      // pragma_table_info exposes a column literally named `notnull` —
      // backticks let us reference it without a syntax error.
      const cursor = state.storage.sql.exec(
        "SELECT name, `notnull` AS not_null FROM pragma_table_info('message_attachments') WHERE name = 'source'",
      );
      return cursor.toArray()[0] ?? null;
    });

    expect(sourceColumn).not.toBeNull();
    expect(sourceColumn).toMatchObject({ name: "source", not_null: 1 });
  });

  it("listMessageAttachments-style SELECT returns the source value", async () => {
    const typedEnv = env as Env;
    const stub = typedEnv.CODING_AGENT.get(typedEnv.CODING_AGENT.idFromName("dead-col-source-select"));

    await stub.fetch("https://coding-agent/messages", {
      headers: { "x-owner-email": "dev@dodo.local", "x-dodo-session-id": "dead-col-source-select" },
    });

    const result = await runInDurableObject(stub, async (_, state) => {
      const messageId = `msg-${crypto.randomUUID()}`;
      state.storage.sql.exec(
        "INSERT INTO message_attachments (message_id, tool_call_id, media_type, url, size, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        messageId,
        null,
        "image/png",
        "https://example.test/image.png",
        1234,
        "user",
        Date.now(),
      );
      const cursor = state.storage.sql.exec(
        "SELECT message_id, media_type, url, size, source FROM message_attachments WHERE message_id = ?",
        messageId,
      );
      return cursor.toArray()[0] ?? null;
    });

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      media_type: "image/png",
      url: "https://example.test/image.png",
      size: 1234,
      source: "user",
    });
  });
});
