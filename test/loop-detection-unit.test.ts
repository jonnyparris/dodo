/**
 * Unit tests for `detectSameToolRepetition` — the looser-than-doom-loop
 * detector that catches "same tool name, different args" patterns.
 *
 * Behaviour grid:
 *
 *  - threshold < 2: always null (degenerate)
 *  - buffer shorter than threshold: null
 *  - last N entries all have the same tool name (any args): returns the name
 *  - mixed names in the tail window: null, even if earlier entries match
 *  - args don't matter — only the substring before the first `:`
 */
import { describe, expect, it } from "vitest";
import { detectSameToolRepetition } from "../src/loop-detection";

const call = (name: string, args: unknown = {}) => `${name}:${JSON.stringify(args)}`;

describe("detectSameToolRepetition", () => {
  it("returns null for an empty buffer", () => {
    expect(detectSameToolRepetition([], 6)).toBeNull();
  });

  it("returns null when buffer is shorter than threshold", () => {
    const buf = [call("codemode", { code: "1" }), call("codemode", { code: "2" })];
    expect(detectSameToolRepetition(buf, 6)).toBeNull();
  });

  it("returns null for a degenerate threshold (<2)", () => {
    const buf = [call("codemode"), call("codemode"), call("codemode")];
    expect(detectSameToolRepetition(buf, 1)).toBeNull();
    expect(detectSameToolRepetition(buf, 0)).toBeNull();
  });

  it("returns the tool name when last N calls share the same name with different args", () => {
    const buf = [
      call("explore", { q: "auth" }),
      call("codemode", { code: "step1" }),
      call("codemode", { code: "step2" }),
      call("codemode", { code: "step3" }),
      call("codemode", { code: "step4" }),
      call("codemode", { code: "step5" }),
      call("codemode", { code: "step6" }),
    ];
    expect(detectSameToolRepetition(buf, 6)).toBe("codemode");
  });

  it("returns null when the most recent call breaks the streak", () => {
    const buf = [
      call("codemode"),
      call("codemode"),
      call("codemode"),
      call("codemode"),
      call("codemode"),
      call("read", { path: "foo" }),
    ];
    expect(detectSameToolRepetition(buf, 6)).toBeNull();
  });

  it("ignores earlier entries outside the tail window", () => {
    // The first 4 entries are mixed, but the last 6 are all `codemode`.
    const buf = [
      call("read"),
      call("explore"),
      call("grep"),
      call("read"),
      call("codemode"),
      call("codemode"),
      call("codemode"),
      call("codemode"),
      call("codemode"),
      call("codemode"),
    ];
    expect(detectSameToolRepetition(buf, 6)).toBe("codemode");
  });

  it("treats args as opaque — different args still count as same tool", () => {
    const buf = [
      call("codemode", { code: 'return 1+1' }),
      call("codemode", { code: 'return await env.WORKSPACE_BUCKET.list({ prefix: "x" })' }),
      call("codemode", { code: 'return { a: 1, b: 2, nested: { c: [1, 2, 3] } }' }),
    ];
    expect(detectSameToolRepetition(buf, 3)).toBe("codemode");
  });

  it("handles tool names containing colons in args without confusion", () => {
    // The split is on the FIRST `:` — args may contain JSON with colons.
    const buf = [
      `codemode:{"code":"return 1"}`,
      `codemode:{"code":"return 2"}`,
      `codemode:{"code":"return 3"}`,
    ];
    expect(detectSameToolRepetition(buf, 3)).toBe("codemode");
  });

  it("works at exactly threshold size", () => {
    const buf = [call("explore"), call("explore"), call("explore")];
    expect(detectSameToolRepetition(buf, 3)).toBe("explore");
  });

  it("returns null when the streak is partial", () => {
    // 5 codemode calls but threshold is 6 — should NOT trigger.
    const buf = [
      call("codemode"),
      call("codemode"),
      call("codemode"),
      call("codemode"),
      call("codemode"),
    ];
    expect(detectSameToolRepetition(buf, 6)).toBeNull();
  });
});
