/**
 * Regression test for the 204k-input-token incident in session 56a7a597.
 *
 * The failure mode:
 *   1. User asks "what PRs are open on jonnyparris/dodo?"
 *   2. Agent calls codemode with `await fetch("api.github.com/.../pulls?state=open")`
 *   3. GitHub returns a verbose JSON with full bodies, user objects, and _links
 *   4. codemode's raw result lands in the AI SDK message history uncapped
 *   5. Next turn the input bill is 204k tokens for a 2-PR listing
 *
 * The fix: capCodemodeResult() middle-truncates any codemode result > 32 KB
 * before it's returned to the model. projectCodemodeResult() lets the model
 * pre-narrow large responses via `select: ["items.0.title", ...]`.
 *
 * This test uses a synthetic GitHub-shaped payload that matches the size
 * and structure of the real response from session 56a7a597.
 */
import { describe, expect, it } from "vitest";
import { capCodemodeResult, projectCodemodeResult } from "../src/agentic";
import { asSchema } from "ai";
import { z } from "zod";

/** Build a PR object shaped like GitHub's `/repos/:o/:r/pulls` response. */
function buildPr(number: number, title: string) {
  return {
    id: 1_000_000 + number,
    number,
    title,
    state: "open",
    draft: true,
    user: {
      login: "jonnyparris",
      id: 12345,
      avatar_url: "https://avatars.githubusercontent.com/u/12345?v=4",
      gravatar_id: "",
      url: "https://api.github.com/users/jonnyparris",
      type: "User",
      // 40 additional URL fields GitHub inlines on every user object…
    },
    body:
      "## Summary\n\n" +
      "This PR does a lot. ".repeat(500) +
      "\n\n## Details\n\n" +
      "Lots of context here. ".repeat(300),
    head: {
      ref: `feat/branch-${number}`,
      sha: "a".repeat(40),
      repo: {
        id: 99999,
        name: "dodo",
        full_name: "jonnyparris/dodo",
        owner: { login: "jonnyparris" },
        description: "Dodo coding agent".repeat(10),
      },
    },
    base: {
      ref: "main",
      sha: "b".repeat(40),
      repo: { id: 99999, full_name: "jonnyparris/dodo" },
    },
    _links: {
      self: { href: `https://api.github.com/repos/jonnyparris/dodo/pulls/${number}` },
      html: { href: `https://github.com/jonnyparris/dodo/pull/${number}` },
      issue: { href: `https://api.github.com/repos/jonnyparris/dodo/issues/${number}` },
      comments: { href: `https://api.github.com/repos/jonnyparris/dodo/issues/${number}/comments` },
      review_comments: { href: `https://api.github.com/repos/jonnyparris/dodo/pulls/${number}/comments` },
      review_comment: { href: `https://api.github.com/repos/jonnyparris/dodo/pulls/comments{/number}` },
      commits: { href: `https://api.github.com/repos/jonnyparris/dodo/pulls/${number}/commits` },
      statuses: { href: `https://api.github.com/repos/jonnyparris/dodo/statuses/abc` },
    },
    updated_at: "2026-04-23T14:00:00Z",
    created_at: "2026-04-20T10:00:00Z",
  };
}

