/**
 * Unit tests for the per-turn cache guards that landed in the
 * harness-latency-2026-05-28 perf pass.
 *
 * Before this pass, every chat turn re-ran:
 *   - `warmSkills()` — fetched personal skills from UserControl and scanned
 *     the workspace for SKILL.md files (~100–300ms/turn).
 *   - `connectMcpServers()` — disconnected and reconnected every enabled MCP
 *     gatekeeper, sequentially fetching auth headers (~500ms–2s/turn with a
 *     typical 7-server config including two cf-portal instances).
 *
 * The guards below are the small pure helpers each method now consults
 * before doing the work. Keeping them as standalone functions lets us test
 * the cache-decision logic without spinning up a full Durable Object.
 */
import { describe, expect, it } from "vitest";
import { isCacheFresh, isFingerprintedCacheFresh } from "../src/coding-agent";

describe("isCacheFresh", () => {
  it("returns false when cachedAt is 0 (no cache yet)", () => {
    expect(isCacheFresh(0, 60_000)).toBe(false);
  });

  it("returns true when within the TTL window", () => {
    const now = 1_000_000;
    expect(isCacheFresh(now - 5_000, 60_000, now)).toBe(true);
  });

  it("returns false once the TTL has elapsed", () => {
    const now = 1_000_000;
    expect(isCacheFresh(now - 60_001, 60_000, now)).toBe(false);
  });

  it("treats the TTL boundary as expired (closed interval at TTL)", () => {
    const now = 1_000_000;
    // delta === ttl is NOT fresh (delta < ttl required).
    expect(isCacheFresh(now - 60_000, 60_000, now)).toBe(false);
  });
});

describe("isFingerprintedCacheFresh", () => {
  // This is what guards `connectMcpServers()`. The fingerprint encodes the
  // set of enabled MCP config IDs — if a user enables a new server, the
  // fingerprint changes and we must reconnect even if the TTL hasn't
  // elapsed. Without that, newly-enabled servers wouldn't show up until the
  // 5-minute TTL ticked over.
  const TTL = 5 * 60_000;
  const now = 1_700_000_000_000;

  it("returns false when cachedAt is 0", () => {
    expect(isFingerprintedCacheFresh(0, "abc", "abc", TTL, now)).toBe(false);
  });

  it("returns true when fingerprint matches and TTL is fresh", () => {
    expect(isFingerprintedCacheFresh(now - 1_000, "abc", "abc", TTL, now)).toBe(true);
  });

  it("returns false when fingerprint differs, even within TTL", () => {
    // User just enabled a new MCP server — must reconnect now, not wait
    // 5 minutes.
    expect(isFingerprintedCacheFresh(now - 1_000, "abc", "abc,def", TTL, now)).toBe(false);
  });

  it("returns false when cached fingerprint is null", () => {
    // Initial state — no cache, must connect.
    expect(isFingerprintedCacheFresh(now - 1_000, null, "abc", TTL, now)).toBe(false);
  });

  it("returns false when TTL has elapsed, even with matching fingerprint", () => {
    // Safety net — refresh tokens drift, fall back to a full reconnect after
    // the TTL window even if the user hasn't changed anything.
    expect(isFingerprintedCacheFresh(now - TTL - 1, "abc", "abc", TTL, now)).toBe(false);
  });
});
