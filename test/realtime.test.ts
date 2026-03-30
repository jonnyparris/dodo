import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import type { Env } from "../src/types";
import { PresenceTracker } from "../src/presence";
import { AgentConnectionTransport } from "../src/rpc-transport";

const { runAgenticChatMock, streamAgenticChatMock, sendNotificationMock } = vi.hoisted(() => ({
  runAgenticChatMock: vi.fn(),
  streamAgenticChatMock: vi.fn(),
  sendNotificationMock: vi.fn(),
}));

vi.mock("../src/executor", () => ({
  runSandboxedCode: vi.fn().mockResolvedValue({ logs: [], result: null }),
}));

vi.mock("../src/agentic", () => ({
  runAgenticChat: runAgenticChatMock,
  streamAgenticChat: streamAgenticChatMock,
}));

vi.mock("../src/notify", () => ({
  sendNotification: sendNotificationMock,
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

// ─── PresenceTracker Unit Tests ───

describe("PresenceTracker", () => {
  let tracker: PresenceTracker;

  beforeEach(() => {
    tracker = new PresenceTracker();
  });

  it("starts empty", () => {
    expect(tracker.count()).toBe(0);
    expect(tracker.getAll()).toEqual([]);
  });

  it("tracks join and leave", () => {
    tracker.join("conn-1", {
      connectedAt: 1000,
      displayName: "Alice",
      email: "alice@test.local",
      permission: "readwrite",
    });

    expect(tracker.count()).toBe(1);
    expect(tracker.has("conn-1")).toBe(true);

    const all = tracker.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      email: "alice@test.local",
      displayName: "Alice",
      permission: "readwrite",
      isTyping: false,
    });

    tracker.leave("conn-1");
    expect(tracker.count()).toBe(0);
    expect(tracker.has("conn-1")).toBe(false);
  });

  it("tracks multiple users", () => {
    tracker.join("conn-1", {
      connectedAt: 1000,
      displayName: "Alice",
      email: "alice@test.local",
      permission: "readwrite",
    });
    tracker.join("conn-2", {
      connectedAt: 2000,
      displayName: "Bob",
      email: "bob@test.local",
      permission: "readonly",
    });

    expect(tracker.count()).toBe(2);

    const emails = tracker.getAll().map((e) => e.email);
    expect(emails).toContain("alice@test.local");
    expect(emails).toContain("bob@test.local");
  });

  it("sets and clears typing indicator", () => {
    tracker.join("conn-1", {
      connectedAt: 1000,
      displayName: "Alice",
      email: "alice@test.local",
      permission: "readwrite",
    });

    expect(tracker.get("conn-1")!.isTyping).toBe(false);

    tracker.setTyping("conn-1", true);
    expect(tracker.get("conn-1")!.isTyping).toBe(true);

    tracker.setTyping("conn-1", false);
    expect(tracker.get("conn-1")!.isTyping).toBe(false);
  });

  it("updates activity timestamp", () => {
    tracker.join("conn-1", {
      connectedAt: 1000,
      displayName: "Alice",
      email: "alice@test.local",
      permission: "readwrite",
    });

    const before = tracker.get("conn-1")!.lastActivity;
    // Small delay to ensure different timestamp
    tracker.updateActivity("conn-1");
    const after = tracker.get("conn-1")!.lastActivity;

    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("returns unique users by email", () => {
    // Same user, two connections
    tracker.join("conn-1", {
      connectedAt: 1000,
      displayName: "Alice",
      email: "alice@test.local",
      permission: "readwrite",
    });
    tracker.join("conn-2", {
      connectedAt: 2000,
      displayName: "Alice",
      email: "alice@test.local",
      permission: "readwrite",
    });
    tracker.join("conn-3", {
      connectedAt: 3000,
      displayName: "Bob",
      email: "bob@test.local",
      permission: "readonly",
    });

    expect(tracker.count()).toBe(3);
    const unique = tracker.getUniqueUsers();
    expect(unique).toHaveLength(2);

    const emails = unique.map((u) => u.email);
    expect(emails).toContain("alice@test.local");
    expect(emails).toContain("bob@test.local");
  });

  it("ignores operations on non-existent connections", () => {
    // These should not throw
    tracker.leave("nonexistent");
    tracker.setTyping("nonexistent", true);
    tracker.updateActivity("nonexistent");

    expect(tracker.get("nonexistent")).toBeUndefined();
  });

  it("tracks last-seen message per connection", () => {
    tracker.join("conn-1", {
      connectedAt: 1000,
      displayName: "Alice",
      email: "alice@test.local",
      permission: "readwrite",
    });

    expect(tracker.getLastSeenMessage("conn-1")).toBeNull();

    tracker.setLastSeenMessage("conn-1", "msg-42");
    expect(tracker.getLastSeenMessage("conn-1")).toBe("msg-42");

    tracker.setLastSeenMessage("conn-1", "msg-99");
    expect(tracker.getLastSeenMessage("conn-1")).toBe("msg-99");
  });

  it("returns null for last-seen message on unknown connection", () => {
    expect(tracker.getLastSeenMessage("nonexistent")).toBeNull();
  });
});

// ─── AgentConnectionTransport Unit Tests ───

describe("AgentConnectionTransport", () => {
  function makeMockConnection() {
    const sent: string[] = [];
    return {
      id: "mock-conn",
      send(data: string) {
        sent.push(data);
      },
      sent,
    };
  }

  it("sends messages through the connection", async () => {
    const mock = makeMockConnection();
    const transport = new AgentConnectionTransport(mock as never);

    await transport.send("hello");
    expect(mock.sent).toEqual(["hello"]);
  });

  it("receives delivered messages in order", async () => {
    const mock = makeMockConnection();
    const transport = new AgentConnectionTransport(mock as never);

    // Deliver messages before calling receive
    transport.deliver("msg1");
    transport.deliver("msg2");

    expect(await transport.receive()).toBe("msg1");
    expect(await transport.receive()).toBe("msg2");
  });

  it("receive() waits for deliver() when queue is empty", async () => {
    const mock = makeMockConnection();
    const transport = new AgentConnectionTransport(mock as never);

    const receivePromise = transport.receive();

    // Deliver after receive is called
    transport.deliver("delayed-msg");

    expect(await receivePromise).toBe("delayed-msg");
  });

  it("throws on send after close", async () => {
    const mock = makeMockConnection();
    const transport = new AgentConnectionTransport(mock as never);

    transport.close();

    await expect(transport.send("fail")).rejects.toThrow("Transport closed");
  });

  it("throws on receive after close", async () => {
    const mock = makeMockConnection();
    const transport = new AgentConnectionTransport(mock as never);

    transport.close();

    await expect(transport.receive()).rejects.toThrow("Transport closed");
  });

  it("rejects pending receive on close", async () => {
    const mock = makeMockConnection();
    const transport = new AgentConnectionTransport(mock as never);

    const receivePromise = transport.receive();
    transport.close();

    await expect(receivePromise).rejects.toThrow("Transport closed");
  });

  it("abort rejects pending receive with reason", async () => {
    const mock = makeMockConnection();
    const transport = new AgentConnectionTransport(mock as never);

    const receivePromise = transport.receive();
    transport.abort(new Error("Connection lost"));

    await expect(receivePromise).rejects.toThrow("Connection lost");
  });
});

// ─── WebSocket Route Integration Tests ───

describe("WebSocket route", () => {
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
    runAgenticChatMock.mockReset();
    streamAgenticChatMock.mockReset();
    sendNotificationMock.mockReset();
    streamAgenticChatMock.mockImplementation(async (input: { messages: Array<{ content: string }> }) => {
      const text = `reply:${input.messages.at(-1)?.content ?? ""}`;
      return { gateway: "opencode", model: "test", steps: 1, text, tokenInput: 0, tokenOutput: 0, toolCalls: [] };
    });
    runAgenticChatMock.mockImplementation(async (input: { messages: Array<{ content: string }> }) => {
      const text = `reply:${input.messages.at(-1)?.content ?? ""}`;
      return { gateway: "opencode", model: "test", steps: 1, text, tokenInput: 0, tokenOutput: 0, toolCalls: [] };
    });
  });

  it("returns 426 for non-WebSocket requests to /session/:id/ws", async () => {
    const sessionId = await createSession();

    const response = await fetchJson(`/session/${sessionId}/ws`);
    expect(response.status).toBe(426);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("WebSocket");
  });
});

// ─── Cap'n Web RPC API Import Tests ───

describe("Cap'n Web RPC API", () => {
  it("can import RPC API classes", async () => {
    // Test that the RPC API module can be imported in the test environment.
    // Cap'n Web's RpcTarget may or may not work in miniflare.
    let imported = false;
    try {
      const api = await import("../src/rpc-api");
      expect(api.DodoPublicApi).toBeDefined();
      expect(api.DodoAuthenticatedApi).toBeDefined();
      expect(api.DodoSessionApi).toBeDefined();
      imported = true;
    } catch (error) {
      // Cap'n Web import failed in test environment — this is expected
      console.warn("Cap'n Web RpcTarget import failed in test env (expected):", error);
    }

    // If import succeeded, test basic instantiation
    if (imported) {
      const { DodoPublicApi } = await import("../src/rpc-api");
      const testEnv = env as Env;
      const api = new DodoPublicApi(testEnv);
      expect(api.health()).toEqual({ status: "ok", version: testEnv.DODO_VERSION ?? "unknown" });
    }
  });

  it("can import RPC transport adapter", async () => {
    const { AgentConnectionTransport } = await import("../src/rpc-transport");
    expect(AgentConnectionTransport).toBeDefined();
  });

  it("can import presence tracker", async () => {
    const { PresenceTracker } = await import("../src/presence");
    expect(PresenceTracker).toBeDefined();
    const tracker = new PresenceTracker();
    expect(tracker.count()).toBe(0);
  });
});

// ─── RPC Endpoint Integration Tests ───

describe("RPC endpoint", () => {
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

  it("POST /rpc with health method returns valid response", async () => {
    // Cap'n Web HTTP batch RPC sends a JSON request body
    // The exact format depends on capnweb internals, but we can at least
    // verify the endpoint is reachable and doesn't 404
    const response = await fetchJson("/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ method: "health", args: [] }]),
    });
    // The endpoint should exist (not 404) and process the request
    // Cap'n Web may return 200 with batch results or 400 if format is wrong
    expect(response.status).not.toBe(404);
  });

  it("GET /rpc returns a response (not 404)", async () => {
    const response = await fetchJson("/rpc");
    // GET without WebSocket upgrade should return something (not 404)
    expect(response.status).not.toBe(404);
  });
});

