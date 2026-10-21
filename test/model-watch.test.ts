import { describe, expect, it } from "vitest";
import { armName, buildSpec, type Candidate, type CatalogModel, DEFAULT_FILTER, plan, rejectReason, toCandidate, type WatchState } from "../bench/model-watch-lib";

function model(name: string, props: Record<string, unknown> = {}, created = "2026-10-01 00:00:00"): CatalogModel {
  const base = { context_window: "262144", function_calling: "true", ...props };
  return { name, created_at: created, properties: Object.entries(base).map(([property_id, value]) => ({ property_id, value })) };
}

const cand = (name: string, props?: Record<string, unknown>, created?: string): Candidate => toCandidate(model(name, props, created));

describe("toCandidate", () => {
  it("reads context, function calling and price", () => {
    const c = toCandidate(
      model("@cf/deepseek-ai/deepseek-v4.1-flash-1017", {
        context_window: "1048576",
        price: [
          { unit: "per M input tokens", price: 0.3, currency: "USD" },
          { unit: "per M output tokens", price: 1.2, currency: "USD" },
        ],
      }),
    );
    expect(c).toMatchObject({ contextWindow: 1_048_576, functionCalling: true, priceIn: 0.3, priceOut: 1.2, deprecated: false });
  });

  it("marks a past deprecation date as deprecated", () => {
    expect(cand("@cf/a/b", { planned_deprecation_date: "2026-01-01" }).deprecated).toBe(true);
    expect(cand("@cf/a/b", { planned_deprecation_date: "2999-01-01" }).deprecated).toBe(false);
  });
});

describe("rejectReason", () => {
  it("accepts a tool-calling model with a big context", () => {
    expect(rejectReason(cand("@cf/qwen/qwen3.8-27b"), DEFAULT_FILTER)).toBeUndefined();
  });
  it("rejects no function calling, small context, high price, exclusions", () => {
    expect(rejectReason(cand("@cf/a/b", { function_calling: undefined }), DEFAULT_FILTER)).toBe("no function calling");
    expect(rejectReason(cand("@cf/a/b", { context_window: "32000" }), DEFAULT_FILTER)).toMatch(/^context/);
    expect(rejectReason(cand("@cf/a/b", { price: [{ unit: "per M input tokens", price: 5 }] }), DEFAULT_FILTER)).toMatch(/price/);
    expect(rejectReason(cand("@cf/daily-co/phonellm"), { ...DEFAULT_FILTER, exclude: ["@cf/daily-co/*"] })).toBe("excluded");
  });
});

describe("plan", () => {
  const catalog = [cand("@cf/a/old", {}, "2026-01-01"), cand("@cf/b/new1", {}, "2026-10-20"), cand("@cf/c/new2", {}, "2026-10-18"), cand("@cf/d/tiny", { context_window: "8192" }, "2026-10-19")];
  const seenOld: WatchState = { seen: { "@cf/a/old": "x" }, runs: {} };

  it("first run records everything and benches nothing", () => {
    const p = plan(catalog, { seen: {}, runs: {} }, DEFAULT_FILTER, { max: 5 });
    expect(p.bench).toEqual([]);
    expect(p.newlySeen).toHaveLength(4);
  });

  it("benches new models oldest first, capped at max, and reports skips", () => {
    const p = plan(catalog, seenOld, DEFAULT_FILTER, { max: 1 });
    expect(p.bench.map((c) => c.id)).toEqual(["@cf/c/new2"]);
    expect(p.skipped).toEqual([{ id: "@cf/d/tiny", reason: "context 8192 < 131072" }]);
    // new1 is over the cap: not marked seen, so the next run benches it.
    expect(p.deferred).toEqual(["@cf/b/new1"]);
    expect(p.newlySeen.sort()).toEqual(["@cf/c/new2", "@cf/d/tiny"]);
  });

  it("retries a failed bench until MAX_ATTEMPTS", () => {
    const s: WatchState = { seen: { "@cf/a/old": "x" }, runs: { "@cf/a/old": { at: "x", ok: false, attempts: 2 } } };
    expect(plan([catalog[0]!], s, DEFAULT_FILTER, { max: 1 }).bench).toHaveLength(1);
    s.runs["@cf/a/old"]!.attempts = 3;
    expect(plan([catalog[0]!], s, DEFAULT_FILTER, { max: 1 }).bench).toHaveLength(0);
  });

  it("force benches a seen model, even on the first run, ahead of new ones", () => {
    expect(plan(catalog, { seen: {}, runs: {} }, DEFAULT_FILTER, { max: 1, force: ["@cf/a/old"] }).bench.map((c) => c.id)).toEqual(["@cf/a/old"]);
    expect(plan(catalog, seenOld, DEFAULT_FILTER, { max: 2, force: ["@cf/a/old"] }).bench.map((c) => c.id)).toEqual(["@cf/a/old", "@cf/c/new2"]);
  });
});

describe("buildSpec", () => {
  it("adds one arm per model with subagents on the same model and keeps the reference arm", () => {
    const spec = buildSpec({ arms: { ref: { model: "@cf/r/ref" } }, tasks: [] }, ["@cf/qwen/qwen3.8-27b"]);
    expect(spec.arms).toEqual({
      ref: { model: "@cf/r/ref" },
      "qwen3.8-27b": { model: "@cf/qwen/qwen3.8-27b", exploreModel: "@cf/qwen/qwen3.8-27b", taskModel: "@cf/qwen/qwen3.8-27b" },
    });
    expect(armName("@cf/x/y:z")).toBe("y-z");
  });
});
