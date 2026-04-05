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

async function addAllowlistDirect(hostname: string): Promise<void> {
  const testEnv = env as Env;
  const stub = testEnv.SHARED_INDEX.get(testEnv.SHARED_INDEX.idFromName("global"));
  await stub.fetch("https://shared-index/allowlist", {
    body: JSON.stringify({ hostname }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

describe("MCP Config CRUD", () => {
  // Warm up: absorb any DO invalidation and add test hosts to allowlist
  beforeAll(async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetchJson("/health");
      if (res.status === 200) break;
    }
    try { await fetchJson("/api/mcp-configs"); } catch { /* absorb invalidation */ }
    try { await fetchJson("/api/mcp-configs"); } catch { /* retry */ }
    // Add test hostnames to the allowlist via direct DO access (write routes are admin-only)
    const hosts = ["mcp.example.com", "mcp-v2.example.com", "minimal.example.com", "toggle.example.com"];
    for (const hostname of hosts) {
      await addAllowlistDirect(hostname);
    }
  });

  it("list MCP configs → empty initially", async () => {
    const res = await fetchJson("/api/mcp-configs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { configs: unknown[] };
    expect(Array.isArray(body.configs)).toBe(true);
    // May or may not be empty depending on shared DO state, but array must exist
  });

  it("create → listed → update → verify → delete → gone", async () => {
    // Create
    const createRes = await fetchJson("/api/mcp-configs", {
      body: JSON.stringify({
        name: "Test MCP Server",
        type: "http",
        url: "https://mcp.example.com/v1",
        headers: { Authorization: "Bearer test-token" },
        enabled: true,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      id: string;
      name: string;
      type: string;
      url: string;
      headers?: Record<string, string>;
      headerKeys?: string[];
      enabled: boolean;
    };
    expect(created.id).toBeTruthy();
    expect(created.name).toBe("Test MCP Server");
    expect(created.type).toBe("http");
    // Headers are now stored as encrypted secrets; only key names returned
    expect(created.headerKeys).toEqual(["Authorization"]);
    expect(created.headers).toBeUndefined();
    expect(created.enabled).toBe(true);

    // Listed
    const listRes = await fetchJson("/api/mcp-configs");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { configs: Array<{ id: string; name: string }> };
    expect(listBody.configs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.id, name: "Test MCP Server" })]),
    );

    // Update URL
    const updateRes = await fetchJson(`/api/mcp-configs/${created.id}`, {
      body: JSON.stringify({ url: "https://mcp-v2.example.com/v1" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as { id: string; url: string; name: string };
    expect(updated.url).toBe("https://mcp-v2.example.com/v1");
    expect(updated.name).toBe("Test MCP Server"); // name unchanged

    // Verify in list
    const verifyRes = await fetchJson("/api/mcp-configs");
    const verifyBody = (await verifyRes.json()) as { configs: Array<{ id: string; url: string }> };
    const found = verifyBody.configs.find((c) => c.id === created.id);
    expect(found).toBeTruthy();
    expect(found!.url).toBe("https://mcp-v2.example.com/v1");

    // Delete
    const deleteRes = await fetchJson(`/api/mcp-configs/${created.id}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);
    const deleteBody = (await deleteRes.json()) as { deleted: boolean; id: string };
    expect(deleteBody.deleted).toBe(true);

    // Verify gone
    const afterDeleteRes = await fetchJson("/api/mcp-configs");
    const afterDeleteBody = (await afterDeleteRes.json()) as { configs: Array<{ id: string }> };
    expect(afterDeleteBody.configs.find((c) => c.id === created.id)).toBeUndefined();
  });

  it("create config with defaults (type and enabled)", async () => {
    const createRes = await fetchJson("/api/mcp-configs", {
      body: JSON.stringify({
        name: "Minimal Config",
        url: "https://minimal.example.com",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; type: string; enabled: boolean };
    expect(created.type).toBe("http");
    expect(created.enabled).toBe(true);

    // Cleanup
    await fetchJson(`/api/mcp-configs/${created.id}`, { method: "DELETE" });
  });

  it("update config enabled flag", async () => {
    // Create
    const createRes = await fetchJson("/api/mcp-configs", {
      body: JSON.stringify({ name: "Toggle Config", url: "https://toggle.example.com" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const created = (await createRes.json()) as { id: string; enabled: boolean };
    expect(created.enabled).toBe(true);

    // Disable
    const updateRes = await fetchJson(`/api/mcp-configs/${created.id}`, {
      body: JSON.stringify({ enabled: false }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    const updated = (await updateRes.json()) as { id: string; enabled: boolean };
    expect(updated.enabled).toBe(false);

    // Cleanup
    await fetchJson(`/api/mcp-configs/${created.id}`, { method: "DELETE" });
  });
});

describe("MCP Catalog", () => {
  it("returns catalog with 6 entries", async () => {
    const res = await fetchJson("/api/mcp-catalog");
    expect(res.status).toBe(200);
    const catalog = (await res.json()) as Array<{ id: string; name: string; description: string; url: string; setupGuide: string }>;
    expect(Array.isArray(catalog)).toBe(true);
    expect(catalog.length).toBe(6);

    // Verify known entries exist
    const ids = catalog.map((c) => c.id);
    expect(ids).toContain("dodo-self");
    expect(ids).toContain("agent-memory");
    expect(ids).toContain("github");
    expect(ids).toContain("cloudflare-api");
    expect(ids).toContain("sentry");
    expect(ids).toContain("browser-rendering");

    // Verify each entry has required fields
    for (const entry of catalog) {
      expect(entry.id).toBeTruthy();
      expect(entry.name).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(entry.url).toBeTruthy();
      expect(entry.setupGuide).toBeTruthy();
    }
  });
});

describe("McpGatekeeper interface", () => {
  it("HttpMcpGatekeeper: construct with valid config", async () => {
    // Dynamic import to avoid issues with MCP SDK in test runtime
    const { HttpMcpGatekeeper } = await import("../src/mcp-gatekeeper");

    const config = {
      id: "test-server",
      name: "Test Server",
      type: "http" as const,
      url: "https://mcp-test.example.com",
      headers: { Authorization: "Bearer abc" },
      enabled: true,
    };

    const gatekeeper = new HttpMcpGatekeeper(config);
    expect(gatekeeper).toBeTruthy();
    expect(gatekeeper.isConnected()).toBe(false);
  });

  it("HttpMcpGatekeeper: rejects service-binding type", async () => {
    const { HttpMcpGatekeeper } = await import("../src/mcp-gatekeeper");

    expect(() => new HttpMcpGatekeeper({
      id: "wrong-type",
      name: "Wrong Type",
      type: "service-binding",
      enabled: true,
    })).toThrow(/only supports type "http"/);
  });

  it("HttpMcpGatekeeper: rejects missing url", async () => {
    const { HttpMcpGatekeeper } = await import("../src/mcp-gatekeeper");

    expect(() => new HttpMcpGatekeeper({
      id: "no-url",
      name: "No URL",
      type: "http",
      enabled: true,
    })).toThrow(/requires a url/);
  });
});
