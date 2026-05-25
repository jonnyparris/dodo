import { describe, expect, it } from "vitest";
import { resolveLogsConfig } from "../src/cloudflare-logs";
import type { Env } from "../src/types";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    CLOUDFLARE_API_TOKEN: undefined,
    CLOUDFLARE_ACCOUNT_ID: undefined,
    DODO_WORKER_NAME: undefined,
    ...overrides,
  } as Env;
}

describe("resolveLogsConfig", () => {
  it("returns not_configured when token is missing", () => {
    const result = resolveLogsConfig(makeEnv({
      CLOUDFLARE_ACCOUNT_ID: "acct",
      DODO_WORKER_NAME: "dodo",
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_configured");
      expect(result.message).toContain("CLOUDFLARE_API_TOKEN");
    }
  });

  it("returns not_configured when account id is missing", () => {
    const result = resolveLogsConfig(makeEnv({
      CLOUDFLARE_API_TOKEN: "token",
      DODO_WORKER_NAME: "dodo",
    }));
    expect(result.ok).toBe(false);
  });

  it("returns not_configured when worker name is missing", () => {
    const result = resolveLogsConfig(makeEnv({
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_ACCOUNT_ID: "acct",
    }));
    expect(result.ok).toBe(false);
  });

  it("returns ok when all three are set", () => {
    const result = resolveLogsConfig(makeEnv({
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      DODO_WORKER_NAME: "dodo",
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.apiToken).toBe("token");
      expect(result.accountId).toBe("acct");
      expect(result.workerName).toBe("dodo");
    }
  });

  it("trims whitespace", () => {
    const result = resolveLogsConfig(makeEnv({
      CLOUDFLARE_API_TOKEN: "  token  ",
      CLOUDFLARE_ACCOUNT_ID: " acct ",
      DODO_WORKER_NAME: " dodo ",
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.apiToken).toBe("token");
      expect(result.accountId).toBe("acct");
      expect(result.workerName).toBe("dodo");
    }
  });

  it("treats empty strings as not configured", () => {
    const result = resolveLogsConfig(makeEnv({
      CLOUDFLARE_API_TOKEN: "",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      DODO_WORKER_NAME: "dodo",
    }));
    expect(result.ok).toBe(false);
  });
});
