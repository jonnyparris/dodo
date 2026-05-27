import { describe, expect, it } from "vitest";
import {
  chatMonitorIdName,
  createMonitorSchema,
  parseChatGetMessagesResult,
} from "../src/chat-monitor-agent";

describe("createMonitorSchema", () => {
  it("accepts a valid input", () => {
    const parsed = createMonitorSchema.parse({
      ownerEmail: "ruskin@cloudflare.com",
      spaceId: "spaces/AAAA08q6ZPc",
      persona: "Reply when addressed by name.",
      pollIntervalSeconds: 30,
    });
    expect(parsed.pollIntervalSeconds).toBe(30);
  });

  it("rejects a malformed spaceId", () => {
    const result = createMonitorSchema.safeParse({
      ownerEmail: "ruskin@cloudflare.com",
      spaceId: "AAAA08q6ZPc",
      persona: "x",
      pollIntervalSeconds: 30,
    });
    expect(result.success).toBe(false);
  });

  it("rejects polling below the 10s floor", () => {
    const result = createMonitorSchema.safeParse({
      ownerEmail: "ruskin@cloudflare.com",
      spaceId: "spaces/AAAA",
      persona: "x",
      pollIntervalSeconds: 5,
    });
    expect(result.success).toBe(false);
  });

  it("defaults pollIntervalSeconds when omitted", () => {
    const parsed = createMonitorSchema.parse({
      ownerEmail: "ruskin@cloudflare.com",
      spaceId: "spaces/AAAA",
      persona: "x",
    });
    expect(parsed.pollIntervalSeconds).toBe(10);
  });
});

describe("chatMonitorIdName", () => {
  it("lowercases the owner email", () => {
    expect(chatMonitorIdName("Ruskin@Cloudflare.com", "spaces/AAAA")).toBe(
      "ruskin@cloudflare.com:spaces/AAAA",
    );
  });

  it("produces stable ids", () => {
    expect(chatMonitorIdName("a@b.com", "spaces/X")).toBe(
      chatMonitorIdName("a@b.com", "spaces/X"),
    );
  });
});

describe("parseChatGetMessagesResult", () => {
  it("returns [] for empty content", () => {
    expect(parseChatGetMessagesResult([])).toEqual([]);
    expect(parseChatGetMessagesResult([{ type: "text", text: "" }])).toEqual([]);
  });

  it("returns [] for unparseable JSON", () => {
    expect(
      parseChatGetMessagesResult([{ type: "text", text: "not json" }]),
    ).toEqual([]);
  });

  it("extracts messages from { messages: [...] }", () => {
    const payload = {
      messages: [
        {
          name: "spaces/AAA/messages/M1.T1",
          text: "hello world",
          createTime: "2026-05-27T10:00:00Z",
          sender: { displayName: "Alice" },
          thread: { name: "spaces/AAA/threads/T1" },
        },
        {
          name: "spaces/AAA/messages/M2.T1",
          text: "follow-up",
          createTime: "2026-05-27T10:01:00Z",
          sender: { displayName: "Bob" },
          thread: { name: "spaces/AAA/threads/T1" },
        },
      ],
    };
    const parsed = parseChatGetMessagesResult([
      { type: "text", text: JSON.stringify(payload) },
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      name: "spaces/AAA/messages/M1.T1",
      text: "hello world",
      senderDisplay: "Alice",
      createTime: "2026-05-27T10:00:00Z",
      threadName: "spaces/AAA/threads/T1",
    });
    expect(parsed[1].senderDisplay).toBe("Bob");
  });

  it("tolerates missing optional fields", () => {
    const payload = {
      messages: [
        {
          name: "spaces/AAA/messages/M1.T1",
          createTime: "2026-05-27T10:00:00Z",
        },
      ],
    };
    const parsed = parseChatGetMessagesResult([
      { type: "text", text: JSON.stringify(payload) },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe("");
    expect(parsed[0].senderDisplay).toBe("Unknown");
    expect(parsed[0].threadName).toBeUndefined();
  });

  it("skips entries with no name or createTime", () => {
    const payload = {
      messages: [
        { text: "no name" },
        { name: "spaces/AAA/messages/X", text: "no createTime" },
        {
          name: "spaces/AAA/messages/M1.T1",
          createTime: "2026-05-27T10:00:00Z",
          text: "ok",
        },
      ],
    };
    const parsed = parseChatGetMessagesResult([
      { type: "text", text: JSON.stringify(payload) },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("spaces/AAA/messages/M1.T1");
  });

  it("handles cf-portal's { result: { messages } } wrapper", () => {
    const payload = {
      result: {
        messages: [
          {
            name: "spaces/AAA/messages/M1",
            createTime: "2026-05-27T10:00:00Z",
            text: "wrapped",
            sender: { displayName: "Carol" },
          },
        ],
      },
    };
    const parsed = parseChatGetMessagesResult([
      { type: "text", text: JSON.stringify(payload) },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe("wrapped");
  });
});
