import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  planNotification,
  sendNotification,
  type NotificationInput,
  type UserNotificationConfig,
} from "../src/notify";
import type { Env } from "../src/types";

/**
 * Targets the ntfy delivery branch of `sendNotification` to verify
 * three things:
 *
 *   1. The publish URL respects `channel.baseUrl` when set
 *      (used by self-hosted ntfy-compatible workers).
 *   2. When `baseUrl` is absent, the legacy default `https://ntfy.sh`
 *      is used — keeps existing public-ntfy users on the happy path.
 *   3. When `channel.token` is set, the request carries
 *      `Authorization: Bearer <token>`; when it is not, the header
 *      is absent.
 */
describe("sendNotification → ntfy URL and auth", () => {
  const baseInput: NotificationInput = {
    kind: "prompt-complete",
    title: "Dodo: test done",
    body: "All good",
    priority: "default",
  };
  const env = {} as Env;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to https://ntfy.sh when no baseUrl is configured", async () => {
    const config: UserNotificationConfig = {
      channels: [{ type: "ntfy", topic: "my-topic" }],
    };
    const plan = planNotification(baseInput, config);
    await sendNotification(plan, env);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://ntfy.sh/my-topic");
  });

  it("posts to the configured baseUrl when one is set", async () => {
    const config: UserNotificationConfig = {
      channels: [
        {
          type: "ntfy",
          topic: "my-topic",
          baseUrl: "https://ntfy-worker.example.workers.dev",
        },
      ],
    };
    const plan = planNotification(baseInput, config);
    await sendNotification(plan, env);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://ntfy-worker.example.workers.dev/my-topic",
    );
  });

  it("strips trailing slashes from baseUrl", async () => {
    const config: UserNotificationConfig = {
      channels: [
        {
          type: "ntfy",
          topic: "t",
          baseUrl: "https://example.com///",
        },
      ],
    };
    const plan = planNotification(baseInput, config);
    await sendNotification(plan, env);
    expect(fetchMock.mock.calls[0][0]).toBe("https://example.com/t");
  });

  it("sends Authorization: Bearer when a token is set", async () => {
    const config: UserNotificationConfig = {
      channels: [
        {
          type: "ntfy",
          topic: "t",
          baseUrl: "https://example.com",
          token: "supersecret",
        },
      ],
    };
    const plan = planNotification(baseInput, config);
    await sendNotification(plan, env);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer supersecret");
  });

  it("omits Authorization when no token is set", async () => {
    const config: UserNotificationConfig = {
      channels: [{ type: "ntfy", topic: "t", baseUrl: "https://example.com" }],
    };
    const plan = planNotification(baseInput, config);
    await sendNotification(plan, env);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});
