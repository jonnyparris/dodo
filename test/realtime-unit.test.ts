/**
 * Pure unit tests for PresenceTracker and AgentConnectionTransport.
 * Extracted from realtime.test.ts to avoid importing the main worker module.
 * See: https://github.com/cloudflare/workers-sdk/issues/13191
 */
import { beforeEach, describe, expect, it } from "vitest";
import { PresenceTracker } from "../src/presence";
import { AgentConnectionTransport } from "../src/rpc-transport";

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
    tracker.updateActivity("conn-1");
    const after = tracker.get("conn-1")!.lastActivity;

    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("ignores operations on non-existent connections", () => {
    tracker.leave("nonexistent");
    tracker.setTyping("nonexistent", true);
    tracker.updateActivity("nonexistent");

    expect(tracker.get("nonexistent")).toBeUndefined();
  });

  it("can import PresenceTracker and AgentConnectionTransport", () => {
    expect(PresenceTracker).toBeDefined();
    expect(AgentConnectionTransport).toBeDefined();
    const t = new PresenceTracker();
    expect(t.count()).toBe(0);
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

    transport.deliver("msg1");
    transport.deliver("msg2");

    expect(await transport.receive()).toBe("msg1");
    expect(await transport.receive()).toBe("msg2");
  });

  it("receive() waits for deliver() when queue is empty", async () => {
    const mock = makeMockConnection();
    const transport = new AgentConnectionTransport(mock as never);

    const receivePromise = transport.receive();
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
