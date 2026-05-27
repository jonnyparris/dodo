import { describe, expect, it } from "vitest";
import {
  chatMonitorIdName,
  createMonitorSchema,
  findChatGetMessagesTool,
  parseChatGetMessagesResult,
  pickCfPortalConfig,
} from "../src/chat-monitor-agent";
import type { McpClientConfig } from "../src/mcp-client";

function mkCfg(over: Partial<McpClientConfig>): McpClientConfig {
  return {
    id: "abc",
    name: "x",
    type: "http",
    auth_type: "refresh_token",
    enabled: true,
    ...over,
  } as McpClientConfig;
}

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

  it("handles a top-level object that doesn't match either shape", () => {
    expect(
      parseChatGetMessagesResult([
        { type: "text", text: JSON.stringify({ unrelated: true }) },
      ]),
    ).toEqual([]);
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

describe("pickCfPortalConfig", () => {
  it("prefers the canonical portal URL over the codemode variant", () => {
    const cfg = pickCfPortalConfig([
      mkCfg({ id: "1", url: "https://portal.mcp.cfdata.org/mcp?codemode=search_and_execute" }),
      mkCfg({ id: "2", url: "https://portal.mcp.cfdata.org/mcp" }),
    ]);
    expect(cfg?.id).toBe("2");
  });

  it("returns the canonical match when it's the only one", () => {
    const cfg = pickCfPortalConfig([
      mkCfg({ id: "only", url: "https://portal.mcp.cfdata.org/mcp" }),
    ]);
    expect(cfg?.id).toBe("only");
  });

  it("falls back to a non-codemode portal URL via substring", () => {
    const cfg = pickCfPortalConfig([
      mkCfg({ id: "x", url: "https://portal.mcp.cfdata.org/mcp/variant" }),
    ]);
    expect(cfg?.id).toBe("x");
  });

  it("ignores codemode-only URLs when no canonical match exists", () => {
    const cfg = pickCfPortalConfig([
      mkCfg({ id: "x", url: "https://portal.mcp.cfdata.org/mcp?codemode=search_and_execute" }),
    ]);
    expect(cfg).toBeNull();
  });

  it("returns null when no portal config is present", () => {
    expect(
      pickCfPortalConfig([
        mkCfg({ id: "other", url: "https://example.com/mcp" }),
      ]),
    ).toBeNull();
  });

  it("ignores static_header configs even if URL matches", () => {
    const cfg = pickCfPortalConfig([
      mkCfg({ id: "static", url: "https://portal.mcp.cfdata.org/mcp/static", auth_type: "static_headers" }),
    ]);
    // The canonical-URL preference goes by URL only, but the substring fallback
    // requires refresh_token. Since neither URL is canonical, this should fall
    // through to the fallback and reject the static_header config.
    expect(cfg).toBeNull();
  });
});

describe("findChatGetMessagesTool", () => {
  it("matches single-underscore separator (cf-portal style)", () => {
    const tools = [
      { name: "abc__google-workspace-mcp_chat_get_messages" },
      { name: "abc__google-workspace-mcp_chat_search_messages" },
    ];
    const hit = findChatGetMessagesTool(tools);
    expect(hit?.name).toBe("abc__google-workspace-mcp_chat_get_messages");
  });

  it("prefers a trailing `_chat_get_messages` over a bare `chat_get_messages`", () => {
    const tools = [
      { name: "weirdchat_get_messages" }, // bare suffix, ambiguous
      { name: "abc__google-workspace-mcp_chat_get_messages" },
    ];
    const hit = findChatGetMessagesTool(tools);
    expect(hit?.name).toBe("abc__google-workspace-mcp_chat_get_messages");
  });

  it("falls back to bare suffix when no underscored variant exists", () => {
    const hit = findChatGetMessagesTool([{ name: "foo.bar.chat_get_messages" }]);
    expect(hit?.name).toBe("foo.bar.chat_get_messages");
  });

  it("returns null when nothing matches", () => {
    expect(findChatGetMessagesTool([{ name: "search" }, { name: "execute" }])).toBeNull();
  });
});
