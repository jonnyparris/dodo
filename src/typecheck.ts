/**
 * In-isolate TypeScript type checker.
 *
 * Runs `tsc --noEmit` against the session workspace using a `ts.sys` shim
 * over `@cloudflare/shell`'s `Workspace`. No subprocess, no native binaries
 * — pure JS bundled into the Worker.
 *
 * Why this exists: until now Dodo had no feedback loop on user code beyond
 * "the agent thinks it looks right". The system prompt and MCP comments
 * explicitly told users the sandbox couldn't run typecheck. This closes
 * the gap for TypeScript projects without introducing any container or
 * VM-specific assumption (per `AGENTS.md`'s "no container assumptions" rule).
 *
 * Bundle cost is non-trivial (~1.5 MB gzip for `typescript` itself plus
 * ~600 KB gzip for the bundled lib `.d.ts` files). Both are loaded lazily
 * via dynamic imports inside `runTypecheck` so cold starts pay nothing
 * unless the user actually runs typecheck.
 *
 * Heap risk: full TypeScript checking is memory-hungry. A Durable Object
 * has 128 MB of heap; small projects (≤ 50 files, ≤ 5 MB) fit comfortably,
 * but very large clones can OOM. We refuse oversized projects up front
 * with a clear error so the model gets actionable feedback instead of an
 * opaque DO crash.
 */

import type { Workspace } from "@cloudflare/shell";

/** Hard caps before we refuse to typecheck. Tunable after we measure prod heap. */
const MAX_FILES = 50;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

export interface TypecheckDiagnostic {
  /** Workspace-relative path. Null when the diagnostic isn't tied to a file (e.g. config). */
  file: string | null;
  /** 1-indexed line. Null when not file-bound. */
  line: number | null;
  /** 1-indexed column. Null when not file-bound. */
  column: number | null;
  /** "error" | "warning" | "suggestion" | "message". */
  category: "error" | "warning" | "suggestion" | "message";
  /** TS diagnostic code, e.g. 2322. */
  code: number;
  /** Flat message text, joined when the original was a chain. */
  message: string;
}

export interface TypecheckResult {
  ok: boolean;
  diagnostics: TypecheckDiagnostic[];
  /** Number of files actually checked. */
  fileCount: number;
  /** Total bytes of TS source that fed the program. */
  byteCount: number;
  /** Filled when the project was rejected up front. */
  skipped?: {
    reason: "too-large";
    fileCount: number;
    byteCount: number;
    limit: { files: number; bytes: number };
  };
  /** Compiler options actually used (after merging tsconfig + defaults). */
  effectiveOptions: {
    target?: string;
    module?: string;
    moduleResolution?: string;
    strict?: boolean;
    libs?: string[];
  };
  /** Wall-clock duration of the typecheck call, ms. */
  durationMs: number;
}

export interface TypecheckOptions {
  /** Subdirectory to root the typecheck in. Defaults to "/" (the workspace root). */
  dir?: string;
}

/**
 * Run a typecheck against the workspace.
 *
 * Implementation notes:
 *   - We discover `.ts` / `.tsx` files via `workspace.glob("**\/*.{ts,tsx}")`
 *     starting from `opts.dir`. Files under `node_modules/`, `dist/`, and
 *     hidden directories are skipped — they're either dependencies (we
 *     can't typecheck without `@types/*` we don't have) or build output.
 *   - `tsconfig.json` is read from the workspace if present. We pass it
 *     through `ts.parseJsonText` + `parseJsonConfigFileContent`, so the
 *     user's `compilerOptions` (target, lib, jsx, paths, etc.) are honoured.
 *   - The `ts.sys` host returns lib content from the bundled
 *     `TYPECHECK_LIB_FILES` map. User project files come from
 *     `workspace.readFile()`. Anything else returns undefined, which the
 *     TS compiler turns into a "cannot find module" diagnostic — the
 *     model sees those as actionable.
 */
