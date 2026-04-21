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

describe("UserControl DO", () => {
  // Warm up: absorb any DO invalidation from module changes between test files
  beforeAll(async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetchJson("/health");
      if (res.status === 200) break;
    }
    // Make requests that touch UserControl DO to reset it
    try { await fetchJson("/api/config"); } catch { /* absorb invalidation */ }
    try { await fetchJson("/api/config"); } catch { /* retry */ }
  });
  // ─── Config ───

  it("config: get default → update → verify changed", async () => {
    // Read default config
    const getRes = await fetchJson("/api/config");
    expect(getRes.status).toBe(200);
    const defaultConfig = (await getRes.json()) as {
      activeGateway: string;
      model: string;
      opencodeBaseURL: string;
      aiGatewayBaseURL: string;
      gitAuthorEmail: string;
      gitAuthorName: string;
    };
    expect(defaultConfig.activeGateway).toBeTruthy();
    expect(defaultConfig.model).toBeTruthy();

    // Update config
    const updateRes = await fetchJson("/api/config", {
      body: JSON.stringify({ model: "uc-test-model-xyz", activeGateway: "ai-gateway" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    expect(updateRes.status).toBe(200);
    const updatedConfig = (await updateRes.json()) as { activeGateway: string; model: string };
    expect(updatedConfig.activeGateway).toBe("ai-gateway");
    expect(updatedConfig.model).toBe("uc-test-model-xyz");

    // Read back to confirm persistence
    const verifyRes = await fetchJson("/api/config");
    const verifiedConfig = (await verifyRes.json()) as { activeGateway: string; model: string };
    expect(verifiedConfig.activeGateway).toBe("ai-gateway");
    expect(verifiedConfig.model).toBe("uc-test-model-xyz");

    // Restore to defaults so we don't break other tests
    await fetchJson("/api/config", {
      body: JSON.stringify({ activeGateway: "opencode", model: "claude-test" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
  });

  it("config: switching gateway to ai-gateway auto-swaps to a Workers AI model when none is specified", async () => {
    // Start from opencode + opencode-routable model.
    await fetchJson("/api/config", {
      body: JSON.stringify({ activeGateway: "opencode", model: "openai/gpt-5.4" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });

    // Flip gateway only — no model override. Server should pick a @cf/ default.
    const flipRes = await fetchJson("/api/config", {
      body: JSON.stringify({ activeGateway: "ai-gateway" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    expect(flipRes.status).toBe(200);
    const flipped = (await flipRes.json()) as { activeGateway: string; model: string };
    expect(flipped.activeGateway).toBe("ai-gateway");
    expect(flipped.model.startsWith("@cf/")).toBe(true);

    // Flip back — model should revert to opencode-routable default.
    const revertRes = await fetchJson("/api/config", {
      body: JSON.stringify({ activeGateway: "opencode" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    const reverted = (await revertRes.json()) as { activeGateway: string; model: string };
    expect(reverted.activeGateway).toBe("opencode");
    expect(reverted.model.startsWith("@cf/")).toBe(false);

    // Restore defaults
    await fetchJson("/api/config", {
      body: JSON.stringify({ activeGateway: "opencode", model: "claude-test" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
  });

  it("config: passing both activeGateway and model respects the explicit model", async () => {
    const res = await fetchJson("/api/config", {
      body: JSON.stringify({ activeGateway: "ai-gateway", model: "openai/gpt-5.4" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    const cfg = (await res.json()) as { model: string };
    expect(cfg.model).toBe("openai/gpt-5.4");

    // Restore
    await fetchJson("/api/config", {
      body: JSON.stringify({ activeGateway: "opencode", model: "claude-test" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
  });

  // ─── Memory ───

  it("memory: create → search → read → update → delete", async () => {
    // Create
    const createRes = await fetchJson("/api/memory", {
      body: JSON.stringify({
        title: "UC test memory entry",
        content: "This is a unique usercontrol test content xyzzy",
        tags: ["uc-test", "integration"],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; title: string; content: string; tags: string[] };
    expect(created.id).toBeTruthy();
    expect(created.title).toBe("UC test memory entry");
    expect(created.tags).toContain("uc-test");

    // Search by content keyword
    const searchRes = await fetchJson("/api/memory?q=xyzzy");
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as { entries: Array<{ id: string; title: string }> };
    expect(searchBody.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.id, title: "UC test memory entry" })]),
    );

    // Read single entry
    const readRes = await fetchJson(`/api/memory/${created.id}`);
    expect(readRes.status).toBe(200);
    const readBody = (await readRes.json()) as { id: string; content: string };
    expect(readBody.id).toBe(created.id);
    expect(readBody.content).toContain("xyzzy");

    // Update
    const updateRes = await fetchJson(`/api/memory/${created.id}`, {
      body: JSON.stringify({
        title: "UC test memory updated",
        content: "Updated content plugh",
        tags: ["uc-test", "updated"],
      }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as { title: string; content: string; tags: string[] };
    expect(updated.title).toBe("UC test memory updated");
    expect(updated.content).toContain("plugh");
    expect(updated.tags).toContain("updated");

    // Delete
    const deleteRes = await fetchJson(`/api/memory/${created.id}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);
    const deleteBody = (await deleteRes.json()) as { deleted: boolean; id: string };
    expect(deleteBody.deleted).toBe(true);
  });

  // ─── Tasks ───

  it("tasks: create → update status → list → delete", async () => {
    // Create
    const createRes = await fetchJson("/api/tasks", {
      body: JSON.stringify({
        title: "UC integration test task",
        description: "A task created by user-control tests",
        priority: "low",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(createRes.status).toBe(201);
    const task = (await createRes.json()) as {
      id: string;
      title: string;
      status: string;
      priority: string;
      description: string;
    };
    expect(task.title).toBe("UC integration test task");
    expect(task.status).toBe("backlog");
    expect(task.priority).toBe("low");

    // Update status to in_progress
    const updateRes = await fetchJson(`/api/tasks/${task.id}`, {
      body: JSON.stringify({ status: "in_progress" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as { id: string; status: string };
    expect(updated.status).toBe("in_progress");

    // List tasks — our task should appear
    const listRes = await fetchJson("/api/tasks");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { tasks: Array<{ id: string; title: string; status: string }> };
    expect(listBody.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: task.id, title: "UC integration test task", status: "in_progress" }),
      ]),
    );

    // Delete
    const deleteRes = await fetchJson(`/api/tasks/${task.id}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);
    const deleteBody = (await deleteRes.json()) as { deleted: boolean; id: string };
    expect(deleteBody.deleted).toBe(true);
  });

  // ─── Passkey + Secrets ───

  it("passkey + secrets: init → set → list → test → delete", async () => {
    // Check passkey not initialized (might already be from other test runs in shared state)
    const statusBefore = await fetchJson("/api/passkey/status");
    expect(statusBefore.status).toBe(200);
    const statusBeforeBody = (await statusBefore.json()) as { initialized: boolean };

    // If not initialized, initialize it
    if (!statusBeforeBody.initialized) {
      const initRes = await fetchJson("/api/passkey/init", {
        body: JSON.stringify({ passkey: "test-passkey-4321" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(initRes.status).toBe(200);
      const initBody = (await initRes.json()) as { initialized: boolean };
      expect(initBody.initialized).toBe(true);
    }

    // Verify passkey is now initialized
    const statusAfter = await fetchJson("/api/passkey/status");
    const statusAfterBody = (await statusAfter.json()) as { initialized: boolean };
    expect(statusAfterBody.initialized).toBe(true);

    // Set a secret
    const secretKey = "UC_TEST_SECRET_KEY";
    const setRes = await fetchJson(`/api/secrets/${secretKey}`, {
      body: JSON.stringify({ value: "super-secret-value-12345" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    expect(setRes.status).toBe(200);
    const setBody = (await setRes.json()) as { key: string; updated: boolean };
    expect(setBody.key).toBe(secretKey);
    expect(setBody.updated).toBe(true);

    // List secrets — our key should be present
    const listRes = await fetchJson("/api/secrets");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { keys: string[] };
    expect(listBody.keys).toContain(secretKey);

    // Test if secret exists
    const testRes = await fetchJson(`/api/secrets/${secretKey}/test`);
    expect(testRes.status).toBe(200);
    const testBody = (await testRes.json()) as { key: string; exists: boolean };
    expect(testBody.key).toBe(secretKey);
    expect(testBody.exists).toBe(true);

    // Test non-existent secret
    const testNoRes = await fetchJson("/api/secrets/NONEXISTENT_KEY/test");
    expect(testNoRes.status).toBe(200);
    const testNoBody = (await testNoRes.json()) as { exists: boolean };
    expect(testNoBody.exists).toBe(false);

    // Delete secret
    const deleteRes = await fetchJson(`/api/secrets/${secretKey}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);
    const deleteBody = (await deleteRes.json()) as { deleted: boolean; key: string };
    expect(deleteBody.deleted).toBe(true);

    // Verify deleted
    const testAfterDelete = await fetchJson(`/api/secrets/${secretKey}/test`);
    const testAfterBody = (await testAfterDelete.json()) as { exists: boolean };
    expect(testAfterBody.exists).toBe(false);
  });

  // ─── Identity ───

  it("identity: returns email and isAdmin flag", async () => {
    const res = await fetchJson("/api/identity");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string; isAdmin: boolean };
    // In dev mode, email is dev@dodo.local
    expect(body.email).toBe("dev@dodo.local");
    // dev@dodo.local is not admin@test.local
    expect(body.isAdmin).toBe(false);
  });

  // ─── Status ───

  it("status: returns version and session count", async () => {
    const res = await fetchJson("/api/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; sessionCount: number; hasPasskey: boolean };
    expect(body.version).toBeTruthy();
    expect(typeof body.sessionCount).toBe("number");
    expect(typeof body.hasPasskey).toBe("boolean");
  });

  // ─── Memory: empty search returns entries ───

  it("memory: empty search lists all entries", async () => {
    const res = await fetchJson("/api/memory");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(Array.isArray(body.entries)).toBe(true);
  });

  // ─── Tasks: filter by status ───

  it("tasks: filter by status query param", async () => {
    // Create a task with known status
    const createRes = await fetchJson("/api/tasks", {
      body: JSON.stringify({ title: "UC filter test task", priority: "medium" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const task = (await createRes.json()) as { id: string };

    // Mark as done
    await fetchJson(`/api/tasks/${task.id}`, {
      body: JSON.stringify({ status: "done" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });

    // Filter by "done"
    const listDone = await fetchJson("/api/tasks?status=done");
    expect(listDone.status).toBe(200);
    const doneBody = (await listDone.json()) as { tasks: Array<{ id: string; status: string }> };
    expect(doneBody.tasks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: task.id, status: "done" })]),
    );

    // Filter by "backlog" — should NOT contain our done task
    const listBacklog = await fetchJson("/api/tasks?status=backlog");
    const backlogBody = (await listBacklog.json()) as { tasks: Array<{ id: string }> };
    expect(backlogBody.tasks.some((t) => t.id === task.id)).toBe(false);

    // Cleanup
    await fetchJson(`/api/tasks/${task.id}`, { method: "DELETE" });
  });
});