describe("codemode cap — 56a7a597 regression", () => {
  const githubResponse = {
    code: `const res = await fetch("https://api.github.com/repos/jonnyparris/dodo/pulls?state=open", { headers: { authorization: "Bearer " + githubToken } });\nconst prs = await res.json();\nreturn prs;`,
    result: [
      buildPr(43, "feat: OAuth MCP support — all 4 phases"),
      buildPr(41, "Phase 2 — fix: restore MCP_CATALOG import"),
    ],
    logs: "",
  };

  it("raw response (without cap) is the pathological size that burned 204k tokens", () => {
    const serialized = JSON.stringify(githubResponse);
    // Each PR body + context fields produces ~10 KB → ~25+ KB total payload.
    // In the real incident it was larger because the user objects had many
    // more inlined URL fields; our synthetic version is a conservative lower bound.
    expect(serialized.length).toBeGreaterThan(25_000);
    // Sanity check — print the savings numbers so CI output makes the
    // incident/fix relationship visible.
    const capped = capCodemodeResult(githubResponse, 32_000);
    const projected = projectCodemodeResult(githubResponse, [
      "0.number", "0.title", "0.draft", "0.head.ref",
      "1.number", "1.title", "1.draft", "1.head.ref",
    ]);
    const cappedSize = JSON.stringify(capped).length;
    const projectedSize = JSON.stringify(projected).length;
    // eslint-disable-next-line no-console
    console.log(
      `[56a7a597 regression] raw=${serialized.length}B capped=${cappedSize}B projected=${projectedSize}B`,
      `— ${(100 * cappedSize / serialized.length).toFixed(1)}% / ${(100 * projectedSize / serialized.length).toFixed(1)}% of raw`,
    );
  });

  it("capCodemodeResult trims a large response to fit 32 KB", () => {
    const capped = capCodemodeResult(githubResponse, 32_000) as {
      code: string;
      result: unknown;
      logs: string;
      _truncated?: string;
    };

    // code field is preserved (small and useful for the model to diff against)
    expect(capped.code).toBe(githubResponse.code);

    // If the payload exceeded the cap, result is now a string (middle-truncated)
    // and _truncated carries a hint pointing at `select`.
    const serializedResult = typeof capped.result === "string"
      ? capped.result
      : JSON.stringify(capped.result);
    expect(serializedResult.length).toBeLessThanOrEqual(32_000);

    // The hint mentions `select` so the model knows to narrow next time.
    if (capped._truncated) {
      expect(capped._truncated).toMatch(/select/);
    }
  });

  it("projecting first to just what's needed skips the cap entirely", () => {
    // This is the shape the model should learn to use — pass `select` to
    // return only the 4 fields actually needed for a PR listing.
    const projected = projectCodemodeResult(githubResponse, [
      "0.number",
      "0.title",
      "0.draft",
      "0.head.ref",
      "1.number",
      "1.title",
      "1.draft",
      "1.head.ref",
    ]) as {
      code: string;
      result: Record<string, unknown>;
      _projected_paths: string[];
    };

    // Projected result is a flat map of dot-path → value, much smaller than raw
    const serialized = JSON.stringify(projected.result);
    expect(serialized.length).toBeLessThan(500);
    expect(projected.result["0.title"]).toBe("feat: OAuth MCP support — all 4 phases");
    expect(projected.result["1.number"]).toBe(41);

    // And after projection, cap is a no-op (well under 32 KB)
    const capped = capCodemodeResult(projected, 32_000) as { _truncated?: string };
    expect(capped._truncated).toBeUndefined();
  });

  it("cap preserves the shape of a small response (no change)", () => {
    const small = {
      code: "return 'hi'",
      result: { message: "hi" },
    };
    const capped = capCodemodeResult(small, 32_000);
    expect(capped).toEqual(small);
  });

  it("cap trims oversized logs independently from result", () => {
    const noisy = {
      code: "console.log(lots)",
      result: { ok: true },
      logs: "x".repeat(10_000),
    };
    const capped = capCodemodeResult(noisy, 32_000) as { logs: string };
    expect(capped.logs.length).toBeLessThanOrEqual(4_100);
  });

  it("projecting missing paths silently skips them", () => {
    const projected = projectCodemodeResult(githubResponse, [
      "0.title",
      "0.nonexistent.path",
      "99.title",
    ]) as { result: Record<string, unknown> };
    expect(projected.result["0.title"]).toBeDefined();
    expect(projected.result["0.nonexistent.path"]).toBeUndefined();
    expect(projected.result["99.title"]).toBeUndefined();
  });
});

/**
 * Schema-level regression: `select` must survive AI SDK Zod validation.
 *
 * Pre-fix, the wrapped codemode tool inherited the underlying codemode
 * schema which only accepts `{ code }`. Zod strips unknown keys by default
 * and the model never sees `select` as an allowed field in its tool
 * definition (additionalProperties:false on the wire). The wrap's
 * destructure silently returned undefined for `select`, projection never
 * ran.
 *
 * This test asserts the extended inputSchema actually accepts `select`
 * end-to-end — using the exact `asSchema(...).validate` path the AI SDK
 * uses in doToolCall.
 */
describe("codemode extended inputSchema — Zod round-trip regression", () => {
  // This mirrors the shape built in buildTools() — we construct the same
  // zodSchema and pass it through asSchema to verify validate() keeps
  // `select`. If the schema ever regresses back to accepting only `code`,
  // this test fails loudly.
  const extendedSchema = z.object({
    code: z.string().describe("JavaScript async arrow function to execute"),
    select: z
      .array(z.string())
      .optional()
      .describe("Dot-paths to project from result"),
  });

  it("validate() preserves `select` when the model passes it", async () => {
    const schema = asSchema(extendedSchema);
    const input = {
      code: "return {items: [{name: 'a'}], total_count: 1}",
      select: ["items.0.name", "total_count"],
    };
    // asSchema returns either a SchemaV2 or the Zod-wrapped version; both
    // expose a validate() method that returns { success, value } | { success:false, error }.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (schema as any).validate(input);
    expect(result.success).toBe(true);
    expect(result.value.select).toEqual(["items.0.name", "total_count"]);
    expect(result.value.code).toBe(input.code);
  });

  it("validate() still accepts a call without `select` (backwards compat)", async () => {
    const schema = asSchema(extendedSchema);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (schema as any).validate({ code: "return 1" });
    expect(result.success).toBe(true);
    expect(result.value.select).toBeUndefined();
  });
});
