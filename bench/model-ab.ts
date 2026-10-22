/**
 * Model A/B harness: run the same tasks on several models, side by side, on a
 * live Dodo, then grade and price each run.
 *
 * Each (task, arm) pair gets its own session, pinned to the arm's models with
 * the per-session override (`model` / `exploreModel` / `taskModel` on POST
 * /session/:id/prompt). The owner's saved config is never touched, so arms can
 * run at the same time and subagents run on the arm's models too.
 *
 * Per run it records: wall time, prompt status, session token totals, and
 * (when Cloudflare credentials are set) AI Gateway requests, non-200s, tokens
 * and cost, split into main model vs subagents. Dodo tags every AI Gateway
 * request with `cf-aig-metadata: {dodo_session, dodo_role}`, so cost is exact
 * per session even when two arms share a model.
 *
 * A task can name files to pull out of the session workspace and a local
 * `verify` command (for example: copy the agent's file into a checkout and run
 * a hidden test). Exit code 0 = pass.
 *
 * Any run that doesn't complete keeps the session's engine detail, prompts and
 * messages in <run dir>/<task>-<arm>/<status>/ (timeout, failed, aborted, or
 * error when the harness itself failed, polling included), saved before the
 * abort and the session delete.
 *
 * Run (Node 24 strips the types itself):
 *   node bench/model-ab.ts bench/model-ab.example.json [--base https://dodo.example.com] [--tasks explore,refactor] [--keep] [--out bench/out | --run-dir dir]
 *
 * Unattended, on every new Workers AI model: bench/model-watch.ts.
 *
 * Auth to Dodo: Access service token from DODO_ACCESS_CLIENT_ID +
 * DODO_ACCESS_CLIENT_SECRET, or the macOS keychain item "dodo-smoke-access"
 * (same as scripts/lib/smoke-auth.sh).
 * Cost: CLOUDFLARE_API_TOKEN (AI Gateway read) + CLOUDFLARE_ACCOUNT_ID, gateway
 * id from the spec's `gateway` or AI_GATEWAY_ID. Without them cost is skipped.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ─── Spec ───

interface Arm {
  model: string;
  exploreModel?: string;
  taskModel?: string;
}

interface Task {
  id: string;
  prompt: string;
  /** Start from a copy of this session (e.g. one with a repo already cloned and a bug planted). `${VAR}` reads the env. */
  fork?: string;
  /** Or clone this repo into a fresh session first. */
  clone?: { url: string; dir?: string; branch?: string };
  /** Workspace paths to download into <out>/<task>-<arm>/ after the run. */
  collect?: string[];
  /** Local shell command run after the run. Env: BENCH_TASK, BENCH_ARM, BENCH_SESSION, BENCH_OUT, BENCH_ANSWER (file). */
  verify?: string;
  /** Minutes before a run counts as timed out. Default 30. */
  timeoutMinutes?: number;
}

interface Spec {
  base?: string;
  gateway?: string;
  arms: Record<string, Arm>;
  tasks: Task[];
}

interface GatewayStats {
  requests: number;
  errors: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  byRole: Record<string, { requests: number; cost: number; models: string[] }>;
}

interface RunResult {
  task: string;
  arm: string;
  sessionId: string;
  models: Arm;
  /** What the session reported after the run: proves the override took. */
  sessionModels?: { model: string; exploreModel?: string; taskModel?: string };
  status: string;
  wallSeconds: number;
  tokenInput: number;
  tokenOutput: number;
  answer: string;
  verify?: { passed: boolean; output: string };
  gateway?: GatewayStats;
  error?: string;
}

// ─── CLI ───

function parseArgs(argv: string[]) {
  const args = { spec: "", base: "", tasks: [] as string[], arms: [] as string[], keep: false, out: "bench/out", runDir: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--base") args.base = argv[++i]!;
    else if (a === "--tasks") args.tasks = argv[++i]!.split(",");
    else if (a === "--arms") args.arms = argv[++i]!.split(",");
    else if (a === "--keep") args.keep = true;
    else if (a === "--out") args.out = argv[++i]!;
    else if (a === "--run-dir") args.runDir = argv[++i]!;
    else if (!args.spec) args.spec = a;
  }
  if (!args.spec) {
    console.error("usage: node bench/model-ab.ts <spec.json> [--base URL] [--tasks a,b] [--arms x,y] [--keep] [--out dir | --run-dir dir]");
    process.exit(2);
  }
  return args;
}

