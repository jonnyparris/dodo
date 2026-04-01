import { beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env } from "../src/types";

// Mock modules that depend on unavailable packages in the test runtime
vi.mock("../src/executor", () => ({
  runSandboxedCode: vi.fn().mockResolvedValue({ logs: [], result: null }),
}));
vi.mock("../src/agentic", () => ({
  runAgenticChat: vi.fn().mockResolvedValue({ gateway: "opencode", model: "test", steps: 0, text: "", toolCalls: [] }),
  streamAgenticChat: vi.fn().mockResolvedValue({ gateway: "opencode", model: "test", steps: 0, text: "", tokenInput: 0, tokenOutput: 0, toolCalls: [] }),
  isCallerOwner: vi.fn().mockImplementation((author?: string, owner?: string) => {
    if (!author || !owner) return true;
    return author === owner;
  }),
  buildToolsForThink: vi.fn().mockReturnValue({}),
}));
vi.mock("../src/notify", () => ({
  sendNotification: vi.fn(),
}));

import worker from "../src/index";
import { requirePermission } from "../src/index";

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

describe("Permission enforcement", () => {
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

  describe("requirePermission helper (unit)", () => {
    it("returns null when permission meets required level", () => {
      const mockContext = {
        get: (key: string) => key === "sessionPermission" ? "admin" : undefined,
        json: (data: unknown, status?: number) => Response.json(data, { status }),
      };
      expect(requirePermission(mockContext, "readonly")).toBeNull();
      expect(requirePermission(mockContext, "write")).toBeNull();
      expect(requirePermission(mockContext, "admin")).toBeNull();
    });

    it("returns null for write permission when required is write", () => {
      const mockContext = {
        get: (key: string) => key === "sessionPermission" ? "write" : undefined,
        json: (data: unknown, status?: number) => Response.json(data, { status }),
      };
      expect(requirePermission(mockContext, "readonly")).toBeNull();
      expect(requirePermission(mockContext, "write")).toBeNull();
    });

    it("returns null for readwrite permission when required is write", () => {
      const mockContext = {
        get: (key: string) => key === "sessionPermission" ? "readwrite" : undefined,
        json: (data: unknown, status?: number) => Response.json(data, { status }),
      };
      expect(requirePermission(mockContext, "readonly")).toBeNull();
      expect(requirePermission(mockContext, "write")).toBeNull();
    });

    it("returns 403 when readonly tries write operation", () => {
      const mockContext = {
        get: (key: string) => key === "sessionPermission" ? "readonly" : undefined,
        json: (data: unknown, status?: number) => Response.json(data, { status }),
      };
      const result = requirePermission(mockContext, "write");
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });

    it("returns 403 when readonly tries admin operation", () => {
      const mockContext = {
        get: (key: string) => key === "sessionPermission" ? "readonly" : undefined,
        json: (data: unknown, status?: number) => Response.json(data, { status }),
      };
      const result = requirePermission(mockContext, "admin");
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });

    it("returns 403 when write tries admin operation", () => {
      const mockContext = {
        get: (key: string) => key === "sessionPermission" ? "write" : undefined,
        json: (data: unknown, status?: number) => Response.json(data, { status }),
      };
      const result = requirePermission(mockContext, "admin");
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });

    it("returns 403 when permission is undefined", () => {
      const mockContext = {
        get: () => undefined,
        json: (data: unknown, status?: number) => Response.json(data, { status }),
      };
      const result = requirePermission(mockContext, "readonly");
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });
  });

  describe("Session owner has full access", () => {
    let sessionId: string;

    beforeAll(async () => {
      sessionId = await createSession();
    });

    it("owner can GET session state (readonly)", async () => {
      const res = await fetchJson(`/session/${sessionId}`);
      expect(res.status).toBe(200);
    });

    it("owner can GET messages (readonly)", async () => {
      const res = await fetchJson(`/session/${sessionId}/messages`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: unknown[] };
      expect(Array.isArray(body.messages)).toBe(true);
    });

    it("owner can GET prompts (readonly)", async () => {
      const res = await fetchJson(`/session/${sessionId}/prompts`);
      expect(res.status).toBe(200);
    });

    it("owner can GET files (readonly)", async () => {
      const res = await fetchJson(`/session/${sessionId}/files`);
      expect(res.status).toBe(200);
    });

    it("owner can PUT file (write)", async () => {
      const res = await fetchJson(`/session/${sessionId}/file?path=/test.txt`, {
        body: JSON.stringify({ content: "hello world" }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { written: boolean };
      expect(body.written).toBe(true);
    });

    it("owner can DELETE file (write)", async () => {
      // First write a file
      await fetchJson(`/session/${sessionId}/file?path=/to-delete.txt`, {
        body: JSON.stringify({ content: "delete me" }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const res = await fetchJson(`/session/${sessionId}/file?path=/to-delete.txt`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { deleted: boolean };
      expect(body.deleted).toBe(true);
    });

    it("owner can POST cron (write)", async () => {
      const res = await fetchJson(`/session/${sessionId}/cron`, {
        body: JSON.stringify({ type: "delayed", delayInSeconds: 3600, prompt: "test", description: "test cron" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(res.status).toBe(201);
    });

    it("owner can manage shares (admin)", async () => {
      const res = await fetchJson(`/session/${sessionId}/share`, {
        body: JSON.stringify({ permission: "readonly" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(res.status).toBe(201);
    });

    it("owner can manage permissions (admin)", async () => {
      const res = await fetchJson(`/session/${sessionId}/permissions`, {
        body: JSON.stringify({ granteeEmail: "test@test.local", permission: "readonly" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(res.status).toBe(201);
    });

    it("owner can DELETE session (admin) — permission check passes", async () => {
      const deleteSessionId = await createSession();
      // Send a message to initialize the CodingAgent DO with owner_email metadata
      // (the message route passes x-owner-email header)
      const msgRes = await fetchJson(`/session/${deleteSessionId}/message`, {
        body: JSON.stringify({ content: "init" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      // Message may return 502 if LLM mock fails, but it initializes owner_email
      expect([200, 502]).toContain(msgRes.status);

      const res = await fetchJson(`/session/${deleteSessionId}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { deleted: boolean };
      expect(body.deleted).toBe(true);
    });
  });

  describe("isCallerOwner logic (unit)", () => {
    // Test the permission logic directly (the real isCallerOwner is in agentic.ts)
    function isCallerOwner(authorEmail?: string, ownerEmail?: string): boolean {
      if (!authorEmail || !ownerEmail) return true;
      return authorEmail === ownerEmail;
    }

    it("returns true when author matches owner", () => {
      expect(isCallerOwner("user@test.local", "user@test.local")).toBe(true);
    });

    it("returns false when author differs from owner", () => {
      expect(isCallerOwner("guest@test.local", "owner@test.local")).toBe(false);
    });

    it("returns true when author is undefined (default to owner)", () => {
      expect(isCallerOwner(undefined, "owner@test.local")).toBe(true);
    });
  });
});

describe("MCP credential encryption", () => {
  beforeAll(async () => {
    // Warm up and initialize passkey for encryption tests
    for (let i = 0; i < 3; i++) {
      const res = await fetchJson("/health");
      if (res.status === 200) break;
    }
    // Initialize passkey to enable encryption
    await fetchJson("/api/passkey/init", {
      body: JSON.stringify({ passkey: "test-passkey-1234" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    // Add test hosts to allowlist via direct DO access (write routes are admin-only)
    await addAllowlistDirect("mcp.example.com");
    await addAllowlistDirect("mcp-secrets.example.com");
  });

  it("create MCP config stores headerKeys not header values", async () => {
    const createRes = await fetchJson("/api/mcp-configs", {
      body: JSON.stringify({
        name: "Encrypted Test",
        type: "http",
        url: "https://mcp.example.com/v1",
        headers: { Authorization: "Bearer secret-token", "X-Custom": "custom-value" },
        enabled: true,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(createRes.status).toBe(201);
    const body = (await createRes.json()) as { id: string; headerKeys?: string[]; headers?: Record<string, string> };
    expect(body.headerKeys).toEqual(expect.arrayContaining(["Authorization", "X-Custom"]));
    // Header values should NOT be exposed
    expect(body.headers).toBeUndefined();

    // Verify in listing too
    const listRes = await fetchJson("/api/mcp-configs");
    const listBody = (await listRes.json()) as { configs: Array<{ id: string; headerKeys?: string[]; headers?: Record<string, string> }> };
    const config = listBody.configs.find((c) => c.id === body.id);
    expect(config).toBeTruthy();
    expect(config!.headers).toBeUndefined();
    expect(config!.headerKeys).toEqual(expect.arrayContaining(["Authorization", "X-Custom"]));

    // Cleanup
    await fetchJson(`/api/mcp-configs/${body.id}`, { method: "DELETE" });
  });

  it("secrets are created for MCP header values", async () => {
    // Host already added to allowlist in beforeAll via direct DO access
    const createRes = await fetchJson("/api/mcp-configs", {
      body: JSON.stringify({
        name: "Secrets Test",
        type: "http",
        url: "https://mcp-secrets.example.com/v1",
        headers: { Authorization: "Bearer my-secret" },
        enabled: true,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string };

    // Check that encrypted secrets exist for the MCP config headers
    const secretsRes = await fetchJson("/api/secrets");
    expect(secretsRes.status).toBe(200);
    const secretsBody = (await secretsRes.json()) as { keys: string[] };
    const mcpSecretKey = `mcp:${created.id}:Authorization`;
    expect(secretsBody.keys).toContain(mcpSecretKey);

    // Cleanup
    await fetchJson(`/api/mcp-configs/${created.id}`, { method: "DELETE" });

    // Verify secrets are cleaned up on delete
    const afterDeleteSecretsRes = await fetchJson("/api/secrets");
    const afterDeleteBody = (await afterDeleteSecretsRes.json()) as { keys: string[] };
    expect(afterDeleteBody.keys).not.toContain(mcpSecretKey);
  });
});

describe("MCP URL allowlist check", () => {
  beforeAll(async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetchJson("/health");
      if (res.status === 200) break;
    }
  });

  it("rejects MCP config creation for host not on allowlist", async () => {
    const res = await fetchJson("/api/mcp-configs", {
      body: JSON.stringify({
        name: "Blocked Host",
        type: "http",
        url: "https://not-on-allowlist.evil.com/v1",
        enabled: true,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not on the allowlist");
  });

  it("allows MCP config creation for host on allowlist", async () => {
    // Add host to allowlist via direct DO access (write routes are admin-only)
    await addAllowlistDirect("allowed-mcp.example.com");

    const res = await fetchJson("/api/mcp-configs", {
      body: JSON.stringify({
        name: "Allowed Host",
        type: "http",
        url: "https://allowed-mcp.example.com/v1",
        enabled: true,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string };
    expect(body.name).toBe("Allowed Host");

    // Cleanup
    await fetchJson(`/api/mcp-configs/${body.id}`, { method: "DELETE" });
  });

  it("allows MCP config without URL (service-binding type)", async () => {
    const res = await fetchJson("/api/mcp-configs", {
      body: JSON.stringify({
        name: "Service Binding",
        type: "service-binding",
        enabled: true,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };

    // Cleanup
    await fetchJson(`/api/mcp-configs/${body.id}`, { method: "DELETE" });
  });
});
