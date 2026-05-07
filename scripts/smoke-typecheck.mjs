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

await check("extraStrict catches unused locals", async () => {
  const ws = makeWorkspace({
    "/src/unused.ts": `export function f() { const x = 1; return 2; }\n`,
  });
  const cleanResult = await runTypecheck(ws);
  expect(cleanResult.ok, "ok without extraStrict").toBe(true);

  const strictResult = await runTypecheck(ws, { extraStrict: true });
  expect(strictResult.ok, "ok with extraStrict").toBe(false);
  const codes = strictResult.diagnostics.map((d) => d.code);
  // 6133 = "'x' is declared but its value is never read."
  expect(codes.includes(6133), "diagnostic 6133 surfaced").toBe(true);
});

await check("extraStrict catches implicit returns", async () => {
  // The return-type union with `undefined` is essential — without it, TS
  // emits TS2366 from regular type checking, which would mask the
  // noImplicitReturns-specific TS7030 we want to assert.
  const ws = makeWorkspace({
    "/src/cond.ts": `export function f(x: boolean): number | undefined { if (x) { return 1; } }\n`,
  });
  const cleanResult = await runTypecheck(ws);
  expect(cleanResult.ok, "ok without extraStrict").toBe(true);

  const strictResult = await runTypecheck(ws, { extraStrict: true });
  expect(strictResult.ok, "ok with extraStrict").toBe(false);
  const codes = strictResult.diagnostics.map((d) => d.code);
  // 7030 = "Not all code paths return a value."
  expect(codes.includes(7030), "diagnostic 7030 surfaced").toBe(true);
});

await check("extraStrict catches switch fall-through", async () => {
  const ws = makeWorkspace({
    "/src/sw.ts": `export function f(x: number): string {
  switch (x) {
    case 1:
      console.log("one");
    case 2:
      return "two";
    default:
      return "other";
  }
}\n`,
  });
  const cleanResult = await runTypecheck(ws);
  expect(cleanResult.ok, "ok without extraStrict").toBe(true);

  const strictResult = await runTypecheck(ws, { extraStrict: true });
  expect(strictResult.ok, "ok with extraStrict").toBe(false);
  // 7029 = "Fallthrough case in switch."
  const codes = strictResult.diagnostics.map((d) => d.code);
  expect(codes.includes(7029), "diagnostic 7029 surfaced").toBe(true);
});

await check("extraStrict catches unused parameters", async () => {
  const ws = makeWorkspace({
    "/src/p.ts": `export function f(used: number, unused: string): number { return used; }\n`,
  });
  const cleanResult = await runTypecheck(ws);
  expect(cleanResult.ok, "ok without extraStrict").toBe(true);

  const strictResult = await runTypecheck(ws, { extraStrict: true });
  expect(strictResult.ok, "ok with extraStrict").toBe(false);
  // 6133 also covers parameters; both noUnusedLocals and noUnusedParameters
  // surface as 6133 in modern TS.
  const codes = strictResult.diagnostics.map((d) => d.code);
  expect(codes.includes(6133), "diagnostic 6133 surfaced").toBe(true);
});

await check("extraStrict overrides tsconfig that disables the flags", async () => {
  const ws = makeWorkspace({
    "/tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        noUnusedLocals: false,
        noUnusedParameters: false,
      },
    }),
    "/src/unused.ts": `export function f(unused: number) { const y = 1; return 2; }\n`,
  });
  const lax = await runTypecheck(ws);
  expect(lax.ok, "ok without extraStrict").toBe(true);

  const strict = await runTypecheck(ws, { extraStrict: true });
  expect(strict.ok, "ok with extraStrict").toBe(false);
});

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall checks passed");
