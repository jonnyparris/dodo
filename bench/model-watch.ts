/**
 * Watch the Workers AI catalog and run the model A/B bench on every new model.
 *
 * Each run:
 *   1. Lists Workers AI text-generation models (Cloudflare API).
 *   2. Compares them with the state file. New models that pass the filter
 *      (function calling, context >= 128K, priced at <= $3/M in and <= $10/M
 *      out, not deprecated) get a bench, at most --max per run; the rest wait
 *      for the next run. Rejected models are re-checked every run. The first
 *      run only records what is already there.
 *   3. Brings the throwaway verifier checkout (DODO_CHECKOUT) up to the pinned
 *      fixture branches (bench/base, bench/bugfix-base; see scripts/bench-seed.sh).
 *   4. Runs bench/model-ab.ts with the auto spec plus one arm per new model,
 *      next to the reference arm, and writes summary.md (a results note).
 *   5. With --report-dir, copies summary.md there as
 *      YYYY-MM-DD-dodo-model-ab-<model>.md.
 *
 * A bench where no new-model run completed (Dodo down, model not serving,
 * crash) is retried on the next run, up to 3 attempts. One run at a time
 * (lock file next to the state file).
 *
 * Run (Node 24):
 *   node bench/model-watch.ts [--spec bench/model-ab.auto.json] [--state FILE]
 *     [--checkout DIR] [--out DIR] [--report-dir DIR] [--max 1]
 *     [--model @cf/x/y]   bench this model now, new or not (repeatable)
 *     [--dry-run]         print the plan, change nothing
 *
 * Env: CLOUDFLARE_API_TOKEN (Workers AI read + AI Gateway read),
 * CLOUDFLARE_ACCOUNT_ID, plus Dodo auth as in bench/model-ab.ts.
 * Defaults: state ~/.local/state/dodo-model-watch/state.json, checkout
 * ~/.local/state/dodo-model-watch/checkout, out ~/.local/state/dodo-model-watch/runs.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyPlan,
  lastPage,
  armName,
  benchOk,
  buildSpec,
  canRetry,
  type Candidate,
  type CatalogModel,
  DEFAULT_FILTER,
  MAX_ATTEMPTS,
  plan,
  type SpecArm,
  summaryHeader,
  toCandidate,
  type WatchState,
} from "./model-watch-lib.ts";

interface AutoSpec {
  base?: string;
  gateway?: string;
  checkout?: { url: string; branches: string[] };
  filter?: Partial<typeof DEFAULT_FILTER>;
  arms: Record<string, SpecArm>;
  tasks: unknown[];
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateHome = join(homedir(), ".local/state/dodo-model-watch");
const log = (msg: string) => console.log(`[${new Date().toISOString().slice(0, 19)}Z] ${msg}`);

function parseArgs(argv: string[]) {
  const a = {
    spec: join(repoRoot, "bench/model-ab.auto.json"),
    state: join(stateHome, "state.json"),
    checkout: process.env.DODO_CHECKOUT || join(stateHome, "checkout"),
    out: join(stateHome, "runs"),
    reportDir: "",
    max: 1,
    force: [] as string[],
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = () => argv[++i]!;
    if (k === "--spec") a.spec = v();
    else if (k === "--state") a.state = v();
    else if (k === "--checkout") a.checkout = v();
    else if (k === "--out") a.out = v();
    else if (k === "--report-dir") a.reportDir = v();
    else if (k === "--max") {
      a.max = Number(v());
      if (!Number.isInteger(a.max) || a.max < 0) throw new Error("--max must be an integer >= 0");
    }
    else if (k === "--model") a.force.push(v());
    else if (k === "--dry-run") a.dryRun = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

async function listCatalog(account: string, token: string): Promise<CatalogModel[]> {
  const all: CatalogModel[] = [];
  for (let page = 1; ; page++) {
    if (page > 50) throw new Error("Workers AI catalog: more than 50 pages, giving up");
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/models/search`);
    url.searchParams.set("task", "Text Generation");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Workers AI catalog → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { result: CatalogModel[]; result_info?: { total_count?: number } };
    const before = all.length;
    for (const m of body.result) if (!all.some((x) => x.name === m.name)) all.push(m);
    if (lastPage({ pageLength: body.result.length, perPage: 100, added: all.length - before, total: body.result_info?.total_count, have: all.length })) break;
  }
  return all;
}

function readState(path: string): WatchState {
  if (!existsSync(path)) return { seen: {}, runs: {} };
  return JSON.parse(readFileSync(path, "utf8")) as WatchState;
}

function writeState(path: string, state: WatchState) {
  mkdirSync(dirname(path), { recursive: true });
  // Write + rename: a kill mid-write must not leave truncated JSON that breaks every later run.
  writeFileSync(`${path}.tmp`, `${JSON.stringify(state, null, 1)}\n`);
  renameSync(`${path}.tmp`, path);
}

/** One run at a time (launchd + a manual run would race on state and the shared checkout). */
function lock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  for (let i = 0; i < 3; i++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      return () => rmSync(path, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (lockHeld(path)) throw new Error(`another model-watch is running (lock ${path})`);
    // Stale. Rename (atomic, only one process wins) rather than rm, so a racing
    // process can't delete a lock someone else has just taken.
    const stale = `${path}.stale.${process.pid}`;
    try {
      renameSync(path, stale);
      rmSync(stale, { force: true });
    } catch {}
  }
  throw new Error(`could not take lock ${path}`);
}

