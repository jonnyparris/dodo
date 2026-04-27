/**
 * Live regression test for the codemode `globalOutbound` wiring.
 *
 * This test exists because the same bug shipped four times in the last two
 * days (PRs #52, #54, #55, then the fix in d6da13e). Every previous attempt
 * had passing types and passing unit tests for the wrapper logic — but
 * nothing actually instantiated `DynamicWorkerExecutor` with the wrapper
 * and ran code through it. workerd's globalOutbound validator only fires
 * at WorkerCode construction time, which is invisible to type-level and
 * mock-based tests.
 *
 * The contract this test enforces:
 *   1. `DynamicWorkerExecutor` constructed with `globalOutbound: env.OUTBOUND`
 *      (the wiring shipped in src/executor.ts and src/agentic.ts) must
 *      successfully boot a sandbox and run trivial code through it.
 *   2. A duck-typed Fetcher wrapper passed as `globalOutbound` must fail
 *      — this is the bug we keep re-introducing, and the failure is what
 *      we're guarding against.
 *
 * If you reintroduce a Fetcher wrapper (duck-typed, LOADER-spawned proxy,
 * per-call props, anything else clever) and it doesn't return a real
 * ServiceStub, test (1) will fail with workerd's:
 *
 *   Incorrect type for the 'globalOutbound' field on 'WorkerCode':
 *   the provided value is not of type 'Fetcher'.
 *
 * Don't replace this test with a mocked one. The whole point is to exercise
 * the workerd path that mocks bypass.
 */
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { Env } from "../src/types";

describe("codemode globalOutbound — live wiring regression", () => {
  it("test bindings expose LOADER and OUTBOUND", () => {
    // If these are undefined the test pool isn't using wrangler.test.jsonc
    // correctly. Fail loud rather than skip — this is the precondition
    // for the rest of the suite to be meaningful.
    const e = env as Env;
    expect(e.LOADER, "LOADER binding missing — wrangler.test.jsonc misconfigured").toBeDefined();
    expect(e.OUTBOUND, "OUTBOUND binding missing — wrangler.test.jsonc misconfigured").toBeDefined();
  });

  it("DynamicWorkerExecutor accepts env.OUTBOUND as globalOutbound and runs code", async () => {
    // Mirrors the wiring in src/executor.ts runSandboxedCode and
    // src/agentic.ts buildTools. If a future change wraps env.OUTBOUND
    // with anything that isn't a real ServiceStub, executor.execute()
    // throws workerd's WorkerCode validator error.
    const e = env as Env;
    if (!e.LOADER || !e.OUTBOUND) throw new Error("test bindings missing");

    const executor = new DynamicWorkerExecutor({
      globalOutbound: e.OUTBOUND,
      loader: e.LOADER,
      timeout: 30_000,
    });

    const result = await executor.execute(`async () => 42`, []);

    expect(result.error, `unexpected error: ${result.error}`).toBeUndefined();
    expect(result.result).toBe(42);
  });

  it("DynamicWorkerExecutor accepts globalOutbound: null (sandbox-isolated mode)", async () => {
    // Belt-and-braces: the codemode browser-tools path uses globalOutbound: null
    // to lock down network access. Verifying that path stays valid keeps both
    // wiring modes covered by one test file.
    const e = env as Env;
    if (!e.LOADER) throw new Error("LOADER binding missing");

    const executor = new DynamicWorkerExecutor({
      globalOutbound: null,
      loader: e.LOADER,
      timeout: 30_000,
    });

    const result = await executor.execute(`async () => "isolated"`, []);
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("isolated");
  });

  it("rejects a duck-typed Fetcher wrapper (the bug we keep re-introducing)", async () => {
    // This is the failure mode. We assert the failure shape so that anyone
    // who deletes this test "because it's failing" is forced to read the
    // assertion and learn what they're breaking.
    const e = env as Env;
    if (!e.LOADER || !e.OUTBOUND) throw new Error("test bindings missing");
    const realOutbound = e.OUTBOUND;
    const fakeFetcher = {
      fetch: (input: RequestInfo, init?: RequestInit) =>
        realOutbound.fetch(new Request(input, init)),
    } as unknown as Fetcher;

    const executor = new DynamicWorkerExecutor({
      globalOutbound: fakeFetcher,
      loader: e.LOADER,
      timeout: 30_000,
    });

    // executor.execute() catches errors and returns them in result.error
    // rather than throwing. We accept either a thrown error or a populated
    // result.error — both indicate workerd refused the duck-typed wrapper.
    let caught: unknown = null;
    let result: Awaited<ReturnType<typeof executor.execute>> | null = null;
    try {
      result = await executor.execute(`async () => 1`, []);
    } catch (err) {
      caught = err;
    }

    const errorMessage = caught
      ? (caught instanceof Error ? caught.message : String(caught))
      : (result?.error ?? "");

    expect(
      errorMessage,
      "expected workerd to reject the duck-typed wrapper — if this passes, " +
        "the runtime stopped enforcing globalOutbound's Fetcher type and our " +
        "fix in d6da13e may no longer be necessary",
    ).not.toBe("");
    // Don't pin to the exact string — workerd error messages drift across
    // versions. Just assert it's about globalOutbound or Fetcher.
    expect(errorMessage).toMatch(/globalOutbound|Fetcher|WorkerCode/i);
  });
});
