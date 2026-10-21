import { describe, expect, it, vi } from "vitest";
import { buildOAuthMcpTools } from "../src/agentic";
import {
  detectOAuthStepUp,
  isOAuthStepUpMarker,
  isUnauthorizedError,
  OAUTH_STEP_UP_KEY,
  scopeFromAuthUrl,
  stepUpReason,
  stepUpToolResult,
} from "../src/mcp-step-up";

const AUTH_URL = "https://mcp.example.com/authorize?client_id=c1&state=n2.srv&scope=user%3Aread+account%3Aread+workers_scripts%3Awrite";

class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

describe("isUnauthorizedError", () => {
  it("matches UnauthorizedError, 401 status and wrapped causes", () => {
    expect(isUnauthorizedError(new UnauthorizedError())).toBe(true);
    expect(isUnauthorizedError(Object.assign(new Error("x"), { status: 401 }))).toBe(true);
    expect(isUnauthorizedError(new Error("wrapped", { cause: new UnauthorizedError() }))).toBe(true);
  });
  it("ignores other failures", () => {
    expect(isUnauthorizedError(new Error("Server returned 500"))).toBe(false);
    expect(isUnauthorizedError(Object.assign(new Error("Forbidden"), { status: 403 }))).toBe(false);
    expect(isUnauthorizedError(null)).toBe(false);
  });
});

describe("detectOAuthStepUp", () => {
  const base = { serverId: "srv", serverName: "Cloudflare API", authUrlBefore: undefined };
  it("returns the new authorize URL and its scopes", () => {
    const s = detectOAuthStepUp({ ...base, error: new UnauthorizedError(), authUrlAfter: AUTH_URL });
    expect(s).toEqual({ serverId: "srv", serverName: "Cloudflare API", authUrl: AUTH_URL, scope: "user:read account:read workers_scripts:write" });
  });
  it("ignores a URL left over from the original connect", () => {
    expect(detectOAuthStepUp({ ...base, authUrlBefore: AUTH_URL, error: new UnauthorizedError(), authUrlAfter: AUTH_URL })).toBeNull();
  });
  it("ignores non-auth errors even with a fresh URL", () => {
    expect(detectOAuthStepUp({ ...base, error: new Error("timeout"), authUrlAfter: AUTH_URL })).toBeNull();
  });
  it("rejects non-http URLs", () => {
    expect(detectOAuthStepUp({ ...base, error: new UnauthorizedError(), authUrlAfter: "javascript:alert(1)" })).toBeNull();
  });
});

describe("helpers", () => {
  it("scopeFromAuthUrl", () => {
    expect(scopeFromAuthUrl(AUTH_URL)).toBe("user:read account:read workers_scripts:write");
    expect(scopeFromAuthUrl("not a url")).toBeUndefined();
  });
  it("isOAuthStepUpMarker", () => {
    expect(isOAuthStepUpMarker({ [OAUTH_STEP_UP_KEY]: { serverId: "s", authUrl: AUTH_URL } })).toBe(true);
    expect(isOAuthStepUpMarker({ content: [] })).toBe(false);
    expect(isOAuthStepUpMarker("x")).toBe(false);
  });
  it("tool result tells the model to stop and retry once", () => {
    const s = { serverId: "srv", serverName: "Cloudflare API", authUrl: AUTH_URL, scope: "a b" };
    expect(stepUpReason(s)).toContain("Cloudflare API needs you to approve more access (asks for: a b)");
    const shown = stepUpToolResult(s, true);
    expect(shown.authUrl).toBe(AUTH_URL);
    expect(shown.next).toMatch(/End your turn/);
    expect(shown.next).toMatch(/retry this exact call once/);
    expect(stepUpToolResult(s, false).next).toMatch(/Give the person this authUrl/);
  });
});

describe("buildOAuthMcpTools step-up handling", () => {
  const info = [{ name: "execute", serverId: "srv", displayName: "Cloudflare API" }];
  // biome-ignore lint: test harness — execute is always defined for our tools
  const run = (t: any, args: unknown) => t.execute(args, { toolCallId: "t1", messages: [] });

  it("raises the needs-input card with the link and returns retry guidance", async () => {
    const stepUp = { serverId: "srv", serverName: "Cloudflare API", authUrl: AUTH_URL, scope: "user:read account:read workers_scripts:write" };
    const exec = vi.fn(async () => ({ [OAUTH_STEP_UP_KEY]: stepUp }));
    const requestUserInput = vi.fn(async (i: { kind: string; reason: string; authUrl?: string }) => ({ ...i, liveView: false, at: "now" } as never));
    const tools = buildOAuthMcpTools(info, exec, new Set(), { requestUserInput });
    const out = await run(tools["cloudflare-api__execute"], { code: "x" });
    expect(requestUserInput).toHaveBeenCalledWith({ kind: "login", reason: stepUpReason(stepUp), authUrl: AUTH_URL });
    expect(out).toEqual(stepUpToolResult(stepUp, true));
  });

  it("without session tools (subagent) the model gets the link itself", async () => {
    const stepUp = { serverId: "srv", authUrl: AUTH_URL };
    const tools = buildOAuthMcpTools(info, async () => ({ [OAUTH_STEP_UP_KEY]: stepUp }), new Set());
    const out = await run(tools["cloudflare-api__execute"], {});
    expect(out).toEqual(stepUpToolResult(stepUp, false));
  });

  it("passes normal results through untouched", async () => {
    const result = { content: [{ type: "text", text: "ok" }] };
    const requestUserInput = vi.fn();
    const tools = buildOAuthMcpTools(info, async () => result, new Set(), { requestUserInput });
    expect(await run(tools["cloudflare-api__execute"], {})).toBe(result);
    expect(requestUserInput).not.toHaveBeenCalled();
  });
});