function lockHeld(path: string): boolean {
  let pid: number;
  let ageMs: number;
  try {
    pid = Number(readFileSync(path, "utf8"));
    ageMs = Date.now() - statSync(path).mtimeMs;
  } catch {
    return false; // gone: retry
  }
  if (ageMs > 12 * 3600_000) return false; // no bench runs this long; PIDs get reused
  if (!pid) return ageMs < 10_000; // being written right now
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  try {
    return sh("ps", ["-p", String(pid), "-o", "command="]).includes("model-watch");
  } catch {
    return false;
  }
}

function sh(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Clone or refresh the throwaway checkout the verify scripts swap files in. Returns the fixture commits. */
function prepareCheckout(dir: string, checkout: NonNullable<AutoSpec["checkout"]>): string {
  const [main] = checkout.branches;
  if (!main) throw new Error("spec.checkout.branches is empty");
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dirname(dir), { recursive: true });
    sh("git", ["clone", "-q", "--no-tags", "--branch", main, checkout.url, dir]);
  }
  const refspecs = checkout.branches.map((b) => `+refs/heads/${b}:refs/remotes/origin/${b}`);
  sh("git", ["fetch", "-q", "--no-tags", "origin", ...refspecs], dir);
  const before = existsSync(join(dir, "node_modules")) ? sh("git", ["rev-parse", "HEAD"], dir) : "";
  sh("git", ["checkout", "-qf", "--detach", `origin/${main}`], dir);
  const head = sh("git", ["rev-parse", "HEAD"], dir);
  // Reinstall only when the lockfile moved (or on first clone).
  const lockMoved = !before || sh("git", ["diff", "--name-only", before, head, "--", "package-lock.json"], dir) !== "";
  if (lockMoved) {
    log(`npm ci in ${dir}`);
    const r = spawnSync("npm", ["ci", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir, stdio: "inherit" });
    if (r.status !== 0) throw new Error("npm ci failed in the verifier checkout");
  }
  const shas = checkout.branches.map((b) => `${b}@${sh("git", ["rev-parse", "--short=7", "--verify", `origin/${b}`], dir)}`);
  return shas.join(", ");
}

