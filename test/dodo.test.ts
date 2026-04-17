import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env } from "../src/types";
import { releaseMockSlowPrompt, resetMockAgentic } from "./helpers/agentic-mock";

const { runSandboxedCodeMock, sendNotificationMock } = vi.hoisted(() => ({
  runSandboxedCodeMock: vi.fn(),
  sendNotificationMock: vi.fn(),
}));

vi.mock("../src/executor", () => ({
  runSandboxedCode: runSandboxedCodeMock,
}));

vi.mock("../src/agentic", async () => await import("./helpers/agentic-mock"));

vi.mock("../src/notify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/notify")>();
  return {
    ...actual,
    sendNotification: sendNotificationMock,
  };
});

import { sendRunNotification } from "../src/notify";
import worker from "../src/index";

const BASE_URL = "https://dodo.example";

async function fetchJson(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, init), env as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function fetchWithoutWaiting(path: string, init?: RequestInit): Promise<{ ctx: ExecutionContext; response: Response }> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, init), env as Env, ctx);
  return { ctx, response };
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

async function eventually(assertion: () => Promise<void>, attempts = 20): Promise<void> {
  let lastError: unknown;

  for (let index = 0; index < attempts; index += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  throw lastError;
}

describe("Dodo foundation", () => {
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

  beforeEach(async () => {
    vi.restoreAllMocks();
    resetMockAgentic();
    runSandboxedCodeMock.mockReset();
    runSandboxedCodeMock.mockResolvedValue({ logs: ["sandbox ok"], result: { updated: true } });
    sendNotificationMock.mockReset();

    await fetchJson("/api/config", {
      body: JSON.stringify({ activeGateway: "opencode", model: "claude-test" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
  });

  it("creates a session, stores messages, and returns the assistant reply", async () => {
    const sessionId = await createSession();

    const messageResponse = await fetchJson(`/session/${sessionId}/message`, {
      body: JSON.stringify({ content: "Ship the Phase 1 foundation." }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(messageResponse.status).toBe(200);
    const messageData = (await messageResponse.json()) as {
      gateway: string;
      message: { content: string; role: string };
    };

    expect(messageData.gateway).toBe("opencode");
    expect(messageData.message.role).toBe("assistant");
    expect(messageData.message.content).toContain("opencode:Ship the Phase 1 foundation.");

    const messagesResponse = await fetchJson(`/session/${sessionId}/messages`);
    const messages = (await messagesResponse.json()) as {
      messages: Array<{ content: string; role: string }>;
    };

    expect(messages.messages).toHaveLength(2);
    expect(messages.messages[0]).toMatchObject({ content: "Ship the Phase 1 foundation.", role: "user" });
    expect(messages.messages[1].role).toBe("assistant");
  });

  it("allowlist write routes require admin", async () => {
    // POST /api/allowlist requires admin — non-admin gets 403
    const allowlistCreate = await fetchJson("/api/allowlist", {
      body: JSON.stringify({ hostname: "example.com" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(allowlistCreate.status).toBe(403);

    // DELETE /api/allowlist/:hostname requires admin — non-admin gets 403
    const allowlistDelete = await fetchJson("/api/allowlist/example.com", { method: "DELETE" });
    expect(allowlistDelete.status).toBe(403);

    // Add via direct DO access for subsequent read test
    const testEnv = env as Env;
    const stub = testEnv.SHARED_INDEX.get(testEnv.SHARED_INDEX.idFromName("global"));
    await stub.fetch("https://shared-index/allowlist", {
      body: JSON.stringify({ hostname: "example.com" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // GET /api/allowlist is still accessible to authenticated users
    const allowlistRead = await fetchJson("/api/allowlist");
    expect(allowlistRead.status).toBe(200);
    const allowlist = (await allowlistRead.json()) as { hosts: Array<{ hostname: string }> };
    expect(allowlist.hosts).toEqual(expect.arrayContaining([expect.objectContaining({ hostname: "example.com" })]));
  });

  it("manages memory entries", async () => {
    const memoryCreate = await fetchJson("/api/memory", {
      body: JSON.stringify({ content: "Remember to deploy Dodo", tags: ["ops"], title: "Deploy note" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(memoryCreate.status).toBe(201);
    const createdMemory = (await memoryCreate.json()) as { id: string; title: string };

    const memorySearch = await fetchJson("/api/memory?q=deploy");
    const memoryEntries = (await memorySearch.json()) as { entries: Array<{ id: string; title: string }> };
    expect(memoryEntries.entries).toEqual(expect.arrayContaining([expect.objectContaining({ id: createdMemory.id, title: "Deploy note" })]));
  });

  it("supports workspace file CRUD, search, and edit operations", async () => {
    const sessionId = await createSession();

    const writeResponse = await fetchJson(`/session/${sessionId}/file?path=/notes/todo.txt`, {
      body: JSON.stringify({ content: "ship dodo phase 2" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    expect(writeResponse.status).toBe(200);

    const listResponse = await fetchJson(`/session/${sessionId}/files?path=/notes`);
    const listBody = (await listResponse.json()) as { entries: Array<{ path: string; type: string }> };
    expect(listBody.entries).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/notes/todo.txt", type: "file" })]));

    const searchResponse = await fetchJson(`/session/${sessionId}/search`, {
      body: JSON.stringify({ pattern: "/notes/**/*.txt", query: "phase 2" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const searchBody = (await searchResponse.json()) as { matches: Array<{ path: string }> };
    expect(searchBody.matches).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/notes/todo.txt" })]));

    const patchResponse = await fetchJson(`/session/${sessionId}/file?path=/notes/todo.txt`, {
      body: JSON.stringify({ replacement: "phase 3", search: "phase 2" }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    expect(patchResponse.status).toBe(200);

    const readResponse = await fetchJson(`/session/${sessionId}/file?path=/notes/todo.txt`);
    const readBody = (await readResponse.json()) as { content: string };
    expect(readBody.content).toContain("phase 3");

    const deleteResponse = await fetchJson(`/session/${sessionId}/file?path=/notes/todo.txt`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(200);
  });

  it("executes sandboxed code against the workspace tools", async () => {
    const sessionId = await createSession();

    await fetchJson(`/session/${sessionId}/file?path=/src/demo.ts`, {
      body: JSON.stringify({ content: "export const value = 'old';" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });

    runSandboxedCodeMock.mockImplementationOnce(async ({ code, workspace }) => {
      expect(code).toContain("state.readFile");
      const before = await workspace.readFile("/src/demo.ts");
      await workspace.writeFile("/src/demo.ts", String(before).replace("old", "new"));
      return {
        logs: ["sandbox ok"],
        result: await workspace.readFile("/src/demo.ts"),
      };
    });

    const executeResponse = await fetchJson(`/session/${sessionId}/execute`, {
      body: JSON.stringify({ code: "async () => { const text = await state.readFile('/src/demo.ts'); await state.writeFile('/src/demo.ts', text.replace('old', 'new')); return await state.readFile('/src/demo.ts'); }" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(executeResponse.status).toBe(200);
    const execution = (await executeResponse.json()) as { logs: string[]; result: string };
    expect(execution.logs).toEqual(["sandbox ok"]);
    expect(execution.result).toContain("new");

    const readResponse = await fetchJson(`/session/${sessionId}/file?path=/src/demo.ts`);
    const readBody = (await readResponse.json()) as { content: string };
    expect(readBody.content).toContain("new");
  });

  it("supports git init, add, commit, log, and diff flows", async () => {
    const sessionId = await createSession();

    const initResponse = await fetchJson(`/session/${sessionId}/git/init`, {
      body: JSON.stringify({ dir: "/repo" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(initResponse.status).toBe(200);

    await fetchJson(`/session/${sessionId}/file?path=/repo/README.md`, {
      body: JSON.stringify({ content: "# Dodo\n" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });

    const addResponse = await fetchJson(`/session/${sessionId}/git/add`, {
      body: JSON.stringify({ dir: "/repo", filepath: "." }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(addResponse.status).toBe(200);

    const commitResponse = await fetchJson(`/session/${sessionId}/git/commit`, {
      body: JSON.stringify({ dir: "/repo", message: "Initial commit" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(commitResponse.status).toBe(200);

    const logResponse = await fetchJson(`/session/${sessionId}/git/log?dir=/repo&depth=5`);
    const logBody = (await logResponse.json()) as { entries: Array<{ message: string }> };
    expect(logBody.entries[0]?.message).toContain("Initial commit");

    await fetchJson(`/session/${sessionId}/file?path=/repo/README.md`, {
      body: JSON.stringify({ content: "# Dodo\n\nUpdated\n" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    const diffResponse = await fetchJson(`/session/${sessionId}/git/diff?dir=/repo`);
    const diffBody = (await diffResponse.json()) as { entries: Array<{ filepath: string }> };
    expect(diffBody.entries).toEqual(expect.arrayContaining([expect.objectContaining({ filepath: "README.md" })]));
  });

  it("switches gateway configuration on the fly", async () => {
    const initialConfig = await fetchJson("/api/config");
    const initial = (await initialConfig.json()) as { activeGateway: string };
    expect(initial.activeGateway).toBe("opencode");

    const updatedConfig = await fetchJson("/api/config", {
      body: JSON.stringify({ activeGateway: "ai-gateway", model: "claude-phase-1" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    const updated = (await updatedConfig.json()) as { activeGateway: string; model: string };
    expect(updated.activeGateway).toBe("ai-gateway");
    expect(updated.model).toBe("claude-phase-1");

    const sessionId = await createSession();

    const messageResponse = await fetchJson(`/session/${sessionId}/message`, {
      body: JSON.stringify({ content: "Use the fallback gateway now." }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = (await messageResponse.json()) as { gateway: string; message: { content: string } };

    expect(body.gateway).toBe("ai-gateway");
    expect(body.message.content).toContain("ai-gateway:Use the fallback gateway now.");
  });

  it.skip("supports async prompts and aborting a running prompt — vitest-pool-workers can't release promises across DO boundaries", async () => {
    const sessionId = await createSession();

    const promptStart = await fetchWithoutWaiting(`/session/${sessionId}/prompt`, {
      body: JSON.stringify({ content: "slow async prompt" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(promptStart.response.status).toBe(202);
    const promptBody = (await promptStart.response.json()) as { promptId: string; status: string };
    expect(promptBody.status).toBe("queued");

    await eventually(async () => {
      const abortResponse = await fetchJson(`/session/${sessionId}/abort`, { method: "POST" });
      expect(abortResponse.status).toBe(200);
    });
    releaseMockSlowPrompt();
    await waitOnExecutionContext(promptStart.ctx);

    await eventually(async () => {
      const promptsResponse = await fetchJson(`/session/${sessionId}/prompts`);
      const prompts = (await promptsResponse.json()) as { prompts: Array<{ id: string; status: string }> };
      expect(prompts.prompts[0]).toMatchObject({ id: promptBody.promptId, status: "aborted" });
    });
  });

  it("supports cron job creation/listing/deletion", async () => {
    const sessionId = await createSession();

    const createResponse = await fetchJson(`/session/${sessionId}/cron`, {
      body: JSON.stringify({ delayInSeconds: 120, description: "Follow up later", prompt: "Check the repo status", type: "delayed" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { id: string; description: string };
    expect(created.description).toBe("Follow up later");

    const listResponse = await fetchJson(`/session/${sessionId}/cron`);
    const jobs = (await listResponse.json()) as { jobs: Array<{ id: string; description: string }> };
    expect(jobs.jobs).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id, description: "Follow up later" })]));

    const deleteResponse = await fetchJson(`/session/${sessionId}/cron/${created.id}`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(200);
  });

  it("can fork a session with messages and files", async () => {
    const sourceId = await createSession();

    await fetchJson(`/session/${sourceId}/file?path=/src/original.txt`, {
      body: JSON.stringify({ content: "hello fork" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    await fetchJson(`/session/${sourceId}/message`, {
      body: JSON.stringify({ content: "Fork me" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    const forkResponse = await fetchJson(`/session/${sourceId}/fork`, { method: "POST" });
    expect(forkResponse.status).toBe(201);
    const forked = (await forkResponse.json()) as { id: string; sourceId: string };
    expect(forked.sourceId).toBe(sourceId);

    const fileResponse = await fetchJson(`/session/${forked.id}/file?path=/src/original.txt`);
    const forkedFile = (await fileResponse.json()) as { content: string };
    expect(forkedFile.content).toBe("hello fork");

    const messagesResponse = await fetchJson(`/session/${forked.id}/messages`);
    const messages = (await messagesResponse.json()) as { messages: Array<{ content: string }> };
    expect(messages.messages.some((message) => message.content === "Fork me")).toBe(true);
  });

  it("exposes an SSE endpoint for session events", async () => {
    const sessionId = await createSession();

    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${BASE_URL}/session/${sessionId}/events`), env as Env, ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await response.body?.cancel();
  });

  it("rejects path traversal attempts", async () => {
    const sessionId = await createSession();

    const traversalResponse = await fetchJson(`/session/${sessionId}/file?path=/../../../etc/passwd`);
    expect(traversalResponse.status).toBe(400);
    const body = (await traversalResponse.json()) as { error: string };
    expect(body.error).toContain("traversal");
  });

  it("rejects deleting the workspace root", async () => {
    const sessionId = await createSession();

    const deleteRoot = await fetchJson(`/session/${sessionId}/file?path=/`, { method: "DELETE" });
    expect(deleteRoot.status).toBe(400);
    const body = (await deleteRoot.json()) as { error: string };
    expect(body.error).toContain("root");
  });

  it.skip("returns 409 when a prompt is already running — vitest-pool-workers can't release promises across DO boundaries", async () => {
    const sessionId = await createSession();

    const firstPrompt = await fetchWithoutWaiting(`/session/${sessionId}/prompt`, {
      body: JSON.stringify({ content: "slow async prompt" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(firstPrompt.response.status).toBe(202);

    const secondPrompt = await fetchJson(`/session/${sessionId}/prompt`, {
      body: JSON.stringify({ content: "another prompt" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(secondPrompt.status).toBe(202);
    const body = (await secondPrompt.json()) as { status: string; promptId: string; position: number };
    expect(body.status).toBe("queued");
    expect(body.promptId).toBeTruthy();
    expect(body.position).toBeGreaterThanOrEqual(1);

    releaseMockSlowPrompt();
    await waitOnExecutionContext(firstPrompt.ctx);
  });

  it("returns 502 when LLM call fails", async () => {
    const sessionId = await createSession();

    // Note: This test requires a mock LLM provider that rejects.
    // The real code path goes through Think.chat() → onChatMessage() → streamText().
    // Without a proper LLM mock, this test verifies the error handling path.
    const response = await fetchJson(`/session/${sessionId}/message`, {
      body: JSON.stringify({ content: "This should fail" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    // The mock returns an error stream part. The own-loop catches it and
    // throws, which surfaces as a 502. The error text may be the stream
    // error or a generic "No output generated" depending on timing.
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("rejects invalid JSON bodies with 400", async () => {
    const sessionId = await createSession();

    const response = await fetchJson(`/session/${sessionId}/message`, {
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(400);
  });

  it("cleans up storage on session delete", async () => {
    const sessionId = await createSession();

    await fetchJson(`/session/${sessionId}/file?path=/data.txt`, {
      body: JSON.stringify({ content: "to be deleted" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    await fetchJson(`/session/${sessionId}/message`, {
      body: JSON.stringify({ content: "before delete" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    const deleteResponse = await fetchJson(`/session/${sessionId}`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(200);

    // After deletion, the session is removed from UserControl, so subsequent
    // access is denied by the ownership check (403)
    const messagesResponse = await fetchJson(`/session/${sessionId}/messages`);
    expect(messagesResponse.status).toBe(403);
  });

  it("returns CORS headers on responses", async () => {
    const response = await fetchJson("/health");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("serves models list and status endpoint", async () => {
    const modelsResponse = await fetchJson("/api/models");
    expect(modelsResponse.status).toBe(200);
    const modelsBody = (await modelsResponse.json()) as { models: Array<{ id: string; name: string }> };
    expect(Array.isArray(modelsBody.models)).toBe(true);

    const statusResponse = await fetchJson("/api/status");
    expect(statusResponse.status).toBe(200);
    const statusBody = (await statusResponse.json()) as { version: string; sessionCount: number };
    expect(statusBody.version).toBeTruthy();
    expect(typeof statusBody.sessionCount).toBe("number");
  });

  it("supports task CRUD operations", async () => {
    const createResponse = await fetchJson("/api/tasks", {
      body: JSON.stringify({ title: "Fix the file tree", description: "Expand directories", priority: "high" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(createResponse.status).toBe(201);
    const task = (await createResponse.json()) as { id: string; title: string; status: string; priority: string };
    expect(task.title).toBe("Fix the file tree");
    expect(task.status).toBe("backlog");
    expect(task.priority).toBe("high");

    const updateResponse = await fetchJson(`/api/tasks/${task.id}`, {
      body: JSON.stringify({ status: "in_progress" }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    expect(updateResponse.status).toBe(200);
    const updated = (await updateResponse.json()) as { status: string };
    expect(updated.status).toBe("in_progress");

    const listResponse = await fetchJson("/api/tasks");
    const tasks = (await listResponse.json()) as { tasks: Array<{ id: string }> };
    expect(tasks.tasks.some((t) => t.id === task.id)).toBe(true);

    const deleteResponse = await fetchJson(`/api/tasks/${task.id}`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(200);
  });

  it("includes token totals in session state", async () => {
    const sessionId = await createSession();

    await fetchJson(`/session/${sessionId}/message`, {
      body: JSON.stringify({ content: "Track my tokens" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    const stateResponse = await fetchJson(`/session/${sessionId}`);
    const state = (await stateResponse.json()) as { totalTokenInput: number; totalTokenOutput: number };
    expect(typeof state.totalTokenInput).toBe("number");
    expect(typeof state.totalTokenOutput).toBe("number");
  });

  it("rejects MCP requests without a valid token", async () => {
    const response = await fetchJson("/mcp", {
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } } }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(401);
  });

  it("accepts MCP requests with a valid Bearer token and lists tools", async () => {
    const mcpHeaders = { "content-type": "application/json", "Authorization": "Bearer test-mcp-token", "Accept": "application/json, text/event-stream" };

    const initResponse = await fetchJson("/mcp", {
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } } }),
      headers: mcpHeaders,
      method: "POST",
    });
    expect(initResponse.status).toBe(200);

    // Parse session ID from SSE response
    const initText = await initResponse.text();
    const sessionMatch = initResponse.headers.get("mcp-session-id");

    // Extract session ID from init response headers
    const toolsHeaders: Record<string, string> = { ...mcpHeaders };
    if (sessionMatch) {
      toolsHeaders["mcp-session-id"] = sessionMatch;
    }

    // Send initialized notification (required by MCP protocol)
    await fetchJson("/mcp", {
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      headers: toolsHeaders,
      method: "POST",
    });

    const toolsResponse = await fetchJson("/mcp", {
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2 }),
      headers: toolsHeaders,
      method: "POST",
    });
    expect(toolsResponse.status).toBe(200);

    // Response may be SSE (text/event-stream) — parse data lines
    const toolsText = await toolsResponse.text();
    const dataLines = toolsText.split("\n").filter((l: string) => l.startsWith("data: "));
    let toolNames: string[] = [];
    for (const line of dataLines) {
      try {
        const parsed = JSON.parse(line.slice(6)) as { result?: { tools?: Array<{ name: string }> } };
        if (parsed.result?.tools) {
          toolNames = parsed.result.tools.map((t) => t.name);
        }
      } catch { /* skip non-JSON data lines */ }
    }

    expect(toolNames).toContain("list_sessions");
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("send_message");
    expect(toolNames).toContain("git_status");
    expect(toolNames).toContain("memory_search");
    expect(toolNames).toContain("list_tasks");
    expect(toolNames).toContain("create_task");
    expect(toolNames.length).toBeGreaterThanOrEqual(20);
  });

  it("sends a notification on sync message completion", async () => {
    const sessionId = await createSession();

    await fetchJson(`/session/${sessionId}/message`, {
      body: JSON.stringify({ content: "Notify me" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(sendNotificationMock).toHaveBeenCalled();
    const call = sendNotificationMock.mock.calls[0];
    expect(call[2].title).toContain("Dodo:");
    expect(call[2].body).toBeTruthy();
  });

  it("sends a notification on LLM failure", async () => {
    const sessionId = await createSession();

    // Note: This test requires a mock LLM provider that rejects.
    await fetchJson(`/session/${sessionId}/message`, {
      body: JSON.stringify({ content: "This will fail" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(sendNotificationMock).toHaveBeenCalled();
    const call = sendNotificationMock.mock.calls[0];
    expect(call[2].title).toContain("failed");
    expect(call[2].tags).toContain("x");
  });
});

describe("Worker run notifications", () => {
  const baseRun = {
    baseBranch: "main",
    branch: "feat/run-notifications",
    commitMessage: null,
    createdAt: "2026-04-17T00:00:00.000Z",
    expectedFiles: [],
    failureSnapshotId: null,
    id: "run-1",
    lastError: null,
    parentSessionId: null,
    repoDir: "/tmp/repo",
    repoId: "repo-1",
    repoUrl: "https://github.com/example/repo",
    sessionId: "session-1",
    strategy: "agent" as const,
    title: "Ship notifications",
    updatedAt: "2026-04-17T00:00:00.000Z",
    verification: null,
  };

  it("fires ntfy when a run transitions to done", () => {
    sendNotificationMock.mockClear();

    sendRunNotification(env as Env, { waitUntil: vi.fn() }, {
      ...baseRun,
      status: "done",
    }, "push_verified", "owner@example.com");

    expect(sendNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        ownerEmail: "owner@example.com",
        tags: expect.stringContaining("white_check_mark"),
        title: expect.stringContaining("done"),
      }),
    );
  });

  it("fires ntfy when a run transitions to failed", () => {
    sendNotificationMock.mockClear();

    sendRunNotification(env as Env, { waitUntil: vi.fn() }, {
      ...baseRun,
      failureSnapshotId: "snapshot-1",
      lastError: "boom",
      status: "failed",
    }, "prompt_running", "owner@example.com");

    expect(sendNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        ownerEmail: "owner@example.com",
        priority: "high",
        tags: expect.stringContaining("x"),
        title: expect.stringContaining("failed"),
      }),
    );
  });

  it("does not fire ntfy for non-terminal status changes", () => {
    sendNotificationMock.mockClear();

    sendRunNotification(env as Env, { waitUntil: vi.fn() }, {
      ...baseRun,
      status: "repo_ready",
    }, "session_created", "owner@example.com");

    expect(sendNotificationMock).not.toHaveBeenCalled();
  });
});
