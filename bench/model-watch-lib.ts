/**
 * Pure parts of bench/model-watch.ts: read the Workers AI catalog, decide which
 * models are new and worth a bench, and build the model-ab spec. No I/O here,
 * so test/model-watch.test.ts can cover it.
 */

/** One entry of GET /accounts/:id/ai/models/search. Only the fields we read. */
export interface CatalogModel {
  name: string;
  created_at?: string;
  task?: { name?: string };
  properties?: Array<{ property_id: string; value: unknown }>;
}

export interface Candidate {
  id: string;
  createdAt: string;
  contextWindow: number;
  functionCalling: boolean;
  /** USD per million tokens, when the catalog lists a price. */
  priceIn?: number;
  priceOut?: number;
  deprecated: boolean;
}

export interface Filter {
  /** Smallest context window worth running a coding agent on. */
  minContext: number;
  /** Skip models whose input price is above this (USD per M tokens). */
  maxPriceIn: number;
  /** Ids (exact) or prefixes ending in "*" to never bench. */
  exclude: string[];
}

export const DEFAULT_FILTER: Filter = { minContext: 131_072, maxPriceIn: 3, exclude: [] };

export interface WatchState {
  /** Model id → when the watcher first saw it. */
  seen: Record<string, string>;
  /** Model id → last bench attempt. */
  runs: Record<string, { at: string; ok: boolean; attempts: number; runDir?: string; error?: string }>;
}

export const MAX_ATTEMPTS = 3;

function prop(m: CatalogModel, id: string): unknown {
  return m.properties?.find((p) => p.property_id === id)?.value;
}

export function toCandidate(m: CatalogModel, now = new Date()): Candidate {
  const price = prop(m, "price");
  const priceOf = (unit: string) =>
    Array.isArray(price) ? (price as Array<{ unit?: string; price?: number }>).find((p) => p.unit === unit)?.price : undefined;
  const deprecation = prop(m, "planned_deprecation_date");
  return {
    id: m.name,
    createdAt: m.created_at ?? "",
    contextWindow: Number(prop(m, "context_window") ?? 0),
    functionCalling: String(prop(m, "function_calling")) === "true",
    priceIn: priceOf("per M input tokens"),
    priceOut: priceOf("per M output tokens"),
    deprecated: typeof deprecation === "string" && deprecation !== "" && new Date(deprecation) <= now,
  };
}

/** Why a model is not benchable, or undefined when it is. */
export function rejectReason(c: Candidate, f: Filter): string | undefined {
  if (!c.id.startsWith("@cf/")) return "not a Workers AI id";
  if (f.exclude.some((e) => (e.endsWith("*") ? c.id.startsWith(e.slice(0, -1)) : c.id === e))) return "excluded";
  if (!c.functionCalling) return "no function calling";
  if (c.contextWindow < f.minContext) return `context ${c.contextWindow} < ${f.minContext}`;
  if (c.deprecated) return "deprecated";
  if (c.priceIn !== undefined && c.priceIn > f.maxPriceIn) return `input price $${c.priceIn}/M > $${f.maxPriceIn}/M`;
  return undefined;
}

export interface Plan {
  /** Models to bench now, oldest first. */
  bench: Candidate[];
  /** Newly seen models that won't be benched, with the reason. */
  skipped: Array<{ id: string; reason: string }>;
  /** Ids to add to state.seen. */
  newlySeen: string[];
  /** Benchable but over --max: left unseen for the next run. */
  deferred: string[];
}

/**
 * Decide what to do with the current catalog.
 * - First run (empty state): mark everything seen, bench nothing. Otherwise
 *   the first run would bench the whole catalog.
 * - A model is benched when it is not yet seen, or was seen but its bench
 *   failed fewer than MAX_ATTEMPTS times.
 * - `force` ids are benched regardless (if in the catalog).
 */
export function plan(catalog: Candidate[], state: WatchState, f: Filter, opts: { max: number; force?: string[] }): Plan {
  const firstRun = Object.keys(state.seen).length === 0;
  const out: Plan = { bench: [], skipped: [], newlySeen: [], deferred: [] };
  const byAge = [...catalog].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const c of byAge) {
    const isNew = !state.seen[c.id];
    if (isNew) out.newlySeen.push(c.id);
    if (opts.force?.includes(c.id)) {
      out.bench.push(c);
      continue;
    }
    if (firstRun) continue;
    const run = state.runs[c.id];
    const retry = !isNew && run && !run.ok && run.attempts < MAX_ATTEMPTS;
    if (!isNew && !retry) continue;
    const reason = rejectReason(c, f);
    if (reason) {
      if (isNew) out.skipped.push({ id: c.id, reason });
      continue;
    }
    out.bench.push(c);
  }
  // Forced first, then oldest new; cap the batch so one catalog dump can't run up a bill.
  const forced = out.bench.filter((c) => opts.force?.includes(c.id));
  const rest = out.bench.filter((c) => !opts.force?.includes(c.id));
  const room = Math.max(0, opts.max - forced.length);
  out.bench = [...forced, ...rest.slice(0, room)];
  // Over the cap: leave unseen so the next run picks them up.
  out.deferred = rest.slice(room).map((c) => c.id);
  out.newlySeen = out.newlySeen.filter((id) => !out.deferred.includes(id));
  return out;
}

/** Short arm name for a model id: "@cf/qwen/qwen3.8-27b" → "qwen3.8-27b". */
export function armName(id: string): string {
  return id.split("/").pop()!.replace(/[^A-Za-z0-9._-]/g, "-");
}

export interface SpecArm {
  model: string;
  exploreModel?: string;
  taskModel?: string;
}

/** The auto spec plus one arm per model under test (main + subagents all on that model). */
export function buildSpec<S extends { arms: Record<string, SpecArm> }>(template: S, models: string[]): S {
  const arms: Record<string, SpecArm> = { ...template.arms };
  for (const m of models) arms[armName(m)] = { model: m, exploreModel: m, taskModel: m };
  return { ...template, arms };
}

/** Markdown header for the results note. */
export function summaryHeader(models: Candidate[], refArms: Record<string, SpecArm>, meta: { date: string; runDir: string; dodoCommit?: string; fixture?: string }): string {
  const price = (c: Candidate) => (c.priceIn !== undefined ? `$${c.priceIn} in / $${c.priceOut ?? "?"} out per M` : "price not listed");
  return [
    "---",
    "tags: [research, dodo, models, benchmark, model-ab, auto]",
    "source: bench/model-watch.ts (launchd, unattended)",
    "---",
    "",
    `# Dodo model A/B: ${models.map((m) => armName(m.id)).join(", ")} (${meta.date})`,
    "",
    "Run by `bench/model-watch.ts` because the model(s) below appeared in the Workers AI catalog.",
    "",
    ...models.map((m) => `- \`${m.id}\`: added ${m.createdAt.slice(0, 10)}, context ${m.contextWindow.toLocaleString("en-US")}, ${price(m)}`),
    ...Object.entries(refArms).map(([name, a]) => `- reference arm \`${name}\`: \`${a.model}\``),
    `- Dodo prod commit: ${meta.dodoCommit ?? "unknown"}. Fixture: ${meta.fixture ?? "bench/base, bench/bugfix-base"}.`,
    "- Every arm runs main model and subagents on the same model. Tasks match the hand-run 10-20 / 10-21 benches; bugfix and refactor are graded by hidden tests (`bench/verify/`).",
    `- Artifacts: \`${meta.runDir}\``,
    "",
    "## Results",
    "",
  ].join("\n");
}