async function dodoCommit(base: string): Promise<string | undefined> {
  try {
    const id = process.env.DODO_ACCESS_CLIENT_ID ?? sh("security", ["find-generic-password", "-s", "dodo-smoke-access", "-a", "client_id", "-w"]);
    const secret = process.env.DODO_ACCESS_CLIENT_SECRET ?? sh("security", ["find-generic-password", "-s", "dodo-smoke-access", "-a", "client_secret", "-w"]);
    const res = await fetch(`${base}/version.json`, { headers: { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    return res.ok ? ((await res.json()) as { commit?: string }).commit : undefined;
  } catch {
    return undefined;
  }
}

interface RunResult {
  arm: string;
  status: string;
  error?: string;
}

async function benchOne(c: Candidate, spec: AutoSpec, args: ReturnType<typeof parseArgs>, meta: { fixture?: string; dodoCommit?: string }): Promise<{ ok: boolean; runDir: string; error?: string; report?: string }> {
  const date = new Date().toISOString().slice(0, 10);
  const runDir = join(args.out, `${new Date().toISOString().replace(/[:.]/g, "-")}-${armName(c.id)}`);
  mkdirSync(runDir, { recursive: true });
  const runSpec = buildSpec(spec, [c.id]);
  const specPath = join(runDir, "spec.json");
  writeFileSync(specPath, `${JSON.stringify(runSpec, null, 1)}\n`);
  log(`bench ${c.id} → ${runDir}`);
  const r = spawnSync(process.execPath, [join(repoRoot, "bench/model-ab.ts"), specPath, "--run-dir", runDir], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, DODO_CHECKOUT: args.checkout },
  });
  const resultsPath = join(runDir, "results.json");
  const results: RunResult[] = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")) : [];
  const mine = results.filter((x) => x.arm === armName(c.id));
  const ok = benchOk(r.status, results, armName(c.id));
  const reportPath = join(runDir, "report.md");
  if (!existsSync(reportPath)) return { ok: false, runDir, error: `model-ab exited ${r.status} without a report` };
  const header = summaryHeader([c], spec.arms, { date, runDir, ...meta });
  const failures = mine.filter((x) => x.error || x.status !== "completed").map((x) => `${x.status}${x.error ? `: ${x.error}` : ""}`);
  const body = `${header}${readFileSync(reportPath, "utf8")}${failures.length ? `\nNew-model runs that did not complete: ${failures.join("; ")}\n` : ""}`;
  const summary = join(runDir, "summary.md");
  writeFileSync(summary, body);
  let report: string | undefined;
  if (args.reportDir) {
    mkdirSync(args.reportDir, { recursive: true });
    // A retry or forced re-run the same day gets -2, -3, … instead of overwriting.
    const stem = join(args.reportDir, `${date}-dodo-model-ab-${armName(c.id)}`);
    report = `${stem}.md`;
    for (let n = 2; existsSync(report); n++) report = `${stem}-${n}.md`;
    copyFileSync(summary, report);
  }
  return { ok, runDir, report, error: ok ? undefined : `new-model arm: ${failures.join("; ") || `model-ab exited ${r.status}`}` };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) throw new Error("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID");
  const spec = JSON.parse(readFileSync(args.spec, "utf8")) as AutoSpec;
  // The reference arm's own model is never "new": benching it against itself proves nothing.
  const refModels = Object.values(spec.arms).map((arm) => arm.model);
  const filter = { ...DEFAULT_FILTER, ...spec.filter, exclude: [...(spec.filter?.exclude ?? DEFAULT_FILTER.exclude), ...refModels] };

  const unlock = args.dryRun ? () => {} : lock(`${args.state}.lock`);
  try {
    await watch(args, account, token, spec, filter);
  } finally {
    unlock();
  }
}

async function watch(args: ReturnType<typeof parseArgs>, account: string, token: string, spec: AutoSpec, filter: typeof DEFAULT_FILTER) {
  const catalog = (await listCatalog(account, token)).map((m) => toCandidate(m));
  const state = readState(args.state);
  const missing = args.force.filter((id) => !catalog.some((c) => c.id === id));
  if (missing.length) throw new Error(`not in the Workers AI catalog: ${missing.join(", ")}`);
  const p = plan(catalog, state, filter, { max: args.max, force: args.force });
  const firstRun = Object.keys(state.seen).length === 0;
  log(`${catalog.length} catalog models; new: ${p.newlySeen.length}${firstRun ? " (first run: recording only)" : ""}; to bench: ${p.bench.map((c) => c.id).join(", ") || "none"}`);
  for (const s of p.skipped) log(`skip ${s.id}: ${s.reason}`);
  if (p.deferred.length) log(`over --max ${args.max}, next run: ${p.deferred.join(", ")}`);
  if (args.dryRun) return;

  // Pending attempts are written before anything can fail, so a crash still counts toward MAX_ATTEMPTS.
  const before = structuredClone(state);
  writeState(args.state, applyPlan(state, p, new Date().toISOString(), args.force));
  if (!p.bench.length) return;

  let fixture: string | undefined;
  try {
    fixture = spec.checkout ? prepareCheckout(args.checkout, spec.checkout) : undefined;
  } catch (err) {
    // Not the model's fault: undo the whole plan (seen, rejected, attempts) so the next run tries again.
    writeState(args.state, before);
    throw err;
  }
  const dodo = await dodoCommit(spec.base ?? "");
  let failed = 0;
  for (const c of p.bench) {
    let res: Awaited<ReturnType<typeof benchOne>>;
    try {
      res = await benchOne(c, spec, args, { fixture, dodoCommit: dodo });
    } catch (err) {
      res = { ok: false, runDir: "", error: err instanceof Error ? err.message : String(err) };
    }
    const keepOld = !res.ok && args.force.includes(c.id) && before.runs[c.id]?.ok;
    if (!keepOld) state.runs[c.id] = { ...state.runs[c.id]!, at: new Date().toISOString(), ok: res.ok, runDir: res.runDir || undefined, error: res.error };
    writeState(args.state, state);
    if (!res.ok) failed++;
    log(`${c.id}: ${res.ok ? "done" : `FAILED (${res.error})`}${res.report ? ` → ${res.report}` : ""}`);
    // Machine-readable line for wrappers.
    const run = state.runs[c.id]!;
    console.log(`MODEL_WATCH_RESULT ${JSON.stringify({ model: c.id, ok: res.ok, runDir: res.runDir, report: res.report, error: res.error, attempts: run.attempts, maxAttempts: MAX_ATTEMPTS, willRetry: canRetry(run) })}`);
  }
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