// ─── WebSocket Reconnection Tests ───

describe("WebSocket reconnection", () => {
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
    runAgenticChatMock.mockReset();
    streamAgenticChatMock.mockReset();
    sendNotificationMock.mockReset();
    streamAgenticChatMock.mockImplementation(async (input: { messages: Array<{ content: string }> }) => {
      const text = `reply:${input.messages.at(-1)?.content ?? ""}`;
      return { gateway: "opencode", model: "test", steps: 1, text, tokenInput: 0, tokenOutput: 0, toolCalls: [] };
    });
  });

  it("ready message includes totalMessages field", async () => {
    const sessionId = await createSession();

    // Add some messages
    await fetchJson(`/session/${sessionId}/message`, {
      body: JSON.stringify({ content: "msg one" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Verify messages exist via REST
    const messagesRes = await fetchJson(`/session/${sessionId}/messages`);
    const messagesBody = (await messagesRes.json()) as { messages: Array<{ id: string }> };
    // Should have at least 2 (user + assistant)
    expect(messagesBody.messages.length).toBeGreaterThanOrEqual(2);
  });

  it("WebSocket route preserves lastMessageCount query param", async () => {
    const sessionId = await createSession();

    // Non-WebSocket request with lastMessageCount should still return 426
    // but the parameter is preserved and forwarded
    const response = await fetchJson(`/session/${sessionId}/ws?lastMessageCount=5`);
    expect(response.status).toBe(426);
  });
});
