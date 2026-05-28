import { describe, expect, it } from "vitest";
import {
  buildBrainGoalText,
  chatMonitorIdName,
  createMonitorSchema,
  extractMessageText,
  findChatGetMessagesTool,
  parseChatGetMessagesResult,
  parseCommandSenders,
  pickCfPortalConfig,
  SENDER_RESOURCE_PATTERN,
  sha256Prefix,
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

  it("rejects polling below the 1s floor", () => {
    // MIN_POLL_INTERVAL_SECONDS was lowered to 1 in commit 1bfc930 to allow
    // tight test loops. 0 (and negatives) still rejects.
    const result = createMonitorSchema.safeParse({
      ownerEmail: "ruskin@cloudflare.com",
      spaceId: "spaces/AAAA",
      persona: "x",
      pollIntervalSeconds: 0,
    });
    expect(result.success).toBe(false);
  });

  it("defaults pollIntervalSeconds when omitted", () => {
    const parsed = createMonitorSchema.parse({
      ownerEmail: "ruskin@cloudflare.com",
      spaceId: "spaces/AAAA",
      persona: "x",
    });
    expect(parsed.pollIntervalSeconds).toBe(15);
  });

  it("accepts valid commandSenders entries", () => {
    const parsed = createMonitorSchema.parse({
      ownerEmail: "a@b.com",
      spaceId: "spaces/AAAA",
      persona: "x",
      commandSenders: ["users/106320663698754747363", "users/200"],
    });
    expect(parsed.commandSenders).toHaveLength(2);
  });

  it("defaults commandSenders to empty array", () => {
    const parsed = createMonitorSchema.parse({
      ownerEmail: "a@b.com",
      spaceId: "spaces/AAAA",
      persona: "x",
    });
    expect(parsed.commandSenders).toEqual([]);
  });

  it("rejects malformed sender resource names", () => {
    const result = createMonitorSchema.safeParse({
      ownerEmail: "a@b.com",
      spaceId: "spaces/AAAA",
      persona: "x",
      commandSenders: ["alice@example.com"], // not a users/<digits>
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than 20 commandSenders", () => {
    const result = createMonitorSchema.safeParse({
      ownerEmail: "a@b.com",
      spaceId: "spaces/AAAA",
      persona: "x",
      commandSenders: Array.from({ length: 21 }, (_, i) => `users/${i}`),
    });
    expect(result.success).toBe(false);
  });

  it("defaults contextMode to 'off'", () => {
    const parsed = createMonitorSchema.parse({
      ownerEmail: "a@b.com",
      spaceId: "spaces/AAAA",
      persona: "x",
    });
    expect(parsed.contextMode).toBe("off");
  });

  it("accepts contextMode 'recent'", () => {
    const parsed = createMonitorSchema.parse({
      ownerEmail: "a@b.com",
      spaceId: "spaces/AAAA",
      persona: "x",
      contextMode: "recent",
    });
    expect(parsed.contextMode).toBe("recent");
  });

  it("rejects an unknown contextMode value", () => {
    const result = createMonitorSchema.safeParse({
      ownerEmail: "a@b.com",
      spaceId: "spaces/AAAA",
      persona: "x",
      contextMode: "unbounded",
    });
    expect(result.success).toBe(false);
  });
});

describe("buildBrainGoalText", () => {
  it("names the space and the allowlisted command senders", () => {
    const goal = buildBrainGoalText({
      spaceId: "spaces/AAAA",
      persona: "Be helpful.",
      commandSenders: ["users/111", "users/222"],
      contextMode: "off",
    });
    expect(goal).toContain("spaces/AAAA");
    expect(goal).toContain("users/111");
    expect(goal).toContain("users/222");
    expect(goal).toContain("Be helpful.");
  });

  it("notes that no senders are configured when allowlist is empty", () => {
    const goal = buildBrainGoalText({
      spaceId: "spaces/AAAA",
      persona: "x",
      commandSenders: [],
      contextMode: "off",
    });
    expect(goal).toMatch(/none/);
  });

  it("describes the background-forwarding behaviour when contextMode is recent", () => {
    const goal = buildBrainGoalText({
      spaceId: "spaces/AAAA",
      persona: "x",
      commandSenders: ["users/1"],
      contextMode: "recent",
    });
    expect(goal).toContain("[Background]");
  });

  it("describes the off behaviour when contextMode is off", () => {
    const goal = buildBrainGoalText({
      spaceId: "spaces/AAAA",
      persona: "x",
      commandSenders: ["users/1"],
      contextMode: "off",
    });
    expect(goal).toContain("only ever see prompts from allowlisted");
  });

  it("emphasises that chat_reply is the only way to post", () => {
    const goal = buildBrainGoalText({
      spaceId: "spaces/AAAA",
      persona: "x",
      commandSenders: ["users/1"],
      contextMode: "off",
    });
    expect(goal).toContain("chat_reply");
    expect(goal).toContain("ONLY");
  });
});

describe("SENDER_RESOURCE_PATTERN", () => {
  it("matches valid resource names", () => {
    expect(SENDER_RESOURCE_PATTERN.test("users/106320663698754747363")).toBe(true);
    expect(SENDER_RESOURCE_PATTERN.test("users/1")).toBe(true);
  });

  it("rejects other shapes", () => {
    expect(SENDER_RESOURCE_PATTERN.test("user/123")).toBe(false);
    expect(SENDER_RESOURCE_PATTERN.test("users/abc")).toBe(false);
    expect(SENDER_RESOURCE_PATTERN.test("alice@example.com")).toBe(false);
  });
});

describe("sha256Prefix", () => {
  it("returns empty string for empty input", async () => {
    expect(await sha256Prefix("")).toBe("");
  });

  it("is deterministic", async () => {
    const a = await sha256Prefix("hello world");
    const b = await sha256Prefix("hello world");
    expect(a).toBe(b);
  });

  it("returns a 16-character hex prefix", async () => {
    const h = await sha256Prefix("test message");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("matches the known SHA-256 prefix of 'hello'", async () => {
    // SHA-256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(await sha256Prefix("hello")).toBe("2cf24dba5fb0a30e");
  });

  it("produces different hashes for different inputs", async () => {
    const a = await sha256Prefix("pingbot ping");
    const b = await sha256Prefix("pongbot pong");
    expect(a).not.toBe(b);
  });
});

describe("parseCommandSenders", () => {
  it("parses a valid JSON array", () => {
    expect(parseCommandSenders('["users/1","users/2"]')).toEqual(["users/1", "users/2"]);
  });

  it("returns [] for null / undefined / empty string", () => {
    expect(parseCommandSenders(null)).toEqual([]);
    expect(parseCommandSenders(undefined)).toEqual([]);
    expect(parseCommandSenders("")).toEqual([]);
  });

  it("returns [] for malformed JSON", () => {
    expect(parseCommandSenders("not json")).toEqual([]);
  });

  it("returns [] when payload is not an array", () => {
    expect(parseCommandSenders('{"foo":"bar"}')).toEqual([]);
  });

  it("filters out non-string entries", () => {
    expect(parseCommandSenders('["users/1",42,null,"users/2"]')).toEqual([
      "users/1",
      "users/2",
    ]);
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
          sender: { name: "users/100", type: "HUMAN" },
          thread: { name: "spaces/AAA/threads/T1" },
        },
        {
          name: "spaces/AAA/messages/M2.T1",
          text: "follow-up",
          createTime: "2026-05-27T10:01:00Z",
          sender: { name: "users/200", type: "BOT" },
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
      senderResource: "users/100",
      senderType: "HUMAN",
      createTime: "2026-05-27T10:00:00Z",
      threadName: "spaces/AAA/threads/T1",
    });
    expect(parsed[1].senderResource).toBe("users/200");
    expect(parsed[1].senderType).toBe("BOT");
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
    expect(parsed[0].senderResource).toBe("");
    expect(parsed[0].senderType).toBe("UNKNOWN");
    expect(parsed[0].threadName).toBeUndefined();
  });

  it("normalises unknown sender.type to UNKNOWN", () => {
    const payload = {
      messages: [
        {
          name: "spaces/AAA/messages/M1.T1",
          createTime: "2026-05-27T10:00:00Z",
          sender: { name: "users/x", type: "weird-type" },
        },
      ],
    };
    const parsed = parseChatGetMessagesResult([
      { type: "text", text: JSON.stringify(payload) },
    ]);
    expect(parsed[0].senderType).toBe("UNKNOWN");
  });

  it("uppercases mixed-case sender.type", () => {
    const payload = {
      messages: [
        {
          name: "spaces/AAA/messages/M1.T1",
          createTime: "2026-05-27T10:00:00Z",
          sender: { name: "users/x", type: "human" },
        },
      ],
    };
    const parsed = parseChatGetMessagesResult([
      { type: "text", text: JSON.stringify(payload) },
    ]);
    expect(parsed[0].senderType).toBe("HUMAN");
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

describe("extractMessageText", () => {
  it("reads plain text from a typed message", () => {
    expect(extractMessageText({ text: "hello" })).toBe("hello");
  });

  it("falls back to formattedText when text is missing", () => {
    expect(extractMessageText({ formattedText: "**hi**" })).toBe("**hi**");
  });

  it("falls back to argumentText", () => {
    expect(extractMessageText({ argumentText: "do thing" })).toBe("do thing");
  });

  it("pulls text out of a card sent by ARIA (textParagraph)", () => {
    const msg = {
      cardsV2: [
        {
          card: {
            sections: [
              { widgets: [{ textParagraph: { text: "pingbot ping" } }] },
            ],
          },
        },
      ],
    };
    expect(extractMessageText(msg)).toBe("pingbot ping");
  });

  it("includes header title + subtitle plus body widgets", () => {
    const msg = {
      cardsV2: [
        {
          card: {
            header: { title: "Release", subtitle: "v0.4.1" },
            sections: [
              { widgets: [{ textParagraph: { text: "Deploy complete" } }] },
            ],
          },
        },
      ],
    };
    expect(extractMessageText(msg)).toBe("Release\nv0.4.1\nDeploy complete");
  });

  it("handles decoratedText widgets", () => {
    const msg = {
      cardsV2: [
        {
          card: {
            sections: [
              {
                widgets: [
                  { decoratedText: { topLabel: "Status", text: "OK", bottomLabel: "Updated 3s ago" } },
                ],
              },
            ],
          },
        },
      ],
    };
    expect(extractMessageText(msg)).toBe("Status\nOK\nUpdated 3s ago");
  });

  it("dedupes adjacent identical strings", () => {
    const msg = { text: "hi", formattedText: "hi" };
    // direct text wins; formattedText is only tried as fallback
    expect(extractMessageText(msg)).toBe("hi");
  });

  it("returns empty string when no text fields exist", () => {
    expect(extractMessageText({})).toBe("");
    expect(extractMessageText({ cardsV2: [] })).toBe("");
  });

  it("combines direct text with card content", () => {
    const msg = {
      text: "from a user",
      cardsV2: [
        {
          card: { sections: [{ widgets: [{ textParagraph: { text: "and from a card" } }] }] },
        },
      ],
    };
    expect(extractMessageText(msg)).toBe("from a user\nand from a card");
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
