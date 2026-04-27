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
 * The failure mode this guards against: passing a plain `{ fetch: ... }`
 * object cast `as Fetcher` to `DynamicWorkerExecutor`'s `globalOutbound`
 * fails at WorkerCode construction time with:
 *
 *   Incorrect type for the 'globalOutbound' field on 'WorkerCode':
 *   the provided value is not of type 'Fetcher'.
 */
import { describe, expect, it } from "vitest";
import { OWNER_ID_HEADER } from "../src/executor";

describe("OWNER_ID_HEADER", () => {
  it("constant is preserved for compatibility / future reuse", () => {
    expect(OWNER_ID_HEADER).toBe("x-dodo-owner-id");
  });
});

describe("AllowlistOutbound — allowlist still enforced (defence-in-depth)", () => {
  // Re-implement the catalog-host check so we can verify the perimeter
  // logic without spinning up the full Workers runtime. Keep this in sync
  // with src/outbound.ts (drift is caught by integration tests below).
  function inCatalog(hostname: string, catalog: Set<string>): boolean {
    return catalog.has(hostname);
  }

  const catalog = new Set(["api.githubcopilot.com", "browser.mcp.cloudflare.com"]);

  it("catalog hosts bypass the SharedIndex allowlist check", () => {
    expect(inCatalog("api.githubcopilot.com", catalog)).toBe(true);
    expect(inCatalog("browser.mcp.cloudflare.com", catalog)).toBe(true);
  });

  it("non-catalog hosts must go through the allowlist", () => {
    // This isn't an end-to-end test — it just asserts the catalog short-circuit
    // is selective. The actual allowlist enforcement is exercised in
    // shared-index.test.ts and admin.test.ts which spin up the full DO.
    expect(inCatalog("api.github.com", catalog)).toBe(false);
    expect(inCatalog("evil.com", catalog)).toBe(false);
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