export async function runTypecheck(
  workspace: Workspace,
  opts: TypecheckOptions = {},
): Promise<TypecheckResult> {
  const start = Date.now();
  const rootDir = normaliseDir(opts.dir);

  // 1. Enumerate candidate files. `glob` returns absolute paths; we work
  //    in workspace-relative paths throughout.
  const candidates = await listTsFiles(workspace, rootDir);
  const { fileCount, byteCount, fileMap } = await loadFiles(workspace, candidates);

  if (fileCount > MAX_FILES || byteCount > MAX_BYTES) {
    return {
      ok: false,
      diagnostics: [],
      fileCount,
      byteCount,
      skipped: {
        reason: "too-large",
        fileCount,
        byteCount,
        limit: { files: MAX_FILES, bytes: MAX_BYTES },
      },
      effectiveOptions: {},
      durationMs: Date.now() - start,
    };
  }

  // No TS files? Nothing to check — return clean. The model will read
  // `fileCount: 0` and know to look elsewhere.
  if (fileCount === 0) {
    return {
      ok: true,
      diagnostics: [],
      fileCount: 0,
      byteCount: 0,
      effectiveOptions: {},
      durationMs: Date.now() - start,
    };
  }

  // Lazy-load the heavy bits. ~1.5 MB gzip for TS, ~600 KB for libs.
  // Until this point the typecheck bundle has cost zero memory.
  //
  // TS's published bundle has a top-level `sys = (() => { ... })()` IIFE
  // that calls `getNodeSystem()` when `isNodeLikeSystem()` returns true.
  // The Node-system path references `__filename` and `__dirname`, which
  // are undefined in the Workers ESM scope even with `nodejs_compat`.
  // Setting `process.browser = true` (the canonical sentinel for "not
  // Node") skips the Node path: `sys` becomes `undefined`. We never
  // touch `ts.sys` ourselves — our `createWorkspaceHost` is the host —
  // so this is a safe no-op for our use case. Done before the import
  // so the IIFE sees the patched flag the first time the module loads.
  prepareTsRuntime();
  const ts = (await import("typescript")).default;
  // Load the bundled lib map. The generated file is a sibling that
  // contains a 3 MB string map; we keep it gitignored so the repo stays
  // light, and regenerate it via `npm run build` (Wrangler also runs
  // the build step before deploy). Dynamic import lets cold starts that
  // never typecheck pay zero memory.
  const { TYPECHECK_LIB_FILES } = await loadLibFiles();

  // 2. Parse tsconfig.json if present, otherwise use sensible defaults.
  const tsconfigPath = joinPath(rootDir, "tsconfig.json");
  const tsconfigSource = await safeRead(workspace, tsconfigPath);
  const compilerOptions = resolveCompilerOptions(ts, tsconfigSource, rootDir);

  // 3. Build a CompilerHost wired to the workspace + bundled libs.
  const host = createWorkspaceHost(ts, fileMap, TYPECHECK_LIB_FILES, compilerOptions);

  // 4. Run the program. `getDeclarationDiagnostics` is excluded — emit is
  //    off, so it would never produce useful output.
  const program = ts.createProgram({
    rootNames: Array.from(fileMap.keys()),
    options: compilerOptions,
    host,
  });
  const raw = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getOptionsDiagnostics(),
  ];

  const diagnostics = raw.map((d) => formatDiagnostic(ts, d));
  const errorCount = diagnostics.filter((d) => d.category === "error").length;

  return {
    ok: errorCount === 0,
    diagnostics,
    fileCount,
    byteCount,
    effectiveOptions: summariseOptions(ts, compilerOptions),
    durationMs: Date.now() - start,
  };
}

// ─── Internals ───

/**
 * Disarm the TypeScript bundle's Node-detection so its top-level IIFE
 * doesn't try to read `__filename` / `__dirname` — both undefined in
 * the Workers ESM scope.
 *
 * `isNodeLikeSystem()` inside `typescript.js` returns true when:
 *   `process` exists AND `process.nextTick` is set AND
 *   `process.browser` is falsy AND `require` is defined.
 * Workers + `nodejs_compat` satisfies all four, so `getNodeSystem()`
 * runs and crashes on the first `__filename` reference. Setting
 * `process.browser = true` short-circuits that branch — `ts.sys`
 * ends up undefined, and our `createWorkspaceHost` is the host
 * the program actually uses.
 *
 * Idempotent: a second call just re-asserts the flag. Safe to invoke
 * before every typecheck call (the import is cached after the first).
 */
