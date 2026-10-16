// `ci_run` tool — run a real Node toolchain (npm, vite, vitest, tsc, oxlint,
// wrangler) against a pushed branch in Kitebuild, a BusyBox-on-Workers CI
// runner (https://gitlab.cfdata.org/scardita/kitebuild).
//
// Why: Dodo's `shell` is coreutils in a Worker; it cannot `npm install` or run
// a test suite. Kitebuild can, without a container: each run gets a fresh
// filesystem backed by per-run DO SQLite. Dodo pushes its branch first, then
// asks Kitebuild to clone that branch and run the commands.
//
// Enabled only when KITEBUILD_URL, KITEBUILD_CLIENT_ID and
// KITEBUILD_CLIENT_SECRET (a Cloudflare Access service token for the
// Kitebuild app) are configured. Public repositories only for now: Kitebuild
// logs the commands it runs, so credentials must not ride in a clone URL.

import { tool, zodSchema } from "ai";
import { z } from "zod";

const MAX_STAGE_TAIL_BYTES = 4_000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export interface KitebuildEnv {
  KITEBUILD_URL?: string;
  KITEBUILD_CLIENT_ID?: string;
  KITEBUILD_CLIENT_SECRET?: string;
}

export function kitebuildConfigured(env: KitebuildEnv): boolean {
  return Boolean(env.KITEBUILD_URL && env.KITEBUILD_CLIENT_ID && env.KITEBUILD_CLIENT_SECRET);
}

type CiEvent =
  | { t: "run"; id: string; stages: { name: string; cmd: string }[] }
  | { t: "stage"; i: number; status: "start" | "skipped" }
  | { t: "stage"; i: number; status: "end"; code: number | null; ms: number }
  | { t: "out"; i: number; text: string }
  | { t: "truncated"; maxBytes: number }
  | { t: "error"; message: string }
  | { t: "done"; code: number | null; ms: number; timedOut: boolean; unsupported?: unknown[] }
  | { t: string; [key: string]: unknown };

export interface CiStage {
  cmd: string;
  status: "passed" | "failed" | "skipped" | "not_run";
  code: number | null;
  ms: number | null;
  /** Last few KB of the stage's output. */
  tail: string;
}

export interface CiRunResult {
  runId: string | null;
  passed: boolean;
  code: number | null;
  timedOut: boolean;
  ms: number | null;
  stages: CiStage[];
  error?: string;
  outputTruncated?: boolean;
  unsupported?: unknown[];
}

function tailOf(text: string): string {
  return text.length > MAX_STAGE_TAIL_BYTES ? `…${text.slice(-MAX_STAGE_TAIL_BYTES)}` : text;
}

/** Fold Kitebuild's NDJSON event stream into a compact result. Exported for tests. */
export function foldCiEvents(lines: Iterable<string>, commands: string[]): CiRunResult {
  const out: string[] = commands.map(() => "");
  const stages: CiStage[] = commands.map((cmd) => ({ cmd, status: "not_run", code: null, ms: null, tail: "" }));
  const result: CiRunResult = { runId: null, passed: false, code: null, timedOut: false, ms: null, stages };
  let sawDone = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    let event: CiEvent;
    try {
      event = JSON.parse(line) as CiEvent;
    } catch {
      continue;
    }
    if (event.t === "run") result.runId = String((event as { id: string }).id);
    else if (event.t === "out") {
      const e = event as { i: number; text: string };
      if (out[e.i] !== undefined) out[e.i] = tailOf(out[e.i] + e.text);
    } else if (event.t === "stage") {
      const e = event as { i: number; status: string; code?: number | null; ms?: number };
      const stage = stages[e.i];
      if (!stage) continue;
      if (e.status === "skipped") stage.status = "skipped";
      if (e.status === "end") {
        stage.code = e.code ?? null;
        stage.ms = e.ms ?? null;
        stage.status = e.code === 0 ? "passed" : "failed";
      }
    } else if (event.t === "truncated") result.outputTruncated = true;
    else if (event.t === "error") result.error = String((event as { message: string }).message);
    else if (event.t === "done") {
      const e = event as { code: number | null; ms: number; timedOut: boolean; unsupported?: unknown[] };
      sawDone = true;
      result.code = e.code;
      result.ms = e.ms;
      result.timedOut = e.timedOut;
      if (e.unsupported?.length) result.unsupported = e.unsupported;
    }
  }
  stages.forEach((stage, i) => {
    stage.tail = out[i] ?? "";
  });
  result.passed = sawDone && result.code === 0;
  if (!sawDone && !result.error) result.error = "Kitebuild stream ended without a done event";
  return result;
}

async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      yield buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
    }
  }
  if (buffer) yield buffer;
}

export function buildCiRunTool(env: KitebuildEnv, fetcher: typeof fetch = fetch) {
  return tool({
    description: [
      "Run real Node tooling (npm install/ci, npm test, vitest, tsc, vite build, oxlint, wrangler --dry-run) against a",
      "branch you have ALREADY PUSHED, in a fresh Kitebuild CI sandbox. Use this to verify a change before opening a PR,",
      "since the local `shell` cannot run npm or test suites. Public repositories only. Returns pass/fail per command",
      "with the tail of each command's output. Commands run in order in the repo root (or `subdir`); a failing command",
      "stops the run.",
    ].join(" "),
    inputSchema: zodSchema(
      z.object({
        repoUrl: z.string().url().describe("HTTPS clone URL of a public repo, e.g. https://github.com/owner/repo"),
        branch: z.string().min(1).describe("Branch you pushed"),
        commands: z
          .array(z.string().min(1).max(2_000))
          .min(1)
          .max(10)
          .describe('Commands to run, e.g. ["npm ci", "npm test"]'),
        subdir: z.string().optional().describe("Directory inside the repo to run in, relative to its root"),
      }),
    ),
    execute: async ({ repoUrl, branch, commands, subdir }, { abortSignal }) => {
      if (!kitebuildConfigured(env)) throw new Error("Kitebuild is not configured on this Dodo deployment");
      const url = new URL(repoUrl);
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new Error("repoUrl must be a plain https URL without credentials");
      }
      if (/[^A-Za-z0-9._/-]/.test(branch)) throw new Error("branch contains unsupported characters");
      const root = "/tmp/repo";
      const dir = subdir ? `${root}/${subdir.replace(/^\/+/, "").replace(/\.\./g, "")}` : root;
      const clone = `git clone --depth 1 --branch ${branch} ${repoUrl} ${root}`;
      const all = [clone, ...commands];
      const signal = abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)]) : AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
      const res = await fetcher(`${env.KITEBUILD_URL!.replace(/\/$/, "")}/api/ci-runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "CF-Access-Client-Id": env.KITEBUILD_CLIENT_ID!,
          "CF-Access-Client-Secret": env.KITEBUILD_CLIENT_SECRET!,
        },
        body: JSON.stringify({ commands: all, dir, env: { CI: "true" } }),
        signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`Kitebuild returned HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 500)}`);
      }
      const lines: string[] = [];
      for await (const line of ndjsonLines(res.body)) lines.push(line);
      return foldCiEvents(lines, all);
    },
  });
}