// ─── Dodo client ───

function keychain(account: string): string | undefined {
  try {
    return execFileSync("security", ["find-generic-password", "-s", "dodo-smoke-access", "-a", account, "-w"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

function makeDodo(base: string) {
  const id = process.env.DODO_ACCESS_CLIENT_ID ?? keychain("client_id");
  const secret = process.env.DODO_ACCESS_CLIENT_SECRET ?? keychain("client_secret");
  const auth: Record<string, string> = id && secret ? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } : {};
  if (!id) console.warn("No Access service token found: requests go out unauthenticated.");

  async function req<T>(method: string, path: string, body?: unknown, opts: { timeoutMs?: number; retries?: number } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: { ...auth, ...(body !== undefined ? { "content-type": "application/json" } : {}), "user-agent": "dodo-model-ab/1" },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          redirect: "manual",
          signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
        return (text ? JSON.parse(text) : {}) as T;
      } catch (err) {
        // Retry network blips, not HTTP errors. Never re-send a POST that timed
        // out: it may have landed (a second prompt run, billed twice).
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        if (attempt >= (opts.retries ?? 3) || (err instanceof Error && /→ \d{3}/.test(err.message)) || (timedOut && method === "POST")) throw err;
        await sleep(3000);
      }
    }
  }
  return {
    get: <T>(p: string, opts?: { timeoutMs?: number; retries?: number }) => req<T>("GET", p, undefined, opts),
    post: <T>(p: string, b: unknown = {}) => req<T>("POST", p, b),
    del: (p: string) => req<unknown>("DELETE", p),
  };
}
type Dodo = ReturnType<typeof makeDodo>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── One run ───

/** `${VAR}` in a spec string → the environment variable. */
function expandEnv(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    const v = process.env[name];
    if (!v) throw new Error(`spec needs \${${name}}`);
    return v;
  });
}

/** Fork or create the run's session. `onId` gets the id before the clone, so a failed clone still leaves an id to clean up. */
async function prepareSession(dodo: Dodo, task: Task, onId: (id: string) => void): Promise<void> {
  if (task.fork) return onId((await dodo.post<{ id: string }>(`/session/${expandEnv(task.fork)}/fork`)).id);
  const { id } = await dodo.post<{ id: string }>("/session");
  onId(id);
  if (task.clone) await dodo.post(`/session/${id}/git/clone`, { url: task.clone.url, dir: task.clone.dir, branch: task.clone.branch });
}

/**
 * Save what the session was doing when a run didn't complete, before the abort
 * and the session delete wipe it: pi live tasks + transcript
 * (engine?detail=1), prompt history, messages. Goes to <runDir>/<reason>/.
 * Best effort: each endpoint is written or its error is. Short timeout, no
 * retries: the agent may still be running (and billing) until the abort.
 */