function prepareTsRuntime(): void {
  // Guard against environments without `process` (defensive — Workers
  // with `nodejs_compat` does provide one). The cast keeps TypeScript
  // happy when @types/node hasn't surfaced `browser` on Process.
  const proc = (globalThis as { process?: { browser?: boolean } }).process;
  if (proc && proc.browser !== true) {
    proc.browser = true;
  }
}

/**
 * Resolve the generated lib map. The sibling file is checked in (it's
 * ~3 MB but only changes when TypeScript itself bumps version, so the
 * churn is rare) and regenerated by `npm run build` so it stays in
 * sync with whichever `typescript` package is installed.
 *
 * Wrapping the import in a function makes the dynamic-import call site
 * extension-explicit (so Node-native runs of the smoke script resolve
 * the `.ts` sibling) while letting the rest of `typecheck.ts` stay
 * statically typed.
 */
async function loadLibFiles(): Promise<{ TYPECHECK_LIB_FILES: Record<string, string> }> {
  return await import(/* @vite-ignore */ "./typecheck-libs.generated.ts");
}


function normaliseDir(dir?: string): string {
  if (!dir || dir === "/" || dir === "") return "/";
  // Strip trailing slash, ensure leading slash.
  const trimmed = dir.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function joinPath(dir: string, leaf: string): string {
  if (dir === "/" || dir === "") return `/${leaf.replace(/^\//, "")}`;
  return `${dir.replace(/\/+$/, "")}/${leaf.replace(/^\//, "")}`;
}

const SKIP_DIR_RE = /(^|\/)(node_modules|dist|build|\.git|\.wrangler|coverage)(\/|$)/;

async function listTsFiles(workspace: Workspace, rootDir: string): Promise<string[]> {
  const out: string[] = [];
  // Prefer `glob` if it covers our pattern; fall back to a manual walk if
  // the implementation only supports literal patterns.
  try {
    const pattern = rootDir === "/" ? "**/*.{ts,tsx}" : `${rootDir.replace(/^\//, "")}/**/*.{ts,tsx}`;
    const entries = await workspace.glob(pattern);
    for (const e of entries) {
      const path = typeof e === "string" ? e : (e as { path?: string }).path;
      if (typeof path !== "string") continue;
      if (SKIP_DIR_RE.test(path)) continue;
      // `.d.ts` files in user code are fine; lib `.d.ts` files come from the
      // bundled map and are never on the workspace's filesystem, so we don't
      // need to filter them out here.
      out.push(path);
    }
    return out;
  } catch {
    // Manual walk as a fallback — `glob` may not be implemented in every
    // Workspace adapter.
    await walk(workspace, rootDir, out);
    return out;
  }
}

async function walk(workspace: Workspace, dir: string, out: string[]): Promise<void> {
  let entries: Array<{ name: string; type?: string; path?: string }> = [];
  try {
    entries = (await workspace.readDir(dir)) as typeof entries;
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e?.name) continue;
    const full = joinPath(dir, e.name);
    if (SKIP_DIR_RE.test(full)) continue;
    if (e.type === "directory") {
      await walk(workspace, full, out);
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      out.push(full);
    }
  }
}

async function loadFiles(
  workspace: Workspace,
  paths: string[],
): Promise<{ fileCount: number; byteCount: number; fileMap: Map<string, string> }> {
  const fileMap = new Map<string, string>();
  let byteCount = 0;
  for (const path of paths) {
    const content = await safeRead(workspace, path);
    if (content === null) continue;
    fileMap.set(path, content);
    byteCount += content.length;
  }
  return { fileCount: fileMap.size, byteCount, fileMap };
}

async function safeRead(workspace: Workspace, path: string): Promise<string | null> {
  try {
    const content = await workspace.readFile(path);
    return typeof content === "string" ? content : null;
  } catch {
    return null;
  }
}

/**
 * Merge tsconfig.json compilerOptions (if any) with our defaults. Defaults
 * track the Dodo project itself: ES2022 target, bundler resolution, strict.
 * Setting `noEmit` is mandatory — emit on a Worker isolate is pointless.
 */
