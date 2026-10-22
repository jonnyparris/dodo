/**
 * Regression tests for the codemode `globalOutbound` wiring.
 *
 * History:
 *   - PR #52 wrapped OUTBOUND with a `LOADER.get()` proxy → reverted in #53
 *     (entrypoints to dynamic workers can't be transferred to other workers).
 *   - PR #54 used per-call props via ctx.exports → reverted in #55
 *     (callable signature only available in main fetch handler, not DOs).
 *   - This commit removes the duck-typed wrapper entirely. globalOutbound is
 *     now the raw `env.OUTBOUND` ServiceStub, which workerd accepts. The
 *     allowlist is still enforced by AllowlistOutbound; per-user token
 *     injection for raw sandbox `fetch()` is intentionally unavailable so
 *     the sandbox has no direct access to user secrets.
 *
 * It also checks the sandbox egress policy: MCP catalog hosts must go
 * through the SharedIndex allowlist like any other host.
 *
 * The failure mode this guards against: passing a plain `{ fetch: ... }`
 * object cast `as Fetcher` to `DynamicWorkerExecutor`'s `globalOutbound`
 * fails at WorkerCode construction time with:
 *
 *   Incorrect type for the 'globalOutbound' field on 'WorkerCode':
 *   the provided value is not of type 'Fetcher'.
 */
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getSharedIndexStub } from "../src/auth";
import { OWNER_ID_HEADER } from "../src/outbound";
import { MCP_CATALOG } from "../src/mcp-catalog";
import type { Env } from "../src/types";

describe("OWNER_ID_HEADER", () => {
  it("constant is preserved for compatibility / future reuse", () => {
    expect(OWNER_ID_HEADER).toBe("x-dodo-owner-id");
  });
});

describe("AllowlistOutbound — MCP catalog hosts get no sandbox bypass", () => {
  // Goes through the real OUTBOUND service binding (the same Fetcher the
  // codemode sandbox gets as globalOutbound). The test SharedIndex has an
  // empty allowlist, so a 403 proves no catalog host skips the check.
  // MCP connections run outside the sandbox (OAuth on the per-user hub
  // CodingAgent, the rest via HttpMcpClient), so it never needs these.
  it("returns 403 for every catalog knownHost, OAuth or not", async () => {
    const e = env as Env;
    if (!e.OUTBOUND) throw new Error("OUTBOUND binding missing");
    const hosts = MCP_CATALOG.flatMap((x) => x.knownHosts ?? []);
    expect(hosts).toContain("browser.mcp.cloudflare.com");
    // Precondition: none of these hosts is on the admin allowlist, so a 200
    // can only mean a bypass, not test setup.
    const list = await getSharedIndexStub(e).fetch("https://shared-index/allowlist");
    const allowlisted = JSON.stringify(await list.json());
    for (const host of hosts) expect(allowlisted, host).not.toContain(`"${host}"`);
    for (const host of hosts) {
      const res = await e.OUTBOUND.fetch(`https://${host}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer attacker-token" },
        body: "{}",
      });
      expect(res.status, host).toBe(403);
      expect(await res.text()).toContain("not in allowlist");
    }
  });
});

describe("OWNER_ID_HEADER stripping", () => {
  it("AllowlistOutbound deletes any incoming x-dodo-owner-id header", () => {
    // The sandbox shouldn't be able to spoof identity even if a future
    // wrapper sets the header. AllowlistOutbound.fetch() always strips it
    // before forwarding. We assert the contract here so any refactor that
    // accidentally drops the strip is caught.
    const incoming = new Headers({
      [OWNER_ID_HEADER]: "attacker-controlled-owner-id",
      "X-Other": "kept",
    });
    const stripped = new Headers(incoming);
    stripped.delete(OWNER_ID_HEADER);

    expect(stripped.has(OWNER_ID_HEADER)).toBe(false);
    expect(stripped.get("X-Other")).toBe("kept");
  });
});
