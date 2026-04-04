/**
 * Regression tests for token waste reduction.
 *
 * Tests cover:
 * - Session initialization with system prompt
 * - Session lifecycle (creation, deletion)
 * - File operations and search
 * - Context budget reporting
 * - Large file handling
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env } from "../src/types";

vi.mock("../src/executor", () => ({
  runSandboxedCode: vi.fn().mockResolvedValue({ logs: [], result: null }),
}));

vi.mock("../src/agentic", () => ({
  buildToolsForThink: vi.fn().mockReturnValue({}),
  buildProvider: vi.fn().mockReturnValue({
    chatModel: vi.fn().mockReturnValue({}),
  }),
}));

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
      await new Promise((r) => setTimeout(r, 10));
      continue;
    }
    throw new Error(`Failed to create session: ${response.status}`);
  }
  throw new Error("Failed to create session after retries");
}

describe("Token waste reduction", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await fetchJson("/api/config", {
      body: JSON.stringify({ activeGateway: "opencode", model: "claude-test" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
  });

  describe("Session initialization", () => {
    it("session initializes correctly with system prompt", async () => {
      const sessionId = await createSession();
      expect(sessionId).toBeTruthy();

      const stateRes = await fetchJson(`/session/${sessionId}`);
      expect(stateRes.status).toBe(200);
      const state = (await stateRes.json()) as { status: string; contextWindow: number };
      expect(state.status).toBe("idle");
      expect(state.contextWindow).toBeGreaterThan(0);
    });
  });

  describe("Session lifecycle", () => {
    it("file operations work on initialized session", async () => {
      const sessionId = await createSession();
      const writeRes = await fetchJson(`/session/${sessionId}/file?path=/test.txt`, {
        body: JSON.stringify({ content: "lifecycle test" }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      expect(writeRes.status).toBe(200);
    });

    it("session deletion makes it inaccessible", async () => {
      const sessionId = await createSession();

      await fetchJson(`/session/${sessionId}/file?path=/test.txt`, {
        body: JSON.stringify({ content: "to be deleted" }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });

      const deleteRes = await fetchJson(`/session/${sessionId}`, { method: "DELETE" });
      expect(deleteRes.status).toBe(200);

      const afterDelete = await fetchJson(`/session/${sessionId}/files?path=/`);
      expect(afterDelete.status).toBe(403);
    });
  });

  describe("Feature flags", () => {
    it("session with default flags can process file operations", async () => {
      const sessionId = await createSession();

      // Write a large-ish file
      const bigContent = "line\n".repeat(500);
      const writeRes = await fetchJson(`/session/${sessionId}/file?path=/big.txt`, {
        body: JSON.stringify({ content: bigContent }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      expect(writeRes.status).toBe(200);

      // Read it back
      const readRes = await fetchJson(`/session/${sessionId}/file?path=/big.txt`);
      expect(readRes.status).toBe(200);
      const body = (await readRes.json()) as { content: string };
      expect(body.content).toBe(bigContent);
    });

    it("search works on large workspaces", async () => {
      const sessionId = await createSession();

      // Create multiple files
      for (let i = 0; i < 10; i++) {
        await fetchJson(`/session/${sessionId}/file?path=/src/file${i}.ts`, {
          body: JSON.stringify({ content: `export const value${i} = ${i};\n` }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        });
      }

      // Search across them
      const searchRes = await fetchJson(`/session/${sessionId}/search`, {
        body: JSON.stringify({ pattern: "/src/**/*.ts", query: "value" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(searchRes.status).toBe(200);
      const searchBody = (await searchRes.json()) as { matches: Array<{ path: string }> };
      expect(searchBody.matches.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe("Token usage reporting", () => {
    it("session state includes context window info from the start", async () => {
      const sessionId = await createSession();

      // Context info is available via the session state endpoint
      const stateRes = await fetchJson(`/session/${sessionId}`);
      expect(stateRes.status).toBe(200);
      const state = (await stateRes.json()) as {
        contextWindow: number;
        contextBudget: number;
        contextUsagePercent: number;
        totalTokenInput: number;
        totalTokenOutput: number;
      };

      expect(state.contextWindow).toBeGreaterThan(0);
      expect(state.contextBudget).toBeGreaterThan(0);
      expect(state.contextBudget).toBeLessThan(state.contextWindow);
      expect(typeof state.contextUsagePercent).toBe("number");
      expect(typeof state.totalTokenInput).toBe("number");
      expect(typeof state.totalTokenOutput).toBe("number");
    });
  });

  describe("Context management", () => {
    it("session state includes context budget information", async () => {
      const sessionId = await createSession();

      const stateRes = await fetchJson(`/session/${sessionId}`);
      expect(stateRes.status).toBe(200);
      const state = (await stateRes.json()) as {
        contextBudget: number;
        contextUsagePercent: number;
        contextWindow: number;
      };

      expect(state.contextWindow).toBeGreaterThan(0);
      expect(state.contextBudget).toBeGreaterThan(0);
      expect(typeof state.contextUsagePercent).toBe("number");
    });

    it("context budget is 80% of context window", async () => {
      const sessionId = await createSession();

      const stateRes = await fetchJson(`/session/${sessionId}`);
      const state = (await stateRes.json()) as {
        contextBudget: number;
        contextWindow: number;
      };

      // Budget should be 80% of window (CONTEXT_BUDGET_FACTOR = 0.8)
      const expectedBudget = Math.floor(state.contextWindow * 0.8);
      expect(state.contextBudget).toBe(expectedBudget);
    });

    it("large file writes don't crash the session", async () => {
      const sessionId = await createSession();

      // Write a 100KB file (simulating what would trigger truncation in assembleContext)
      const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}: ${"x".repeat(30)}`);
      const bigContent = lines.join("\n");
      expect(bigContent.length).toBeGreaterThan(100_000);

      const writeRes = await fetchJson(`/session/${sessionId}/file?path=/large-file.ts`, {
        body: JSON.stringify({ content: bigContent }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      expect(writeRes.status).toBe(200);

      // Verify the file was stored correctly
      const readRes = await fetchJson(`/session/${sessionId}/file?path=/large-file.ts`);
      expect(readRes.status).toBe(200);
      const readBody = (await readRes.json()) as { content: string };
      expect(readBody.content.length).toBe(bigContent.length);
    });

    it("session survives rapid file operations without context corruption", async () => {
      const sessionId = await createSession();

      // Write 20 files rapidly to stress the workspace and context tracking
      const writes = Array.from({ length: 20 }, (_, i) =>
        fetchJson(`/session/${sessionId}/file?path=/rapid/file${i}.ts`, {
          body: JSON.stringify({ content: `export const x${i} = ${i};\n`.repeat(50) }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        }),
      );
      const results = await Promise.all(writes);
      for (const r of results) {
        expect(r.status).toBe(200);
      }

      // Session state should still be healthy
      const stateRes = await fetchJson(`/session/${sessionId}`);
      expect(stateRes.status).toBe(200);
      const state = (await stateRes.json()) as { status: string; contextWindow: number };
      expect(state.status).toBe("idle");
      expect(state.contextWindow).toBeGreaterThan(0);
    });
  });
});