async function saveEvidence(dodo: Dodo, sessionId: string, runDir: string, reason: string): Promise<void> {
  const dir = join(runDir, reason);
  mkdirSync(dir, { recursive: true });
  const endpoints: Array<[string, string]> = [
    ["engine.json", `/session/${sessionId}/engine?detail=1`],
    ["prompts.json", `/session/${sessionId}/prompts`],
    ["messages.json", `/session/${sessionId}/messages`],
  ];
  await Promise.all(
    endpoints.map(async ([file, path]) => {
      try {
        writeFileSync(join(dir, file), JSON.stringify(await dodo.get<unknown>(path, { timeoutMs: 30_000, retries: 0 }), null, 1));
      } catch (err) {
        writeFileSync(join(dir, file), JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    }),
  );
}

async function waitForPrompt(dodo: Dodo, sessionId: string, promptId: string, timeoutMs: number, runDir: string): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let failures = 0;
  while (Date.now() < deadline) {
    await sleep(10_000);
    try {
      const { prompts } = await dodo.get<{ prompts: Array<{ id: string; status: string }> }>(`/session/${sessionId}/prompts`);
      failures = 0;
      const p = prompts.find((x) => x.id === promptId);
      if (p && !["queued", "running"].includes(p.status)) return p.status;
    } catch (err) {
      // One slow or 5xx poll must not end a 30-minute run.
      if (++failures >= 6) throw err;
    }
  }
  // One last look before aborting: the deadline may have passed while this
  // process was suspended (laptop asleep) and the prompt finished meanwhile.
  try {
    const { prompts } = await dodo.get<{ prompts: Array<{ id: string; status: string }> }>(`/session/${sessionId}/prompts`);
    const p = prompts.find((x) => x.id === promptId);
    if (p && !["queued", "running"].includes(p.status)) return p.status;
  } catch {}
  await saveEvidence(dodo, sessionId, runDir, "timeout").catch((err) => log(`${sessionId}: could not save timeout evidence: ${(err as Error).message}`));
  await dodo.post(`/session/${sessionId}/abort`).catch(() => {});
  return "timeout";
}

async function lastAssistantText(dodo: Dodo, sessionId: string): Promise<string> {
  const { messages } = await dodo.get<{ messages: Array<{ role: string; content: string }> }>(`/session/${sessionId}/messages`);
  return [...messages].reverse().find((m) => m.role === "assistant")?.content ?? "";
}

async function runOne(dodo: Dodo, task: Task, armName: string, arm: Arm, outDir: string): Promise<RunResult> {
  const result: RunResult = { task: task.id, arm: armName, sessionId: "", models: arm, status: "error", wallSeconds: 0, tokenInput: 0, tokenOutput: 0, answer: "" };
  const runDir = join(outDir, `${task.id}-${armName}`);
  try {
    await prepareSession(dodo, task, (id) => {
      result.sessionId = id;
    });
    const t0 = Date.now();
    const sent = await dodo.post<{ promptId: string }>(`/session/${result.sessionId}/prompt`, {
      content: task.prompt,
      model: arm.model,
      ...(arm.exploreModel ? { exploreModel: arm.exploreModel } : {}),
      ...(arm.taskModel ? { taskModel: arm.taskModel } : {}),
    });
    log(`${task.id}/${armName}: ${result.sessionId} prompt ${sent.promptId}`);
    result.status = await waitForPrompt(dodo, result.sessionId, sent.promptId, (task.timeoutMinutes ?? 30) * 60_000, runDir);
    result.wallSeconds = Math.round((Date.now() - t0) / 1000);
    // failed / aborted: keep the evidence too (timeout already saved its own).
    if (result.status !== "completed" && result.status !== "timeout") {
      await saveEvidence(dodo, result.sessionId, runDir, result.status).catch((err) => log(`${result.sessionId}: could not save ${result.status} evidence: ${(err as Error).message}`));
    }

    const s = await dodo.get<{ model: string; exploreModel?: string; taskModel?: string; totalTokenInput: number; totalTokenOutput: number }>(`/session/${result.sessionId}`);
    result.sessionModels = { model: s.model, exploreModel: s.exploreModel, taskModel: s.taskModel };
    result.tokenInput = s.totalTokenInput;
    result.tokenOutput = s.totalTokenOutput;
    result.answer = await lastAssistantText(dodo, result.sessionId);

    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "answer.md"), result.answer);
    for (const path of task.collect ?? []) {
      try {
        const { content } = await dodo.get<{ content: string }>(`/session/${result.sessionId}/file?path=${encodeURIComponent(path)}`);
        const dest = join(runDir, "files", path.replace(/^\/+/, ""));
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, content);
      } catch (err) {
        log(`${task.id}/${armName}: could not collect ${path}: ${(err as Error).message}`);
      }
    }
    log(`${task.id}/${armName}: ${result.status} in ${result.wallSeconds}s`);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    log(`${task.id}/${armName}: ERROR ${result.error}`);
    // Keep the evidence (polling died, a GET failed...), then don't leave the
    // agent running (and billing) until cleanup.
    if (result.sessionId) {
      await saveEvidence(dodo, result.sessionId, runDir, "error").catch((err) => log(`${result.sessionId}: could not save error evidence: ${(err as Error).message}`));
      await dodo.post(`/session/${result.sessionId}/abort`).catch(() => {});
    }
  }
  return result;
}

