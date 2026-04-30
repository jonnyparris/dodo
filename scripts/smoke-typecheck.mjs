#!/usr/bin/env node
/**
 * Node-native smoke test for `src/typecheck.ts`.
 *
 * Why a Node script instead of a vitest case: the typecheck-libs.generated.ts
 * file is ~3 MB. vitest-pool-workers' result-shipping path uses a
 * WebSocket between Miniflare and the host; that WS caps messages at 1 MB.
 * Loading the lib map blows the cap and aborts the test pool.
 *
 * Plain Node has no such cap. This script runs the same `runTypecheck`
 * surface the Worker would call, against an in-memory workspace stub
 * shaped like `@cloudflare/shell`'s `Workspace`. Catches regressions in
 * the diagnostic shape, tsconfig honouring, and the file-count guard.
 *
 * Run with `node scripts/smoke-typecheck.mjs` (after `npm install` and
 * `npm run build` so the lib map is generated). Exits non-zero on failure.
 */
import { runTypecheck } from "../src/typecheck.ts";

let failures = 0;

function makeWorkspace(files) {
  return {
    async glob(pattern) {
      const prefix = pattern.replace(/\*\*\/\*\.\{ts,tsx\}$/, "").replace(/\/+$/, "");
      const out = [];
      for (const path of Object.keys(files)) {
        if (!/\.(ts|tsx)$/.test(path)) continue;
        if (prefix && !(path.startsWith(`/${prefix}/`) || path.startsWith(`${prefix}/`))) continue;
        out.push({ path });
      }
      return out;
    },
    async readFile(path) {
      return files[path] ?? files[path.replace(/^\//, "")] ?? null;
    },
    async readDir() {
      return [];
    },
  };
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err?.message ?? err}`);
  }
}

function expect(actual, msg) {
  return {
    toEqual(expected) {
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
    },
    toBe(expected) {
      if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`);
    },
    toMatch(re) {
      if (!re.test(String(actual))) throw new Error(`${msg}: expected ${actual} to match ${re}`);
    },
    toBeGreaterThan(n) {
      if (!(actual > n)) throw new Error(`${msg}: expected > ${n}, got ${actual}`);
    },
  };
}

console.log("smoke-typecheck:");

await check("returns ok=true on a clean program", async () => {
  const ws = makeWorkspace({
    "/src/index.ts": `export const greet = (name: string): string => \`hello \${name}\`;\n`,
  });
  const result = await runTypecheck(ws);
  expect(result.fileCount, "fileCount").toBe(1);
  expect(result.ok, "ok").toBe(true);
  expect(result.diagnostics.length, "diag count").toBe(0);
});

await check("reports type errors with file/line/code/message", async () => {
  const ws = makeWorkspace({
    "/src/bad.ts": `export const n: number = "not a number";\n`,
  });
  const result = await runTypecheck(ws);
  expect(result.ok, "ok").toBe(false);
  expect(result.diagnostics.length, "diag count").toBeGreaterThan(0);
  const d = result.diagnostics[0];
  expect(d.category, "category").toBe("error");
  expect(d.file, "file").toBe("/src/bad.ts");
  expect(d.line, "line").toBe(1);
  expect(d.code, "code").toBe(2322);
  expect(d.message, "message").toMatch(/not assignable/);
});

await check("ok=true with fileCount=0 when there's no TypeScript", async () => {
  const ws = makeWorkspace({ "/README.md": "# nothing\n" });
  const result = await runTypecheck(ws);
  expect(result.fileCount, "fileCount").toBe(0);
  expect(result.ok, "ok").toBe(true);
  expect(result.diagnostics.length, "diag count").toBe(0);
});

await check("refuses oversized projects with skipped.reason='too-large'", async () => {
  const files = {};
  for (let i = 0; i < 51; i++) files[`/src/f${i}.ts`] = `export const v${i} = ${i};\n`;
  const ws = makeWorkspace(files);
  const result = await runTypecheck(ws);
  expect(result.skipped?.reason, "skipped.reason").toBe("too-large");
  expect(result.skipped?.fileCount, "skipped.fileCount").toBe(51);
  expect(result.ok, "ok").toBe(false);
});

await check("honours user tsconfig (strict:false disables noImplicitAny)", async () => {
  const ws = makeWorkspace({
    "/tsconfig.json": JSON.stringify({
      compilerOptions: { strict: false, target: "ES2022", noImplicitAny: false },
    }),
    "/src/lax.ts": "export function f(x) { return x; }\n",
  });
  const result = await runTypecheck(ws);
  expect(result.ok, "ok").toBe(true);
  expect(result.diagnostics.length, "diag count").toBe(0);
});

await check("scopes typecheck to subdirectory via dir option", async () => {
  const ws = makeWorkspace({
    "/repo-a/src/index.ts": `export const ok: number = 1;\n`,
    "/repo-b/src/index.ts": `export const bad: number = "wrong";\n`,
  });
  const result = await runTypecheck(ws, { dir: "/repo-a" });
  expect(result.fileCount, "fileCount").toBe(1);
  expect(result.ok, "ok").toBe(true);
  expect(result.diagnostics.length, "diag count").toBe(0);
});

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall checks passed");