function resolveCompilerOptions(
  ts: typeof import("typescript"),
  tsconfigSource: string | null,
  rootDir: string,
): import("typescript").CompilerOptions {
  const defaults: import("typescript").CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    isolatedModules: true,
    allowSyntheticDefaultImports: true,
    forceConsistentCasingInFileNames: true,
    noEmit: true,
    // No `lib` here — TypeScript picks one from `target`. The user's
    // tsconfig overrides this if they care.
  };

  if (!tsconfigSource) return defaults;

  // ts.parseConfigFileTextToJson handles JSON-with-comments (jsonc), which
  // most tsconfigs use.
  const parsed = ts.parseConfigFileTextToJson(joinPath(rootDir, "tsconfig.json"), tsconfigSource);
  if (parsed.error || !parsed.config) return defaults;

  const userHost: import("typescript").ParseConfigHost = {
    fileExists: () => false, // we only care about compilerOptions, not file lists
    readDirectory: () => [],
    readFile: () => undefined,
    useCaseSensitiveFileNames: true,
  };
  const result = ts.parseJsonConfigFileContent(parsed.config, userHost, rootDir, defaults, "tsconfig.json");

  // `noEmit: true` is non-negotiable in this environment.
  return { ...result.options, noEmit: true };
}

/**
 * Build a CompilerHost backed by the in-memory file map plus the bundled
 * default lib map. Resolution semantics:
 *   - `lib.*.d.ts` → bundled libs map
 *   - workspace-relative paths in `fileMap` → return their string
 *   - everything else → undefined (TS reports as "cannot find module")
 */
function createWorkspaceHost(
  ts: typeof import("typescript"),
  fileMap: Map<string, string>,
  libFiles: Record<string, string>,
  options: import("typescript").CompilerOptions,
): import("typescript").CompilerHost {
  const sourceFileCache = new Map<string, import("typescript").SourceFile>();

  const tryRead = (fileName: string): string | undefined => {
    // 1. Default lib files. TS resolves these as bare names (e.g. "lib.es2022.d.ts").
    const libKey = fileName.split("/").pop() ?? fileName;
    if (libFiles[libKey]) return libFiles[libKey];

    // 2. User files. Workspace paths are absolute (start with "/").
    if (fileMap.has(fileName)) return fileMap.get(fileName);

    // Some TS internals query without the leading slash — try both.
    if (!fileName.startsWith("/") && fileMap.has(`/${fileName}`)) {
      return fileMap.get(`/${fileName}`);
    }
    return undefined;
  };

  return {
    fileExists: (fileName) => tryRead(fileName) !== undefined,
    readFile: tryRead,
    getSourceFile: (fileName, languageVersion) => {
      const cached = sourceFileCache.get(fileName);
      if (cached) return cached;
      const text = tryRead(fileName);
      if (text === undefined) return undefined;
      const sf = ts.createSourceFile(fileName, text, languageVersion, /*setParentNodes*/ true);
      sourceFileCache.set(fileName, sf);
      return sf;
    },
    getDefaultLibFileName: (compilerOptions) =>
      // Mirrors ts.getDefaultLibFileName but keyed off our libFiles map.
      ts.getDefaultLibFileName(compilerOptions),
    writeFile: () => {
      /* noEmit: true — never called in practice. */
    },
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    // Skipping `getEnvironmentVariable` and friends — TS treats them as optional.
    // `realpath` and `directoryExists` likewise default to undefined.
  };
}

function formatDiagnostic(
  ts: typeof import("typescript"),
  d: import("typescript").Diagnostic,
): TypecheckDiagnostic {
  const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  const category = mapCategory(ts, d.category);
  if (d.file && typeof d.start === "number") {
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    return {
      file: d.file.fileName,
      line: line + 1,
      column: character + 1,
      category,
      code: d.code,
      message,
    };
  }
  return {
    file: null,
    line: null,
    column: null,
    category,
    code: d.code,
    message,
  };
}

function mapCategory(
  ts: typeof import("typescript"),
  category: import("typescript").DiagnosticCategory,
): TypecheckDiagnostic["category"] {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion";
    default:
      return "message";
  }
}

function summariseOptions(
  ts: typeof import("typescript"),
  options: import("typescript").CompilerOptions,
): TypecheckResult["effectiveOptions"] {
  return {
    target: options.target !== undefined ? ts.ScriptTarget[options.target] : undefined,
    module: options.module !== undefined ? ts.ModuleKind[options.module] : undefined,
    moduleResolution:
      options.moduleResolution !== undefined ? ts.ModuleResolutionKind[options.moduleResolution] : undefined,
    strict: options.strict,
    libs: options.lib,
  };
}