/** The environment minus credentials: verify runs tests the model under test wrote. */
function verifyEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ["CLOUDFLARE_API_TOKEN", "DODO_ACCESS_CLIENT_ID", "DODO_ACCESS_CLIENT_SECRET"]) delete env[k];
  return env;
}

function runVerify(task: Task, result: RunResult, outDir: string) {
  const runDir = join(outDir, `${task.id}-${result.arm}`);
  const v = spawnSync("sh", ["-c", task.verify!], {
    encoding: "utf8",
    env: { ...verifyEnv(), BENCH_TASK: task.id, BENCH_ARM: result.arm, BENCH_SESSION: result.sessionId, BENCH_OUT: resolve(runDir), BENCH_ANSWER: resolve(runDir, "answer.md") },
    timeout: 15 * 60_000,
  });
  const output = `${v.stdout ?? ""}${v.stderr ?? ""}`;
  writeFileSync(join(runDir, "verify.log"), output);
  result.verify = { passed: v.status === 0, output: output.trim().split("\n").slice(-8).join("\n") };
  log(`${task.id}/${result.arm}: verify ${result.verify.passed ? "PASS" : "FAIL"}`);
}

// ─── AI Gateway cost ───

interface GatewayLog {
  id?: string;
  model: string;
  cost?: number;
  tokens_in: number | null;
  tokens_out: number | null;
  status_code?: number;
  success: boolean;
  /** The API returns an object; older responses used a JSON string. */
  metadata?: string | Record<string, string>;
}

async function gatewayStats(sessionId: string, gateway: string): Promise<GatewayStats | undefined> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account || !gateway) return undefined;
  const logs: GatewayLog[] = [];
  for (let page = 1; page < 100; page++) {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${account}/ai-gateway/gateways/${gateway}/logs`);
    url.searchParams.set("search", sessionId);
    url.searchParams.set("per_page", "50");
    url.searchParams.set("page", String(page));
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`AI Gateway logs → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { result: GatewayLog[]; result_info?: { total_count?: number } };
    const before = logs.length;
    for (const l of body.result) if (!l.id || !logs.some((x) => x.id === l.id)) logs.push(l);
    const total = body.result_info?.total_count;
    // Stop on an empty page, a page with nothing new (pages shifting or `page` ignored), total reached, or a short page.
    if (body.result.length === 0 || logs.length === before || (total !== undefined ? logs.length >= total : body.result.length < 50)) break;
    if (page === 99) log(`AI Gateway logs for ${sessionId}: stopped at 99 pages, cost is a lower bound`);
  }
  const stats: GatewayStats = { requests: 0, errors: 0, tokensIn: 0, tokensOut: 0, cost: 0, byRole: {} };
  for (const l of logs) {
    let meta: { dodo_session?: string; dodo_role?: string } = {};
    if (typeof l.metadata === "string") {
      try {
        meta = JSON.parse(l.metadata);
      } catch {}
    } else if (l.metadata) meta = l.metadata;
    // `search` is free text; keep only exact matches.
    if (meta.dodo_session !== sessionId) continue;
    const role = meta.dodo_role ?? "unknown";
    stats.requests++;
    if (!l.success || (l.status_code !== undefined && l.status_code !== 200)) stats.errors++;
    stats.tokensIn += l.tokens_in ?? 0;
    stats.tokensOut += l.tokens_out ?? 0;
    stats.cost += l.cost ?? 0;
    const r = (stats.byRole[role] ??= { requests: 0, cost: 0, models: [] });
    r.requests++;
    r.cost += l.cost ?? 0;
    if (!r.models.includes(l.model)) r.models.push(l.model);
  }
  return stats;
}

// ─── Report ───

