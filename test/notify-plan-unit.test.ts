import { describe, expect, it } from "vitest";
import { planNotification, type NotificationInput, type UserNotificationConfig } from "../src/notify";

describe("planNotification", () => {
  const baseInput: NotificationInput = {
    kind: "prompt-complete",
    title: "Dodo: test done",
    body: "All good",
    priority: "default",
    tags: "white_check_mark,robot",
    ownerEmail: "owner@example.com",
  };

  it("uses per-kind priority from config when present", () => {
    const config: UserNotificationConfig = {
      channels: [{ type: "ntfy", topic: "test-topic" }],
      priorities: { "prompt-complete": "high" },
    };
    const plan = planNotification(baseInput, config);
    expect(plan.perChannelMessages).toHaveLength(1);
    expect(plan.perChannelMessages[0].priority).toBe("high");
  });

  it("falls back to input priority when no per-kind mapping exists", () => {
    const config: UserNotificationConfig = {
      channels: [{ type: "ntfy", topic: "test-topic" }],
    };
    const plan = planNotification({ ...baseInput, priority: "low" }, config);
    expect(plan.perChannelMessages[0].priority).toBe("low");
  });

  it("falls back to default priority when neither input nor config specify one", () => {
    const config: UserNotificationConfig = {
      channels: [{ type: "ntfy", topic: "test-topic" }],
    };
    const input: NotificationInput = { ...baseInput, priority: undefined };
    const plan = planNotification(input, config);
    expect(plan.perChannelMessages[0].priority).toBe("default");
  });

  it("skips webhook channels when priority is below minPriority", () => {
    const config: UserNotificationConfig = {
      channels: [
        { type: "ntfy", topic: "test-topic" },
        {
          type: "webhook",
          id: "wh-1",
          url: "https://example.com/hook",
          headers: { "Content-Type": "application/json" },
          bodyTemplate: '{"msg":"{{title}}"}',
          minPriority: "high",
        },
      ],
    };
    const plan = planNotification({ ...baseInput, priority: "low" }, config);
    expect(plan.perChannelMessages).toHaveLength(1);
    expect(plan.perChannelMessages[0].channel.type).toBe("ntfy");
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].channelType).toBe("webhook");
    expect(plan.skipped[0].channelId).toBe("wh-1");
    expect(plan.skipped[0].reason).toContain("low");
    expect(plan.skipped[0].reason).toContain("high");
  });

  it("includes webhook channels when priority meets minPriority", () => {
    const config: UserNotificationConfig = {
      channels: [
        {
          type: "webhook",
          id: "wh-1",
          url: "https://example.com/hook",
          headers: { "Content-Type": "application/json" },
          bodyTemplate: '{"msg":"{{title}}"}',
          minPriority: "default",
        },
      ],
    };
    const plan = planNotification({ ...baseInput, priority: "high" }, config);
    expect(plan.perChannelMessages).toHaveLength(1);
    expect(plan.skipped).toHaveLength(0);
  });

  it("renders webhook templates with input fields substituted", () => {
    const config: UserNotificationConfig = {
      channels: [
        {
          type: "webhook",
          id: "wh-1",
          url: "https://example.com/hook",
          headers: { "Content-Type": "application/json" },
          bodyTemplate: '{"title":"{{title}}","body":"{{body}}","pri":"{{priority}}"}',
        },
      ],
    };
    const plan = planNotification(baseInput, config);
    expect(plan.perChannelMessages).toHaveLength(1);
    const parsed = JSON.parse(plan.perChannelMessages[0].body);
    expect(parsed.title).toBe("Dodo: test done");
    expect(parsed.body).toBe("All good");
    expect(parsed.pri).toBe("default");
  });

  it("JSON-escapes template values for JSON content type", () => {
    const config: UserNotificationConfig = {
      channels: [
        {
          type: "webhook",
          id: "wh-1",
          url: "https://example.com/hook",
          headers: { "Content-Type": "application/json" },
          bodyTemplate: '{"body":"{{body}}"}',
        },
      ],
    };
    const input: NotificationInput = { ...baseInput, body: 'has "quotes"' };
    const plan = planNotification(input, config);
    const parsed = JSON.parse(plan.perChannelMessages[0].body);
    expect(parsed.body).toBe('has "quotes"');
  });

  it("does not escape when content type is not JSON", () => {
    const config: UserNotificationConfig = {
      channels: [
        {
          type: "webhook",
          id: "wh-1",
          url: "https://example.com/hook",
          headers: { "Content-Type": "text/plain" },
          bodyTemplate: "Body: {{body}}",
          contentType: "text/plain",
        },
      ],
    };
    const input: NotificationInput = { ...baseInput, body: 'has "quotes"' };
    const plan = planNotification(input, config);
    expect(plan.perChannelMessages[0].body).toBe('Body: has "quotes"');
  });

  it("passes ntfy fields through unchanged", () => {
    const config: UserNotificationConfig = {
      channels: [{ type: "ntfy", topic: "my-topic" }],
    };
    const input: NotificationInput = {
      kind: "prompt-error",
      title: "Dodo: fail",
      body: "oops",
      priority: "high",
      tags: "x,robot",
      url: "https://example.com/run/123",
    };
    const plan = planNotification(input, config);
    expect(plan.perChannelMessages).toHaveLength(1);
    const msg = plan.perChannelMessages[0];
    expect(msg.channel.type).toBe("ntfy");
    expect(msg.title).toBe("Dodo: fail");
    expect(msg.body).toBe("oops");
    expect(msg.priority).toBe("high");
    expect(msg.tags).toBe("x,robot");
    expect(msg.url).toBe("https://example.com/run/123");
  });

  it("returns empty plan when no channels are configured", () => {
    const config: UserNotificationConfig = { channels: [] };
    const plan = planNotification(baseInput, config);
    expect(plan.perChannelMessages).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
  });

  it("plans messages for multiple channels independently", () => {
    const config: UserNotificationConfig = {
      channels: [
        { type: "ntfy", topic: "topic-a" },
        { type: "ntfy", topic: "topic-b" },
        {
          type: "webhook",
          id: "wh-1",
          url: "https://a.com",
          headers: {},
          bodyTemplate: "a",
        },
      ],
    };
    const plan = planNotification(baseInput, config);
    expect(plan.perChannelMessages).toHaveLength(3);
    expect(plan.skipped).toHaveLength(0);
  });
});
