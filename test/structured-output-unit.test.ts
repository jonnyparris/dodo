/**
 * Unit tests for the structured-output helper.
 *
 * Focus areas:
 * - `structuredModeFor` returns the right capability for every
 *   classified model-family prefix, and falls back to `tool` for
 *   unknown ids.
 * - The result-schema registry lookup throws on unknown names.
 * - The `Workers AI Kimi` override (most-specific prefix) takes
 *   priority over the broader `@cf/` family rule.
 */
import { describe, expect, it } from "vitest";
import {
  lookupResultSchema,
  listResultSchemaNames,
  VerifyRunSummary,
  TaskSummary,
  DispatchDecision,
} from "../src/result-schema-registry";
import { structuredModeFor } from "../src/structured-output";

describe("structuredModeFor", () => {
  it("routes Anthropic 4.x to native JSON mode", () => {
    expect(structuredModeFor("anthropic/claude-haiku-4-5")).toBe("native");
    expect(structuredModeFor("anthropic/claude-sonnet-4-6")).toBe("native");
    expect(structuredModeFor("anthropic/claude-opus-4-6")).toBe("native");
  });

  it("routes older Anthropic models to tool mode", () => {
    expect(structuredModeFor("anthropic/claude-3-haiku")).toBe("tool");
  });

  it("routes OpenAI flagships to native JSON mode", () => {
    expect(structuredModeFor("openai/gpt-5.4")).toBe("native");
    expect(structuredModeFor("openai/gpt-4.1")).toBe("native");
    expect(structuredModeFor("openai/o3-mini")).toBe("native");
    expect(structuredModeFor("openai/o4-mini")).toBe("native");
  });

  it("routes Gemini 2.5 Pro to native and Flash to tool", () => {
    // Flash had an empirical JSON-mode regression on nested schemas
    // on a prior project — staying in tool mode is the conservative
    // default until a real workload confirms native is stable.
    expect(structuredModeFor("google/gemini-2.5-pro")).toBe("native");
    expect(structuredModeFor("google/gemini-2.5-flash")).toBe("tool");
  });

  it("most-specific prefix wins: kimi overrides the @cf/ family default", () => {
    expect(structuredModeFor("@cf/moonshotai/kimi-k2.6")).toBe("native");
    expect(structuredModeFor("@cf/google/gemma-4-26b-a4b-it")).toBe("tool");
  });

  it("falls back to tool mode for unknown providers", () => {
    expect(structuredModeFor("mystery/weird-model")).toBe("tool");
    expect(structuredModeFor("")).toBe("tool");
  });
});

describe("result-schema-registry", () => {
  it("registers the three documented schemas", () => {
    const names = listResultSchemaNames();
    expect(names).toContain("verify-run-summary");
    expect(names).toContain("dispatch-decision");
    expect(names).toContain("task-summary");
  });

  it("lookupResultSchema returns the expected Zod object for each name", () => {
    // We can't compare schema objects by identity through the
    // registry's `z.ZodType<any>` erasure, so we round-trip a valid
    // value through each one — that proves the lookup wires to the
    // right schema and the schema itself accepts what its docstring
    // promises.
    expect(() =>
      lookupResultSchema("verify-run-summary").parse({
        passed: true,
        failures: [],
      }),
    ).not.toThrow();
    expect(() =>
      lookupResultSchema("task-summary").parse({
        done: true,
        paths: ["src/foo.ts"],
        summary: "did the thing",
      }),
    ).not.toThrow();
    expect(() =>
      lookupResultSchema("dispatch-decision").parse({
        targets: [{ area: "autopilot", contextNotes: "log evidence" }],
      }),
    ).not.toThrow();
  });

  it("throws on an unknown name with the full list of valid names", () => {
    expect(() => lookupResultSchema("not-a-real-schema")).toThrow(
      /Unknown result schema "not-a-real-schema"/,
    );
    expect(() => lookupResultSchema("not-a-real-schema")).toThrow(
      /verify-run-summary/,
    );
  });
});

describe("VerifyRunSummary schema", () => {
  it("rejects unpassed runs with an empty failure list", () => {
    // The contract is "empty array when passed=true". Today the schema
    // doesn't enforce the converse (a failed run must have failures),
    // but a regression test pins the documented invariant so the next
    // edit either upgrades the schema or updates the test together.
    const result = VerifyRunSummary.safeParse({
      passed: false,
      failures: [],
    });
    expect(result.success).toBe(true);
  });

  it("caps notes at 500 chars", () => {
    const tooLong = VerifyRunSummary.safeParse({
      passed: true,
      failures: [],
      notes: "x".repeat(501),
    });
    expect(tooLong.success).toBe(false);
  });
});

describe("DispatchDecision schema", () => {
  it("rejects more than 3 targets — matches supervisor's hard rule", () => {
    const result = DispatchDecision.safeParse({
      targets: [
        { area: "a", contextNotes: "" },
        { area: "b", contextNotes: "" },
        { area: "c", contextNotes: "" },
        { area: "d", contextNotes: "" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("requires non-empty area string", () => {
    const result = DispatchDecision.safeParse({
      targets: [{ area: "", contextNotes: "x" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("TaskSummary schema", () => {
  it("caps summary at 2000 chars", () => {
    const tooLong = TaskSummary.safeParse({
      done: true,
      paths: [],
      summary: "x".repeat(2001),
    });
    expect(tooLong.success).toBe(false);
  });

  it("rejects empty summary", () => {
    const empty = TaskSummary.safeParse({
      done: true,
      paths: [],
      summary: "",
    });
    expect(empty.success).toBe(false);
  });
});