function table(results: RunResult[], arms: string[]): string {
  const tasks = [...new Set(results.map((r) => r.task))];
  const cell = (r: RunResult | undefined) => {
    if (!r) return "—";
    if (r.error) return `error: ${r.error.slice(0, 40)}`;
    const cost = r.gateway ? ` / $${r.gateway.cost.toFixed(3)} / ${r.gateway.requests} req` : "";
    const v = r.verify ? (r.verify.passed ? " ✓" : " ✗") : "";
    return `${r.status === "completed" ? "" : `${r.status} `}${r.wallSeconds}s${cost}${v}`;
  };
  const lines = [
    `| task | ${arms.join(" | ")} |`,
    `|---|${arms.map(() => "---").join("|")}|`,
    ...tasks.map((t) => `| ${t} | ${arms.map((a) => cell(results.find((r) => r.task === t && r.arm === a))).join(" | ")} |`),
  ];
  const totals = arms.map((a) => {
    const rs = results.filter((r) => r.arm === a);
    const wall = rs.reduce((s, r) => s + r.wallSeconds, 0);
    const cost = rs.every((r) => r.gateway) ? ` / $${rs.reduce((s, r) => s + (r.gateway?.cost ?? 0), 0).toFixed(3)}` : "";
    const passed = rs.filter((r) => r.verify?.passed).length;
    const graded = rs.filter((r) => r.verify).length;
    return `${wall}s${cost}${graded ? ` / ${passed}/${graded} pass` : ""}`;
  });
  lines.push(`| **total** | ${totals.join(" | ")} |`);
  lines.push("", "Cell: wall time / AI Gateway cost (main + subagents) / requests, ✓/✗ = verify. n=1 per cell.");
  const leaks = results.filter((r) => r.sessionModels && r.sessionModels.model !== r.models.model);
  if (leaks.length) lines.push("", `WARNING: override did not take in ${leaks.map((r) => `${r.task}/${r.arm}`).join(", ")}`);
  return lines.join("\n");
}

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

// ─── Main ───

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const spec = JSON.parse(readFileSync(args.spec, "utf8")) as Spec;
  const base = (args.base || spec.base || process.env.DODO_BASE_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("No Dodo URL: pass --base, set spec.base or DODO_BASE_URL");
  const gateway = spec.gateway ?? process.env.AI_GATEWAY_ID ?? "";
  const armNames = args.arms.length ? args.arms : Object.keys(spec.arms);
  const tasks = args.tasks.length ? spec.tasks.filter((t) => args.tasks.includes(t.id)) : spec.tasks;
  // --run-dir: write exactly here (bench/model-watch.ts uses it). --out: a new timestamped dir under it.
  const outDir = args.runDir || join(args.out, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(outDir, { recursive: true });
  const dodo = makeDodo(base);
  log(`${base}: ${tasks.length} task(s) × ${armNames.length} arm(s) → ${outDir}`);

  const results: RunResult[] = [];
  // Tasks one at a time, arms in parallel: one session per arm, so arms don't
  // share a per-model rate limit and finish in about the same wall time.
  for (const task of tasks) {
    const batch = await Promise.all(armNames.map((a) => runOne(dodo, task, a, spec.arms[a]!, outDir)));
    // Verify after the whole batch, one at a time: verifiers share one checkout,
    // and a blocking verify mid-batch would stall the other arms' polling and
    // inflate their wall time.
    for (const r of batch) if (task.verify && !r.error) runVerify(task, r, outDir);
    results.push(...batch);
    writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 1));
  }

  if (gateway && process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) {
    log("Pulling AI Gateway logs (waiting 60s for them to land)…");
    await sleep(60_000);
    for (const r of results) {
      if (!r.sessionId) continue;
      try {
        r.gateway = await gatewayStats(r.sessionId, gateway);
      } catch (err) {
        log(`${r.task}/${r.arm}: gateway pull failed: ${(err as Error).message}`);
      }
    }
  } else {
    log("Skipping cost: set CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and spec.gateway / AI_GATEWAY_ID.");
  }

  if (!args.keep) {
    for (const r of results) if (r.sessionId) await dodo.del(`/session/${r.sessionId}`).catch(() => {});
  }
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 1));
  const report = table(results, armNames);
  writeFileSync(join(outDir, "report.md"), `${report}\n`);
  console.log(`\n${report}\n\n${outDir}/results.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
