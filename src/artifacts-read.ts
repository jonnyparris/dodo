/**
 * Artifacts read path — fast file-tree and file-content reads served from
 * an in-DO clone of the per-session Artifacts repo.
 *
 * Why: `Workspace.readDir` round-trips into the workspace shell binding
 * for every directory expand. After a turn flushes to Artifacts, we
 * already have the canonical state in git form. Cloning it once into an
 * `InMemoryFs` lets file-tree expansions complete in microseconds — pure
 * RAM lookups against the cloned working copy and `git.walk` against the
 * tree at HEAD.
 *
 * Lifecycle:
 *   1. First call after artifacts repo creation → shallow clone into a
 *      cached `InMemoryFs` on the agent.
 *   2. After every successful `flushTurnToArtifacts`, the agent flips a
 *      dirty flag.
 *   3. Next read sees the flag, runs `git.fetch + checkout` on the
 *      cached fs, clears the flag.
 *   4. Reads (`listArtifactsTree`, `readArtifactsFile`) work against the
 *      live fs; isomorphic-git is only invoked on refresh.
 *
 * Failures bubble back to the caller as `null` so the existing workspace
 * fallback path can take over. Never throws into request handling.
 *
 * Inspired by apeacock1991/artifacts-demo's read-side primitives, but
 * uses @cloudflare/shell's InMemoryFs (which we already have) instead of
 * pulling in `memfs`.
 */

import { InMemoryFs } from "@cloudflare/shell";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { log } from "./logger";

const ARTIFACTS_DIR = "/repo";
const ARTIFACTS_DEFAULT_DEPTH = 50;

/**
 * Cached state that lives on the CodingAgent instance for the lifetime
 * of the DO. Shape is intentionally flat so the agent can hold these
 * fields directly alongside `_artifactsRepo`.
 */
export interface ArtifactsFsCache {
  fs: InMemoryFs;
  dir: string;
  /** OID of the commit currently checked out in `fs`. Used to detect no-op refreshes. */
  headOid: string | null;
  /** Set true after a successful flush; next read triggers a fetch+checkout. */
  dirty: boolean;
}

interface RefreshInput {
  cache: ArtifactsFsCache | null;
  remote: string;
  tokenSecret: string;
}

/**
 * Strip token expiry suffix the same way artifacts-flush.ts does. Tokens
 * minted by `repo.createToken` have a `?expires=…` query string that
 * isomorphic-git's onAuth helper doesn't strip — leaving it on the URL
 * makes the basic-auth header invalid.
 */
function tokenSecret(token: string): string {
  return token.split("?")[0];
}

function makeOnAuth(token: string) {
  return () => ({ username: "x", password: tokenSecret(token) });
}

/**
 * Clone the artifacts remote into a fresh InMemoryFs. Only called when
 * the cache is empty.
 */
async function cloneIntoMemfs(remote: string, token: string): Promise<ArtifactsFsCache | null> {
  try {
    const fs = new InMemoryFs();
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

    await git.clone({
      // InMemoryFs is FileSystem-shaped; isomorphic-git wants a
      // Node-style fs.promises with isFile/isDirectory stat methods.
      // See `createIsomorphicGitFs` below for the adapter.
      fs: createIsomorphicGitFs(fs),
      http,
      dir: ARTIFACTS_DIR,
      url: remote,
      ref: "main",
      singleBranch: true,
      depth: ARTIFACTS_DEFAULT_DEPTH,
      onAuth: makeOnAuth(token),
    });

    const headOid = await resolveHead(fs);
    return { fs, dir: ARTIFACTS_DIR, headOid, dirty: false };
  } catch (err) {
    log("warn", "[artifacts-read] clone failed", { err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Fetch from origin and hard-reset main to the new tip. Cheaper than a
 * fresh clone because the pack delta only includes commits since last
 * pull. If anything goes wrong, return null and let the caller fall back
 * to the workspace shell.
 */
async function fetchAndCheckout(cache: ArtifactsFsCache, remote: string, token: string): Promise<ArtifactsFsCache | null> {
  try {
    const fsAdapter = createIsomorphicGitFs(cache.fs);
    await git.fetch({
      fs: fsAdapter,
      http,
      dir: cache.dir,
      url: remote,
      ref: "main",
      singleBranch: true,
      depth: ARTIFACTS_DEFAULT_DEPTH,
      onAuth: makeOnAuth(token),
    });
    // Move main to FETCH_HEAD's resolved OID. We avoid `git.pull` because
    // it implies a merge commit; the artifacts remote is the source of
    // truth and we never make local commits in this fs.
    const newOid = await git.resolveRef({ fs: fsAdapter, dir: cache.dir, ref: "refs/remotes/origin/main" });
    await git.writeRef({ fs: fsAdapter, dir: cache.dir, ref: "refs/heads/main", value: newOid, force: true });
    await git.checkout({ fs: fsAdapter, dir: cache.dir, ref: "main", force: true });
    return { ...cache, headOid: newOid, dirty: false };
  } catch (err) {
    log("warn", "[artifacts-read] fetch failed", { err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

async function resolveHead(fs: InMemoryFs): Promise<string | null> {
  try {
    return await git.resolveRef({ fs: createIsomorphicGitFs(fs), dir: ARTIFACTS_DIR, ref: "HEAD" });
  } catch {
    return null;
  }
}

/**
 * Get the current cache, refreshing if dirty. Returns null if artifacts
 * is unreachable or the clone fails — callers must tolerate that and
 * fall back to the workspace shell.
 */
export async function refreshArtifactsFs(input: RefreshInput): Promise<ArtifactsFsCache | null> {
  if (!input.cache) {
    return cloneIntoMemfs(input.remote, input.tokenSecret);
  }
  if (input.cache.dirty) {
    const refreshed = await fetchAndCheckout(input.cache, input.remote, input.tokenSecret);
    return refreshed ?? input.cache; // stale-but-usable beats nothing
  }
  return input.cache;
}

// ── Tree + blob reads ─────────────────────────────────────────────────

/** Shape matches WorkspaceEntry so the existing /files response is unchanged. */
export interface ArtifactsTreeEntry {
  createdAt: string;
  mimeType: string;
  name: string;
  path: string;
  size: number;
  type: "file" | "directory" | "symlink";
  updatedAt: string;
}

function normalizePath(path: string): string {
  if (!path || path === "/") return "/";
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  return trimmed.endsWith("/") && trimmed !== "/" ? trimmed.slice(0, -1) : trimmed;
}

function joinPath(parent: string, name: string): string {
  if (parent === "/") return `/${name}`;
  return `${parent}/${name}`;
}

/**
 * Best-effort mime type guess from extension. The workspace shell tracks
 * mime in a SQL column; we don't have that, so we approximate. Anything
 * we don't recognise comes back as application/octet-stream.
 */
function mimeFor(name: string): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  switch (ext) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "text/javascript";
    case "json":
      return "application/json";
    case "html":
      return "text/html";
    case "css":
      return "text/css";
    case "md":
      return "text/markdown";
    case "txt":
      return "text/plain";
    case "yaml":
    case "yml":
      return "application/yaml";
    case "toml":
      return "application/toml";
    case "py":
      return "text/x-python";
    case "rs":
      return "text/x-rust";
    case "go":
      return "text/x-go";
    case "sh":
      return "application/x-sh";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

/**
 * List the immediate children of `path` from the working copy of the
 * cloned repo. The repo is checked out, so we use the InMemoryFs's
 * readdir for a flat listing; for sizes we stat each entry. This is all
 * RAM, so the round-trip cost is negligible.
 *
 * `.git/` is hidden from the response — it's an implementation detail of
 * the cache, not workspace content.
 */
export async function listArtifactsTree(cache: ArtifactsFsCache, requestedPath: string): Promise<{ entries: ArtifactsTreeEntry[] } | null> {
  const path = normalizePath(requestedPath);
  const fsPath = path === "/" ? cache.dir : `${cache.dir}${path}`;
  try {
    const dirents = await cache.fs.readdirWithFileTypes(fsPath);
    const entries: ArtifactsTreeEntry[] = [];
    for (const entry of dirents) {
      if (path === "/" && entry.name === ".git") continue; // hide repo metadata
      const entryPath = joinPath(path, entry.name);
      const fullPath = `${cache.dir}${entryPath}`;
      let size = 0;
      let mtime = new Date(0);
      try {
        const stat = await cache.fs.lstat(fullPath);
        size = stat.size;
        mtime = stat.mtime;
      } catch {
        // Entry races against a concurrent fs op — skip rather than 500.
        continue;
      }
      entries.push({
        createdAt: mtime.toISOString(),
        mimeType: entry.type === "directory" ? "inode/directory" : mimeFor(entry.name),
        name: entry.name,
        path: entryPath,
        size,
        type: entry.type,
        updatedAt: mtime.toISOString(),
      });
    }
    // Sort dirs first, then alpha — matches the workspace shell ordering.
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { entries };
  } catch (err) {
    log("warn", "[artifacts-read] listTree failed", { path, err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function readArtifactsFile(cache: ArtifactsFsCache, requestedPath: string): Promise<{ content: string; path: string } | null> {
  const path = normalizePath(requestedPath);
  if (path === "/") return null;
  const fsPath = `${cache.dir}${path}`;
  try {
    const content = await cache.fs.readFile(fsPath);
    return { content, path };
  } catch (err) {
    // ENOENT: file doesn't exist in the artifacts working copy. Caller
    // will fall back to the workspace, which may have the file if it was
    // written but not yet flushed.
    // Don't log; misses are routine (file written but not yet flushed).
    return null;
  }
}

// ── Clone URL ─────────────────────────────────────────────────────────

/**
 * Build an authenticated `git clone` URL the customer can paste into a
 * terminal. Token is short-lived (set by the caller via the artifacts
 * binding's createToken TTL) so leakage exposure is bounded.
 */
export function buildArtifactsCloneUrl(remote: string, tokenSecret: string): string {
  const url = new URL(remote);
  url.username = "x";
  url.password = tokenSecret.split("?")[0];
  return url.toString();
}

// ── isomorphic-git fs adapter ─────────────────────────────────────────

/**
 * Adapter that wraps an InMemoryFs in the Node-style `fs.promises`
 * interface that isomorphic-git expects (with isFile/isDirectory stat
 * methods, and readFile dispatching on the encoding option).
 *
 * The shell ships an identical adapter at @cloudflare/shell/git, but
 * doesn't export it directly. We mirror it here rather than depend on a
 * private export. Keep in sync with shell's `createGitFs`.
 */
class GitStat {
  type: "file" | "directory" | "symlink";
  size: number;
  mtime: Date;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
  ino = 0;
  uid = 0;
  gid = 0;
  dev = 0;

  constructor(stat: { type: string; size: number; mtime: Date; mode?: number }) {
    this.type = stat.type as "file" | "directory" | "symlink";
    this.size = stat.size;
    this.mtime = stat.mtime;
    this.mtimeMs = stat.mtime.getTime();
    this.ctimeMs = this.mtimeMs;
    // Default modes: dir=0o40755, file=0o100644, symlink=0o120000
    this.mode =
      stat.mode ?? (this.type === "directory" ? 0o40755 : this.type === "symlink" ? 0o120000 : 0o100644);
  }
  isFile() { return this.type === "file"; }
  isDirectory() { return this.type === "directory"; }
  isSymbolicLink() { return this.type === "symlink"; }
}

function fsError(path: string, cause?: unknown): Error & { code: string } {
  if (cause instanceof Error && "code" in cause && typeof (cause as { code: unknown }).code === "string") {
    return cause as Error & { code: string };
  }
  const err = new Error(cause instanceof Error ? cause.message : `ENOENT: ${path}`) as Error & { code: string };
  err.code = "ENOENT";
  return err;
}

function createIsomorphicGitFs(fs: InMemoryFs) {
  return {
    promises: {
      async readFile(path: string, options?: { encoding?: string } | string): Promise<Uint8Array | string> {
        const encoding = typeof options === "string" ? options : options?.encoding;
        try {
          if (encoding === "utf8" || encoding === "utf-8") return await fs.readFile(path);
          return await fs.readFileBytes(path);
        } catch (err) {
          throw fsError(path, err);
        }
      },
      async writeFile(path: string, data: string | Uint8Array): Promise<void> {
        const parent = path.replace(/\/[^/]+$/, "");
        if (parent && parent !== "/" && parent !== path) {
          try { await fs.mkdir(parent, { recursive: true }); } catch { /* exists */ }
        }
        if (typeof data === "string") await fs.writeFile(path, data);
        else await fs.writeFileBytes(path, data);
      },
      async unlink(path: string): Promise<void> { await fs.rm(path); },
      async readdir(path: string): Promise<string[]> { return fs.readdir(path); },
      async mkdir(path: string, mode?: number | { recursive?: boolean }): Promise<void> {
        const recursive = typeof mode === "object" ? mode.recursive : false;
        await fs.mkdir(path, { recursive });
      },
      async rmdir(path: string): Promise<void> { await fs.rm(path); },
      async stat(path: string): Promise<GitStat> {
        try { return new GitStat(await fs.stat(path)); }
        catch (err) { throw fsError(path, err); }
      },
      async lstat(path: string): Promise<GitStat> {
        try { return new GitStat(await fs.lstat(path)); }
        catch (err) { throw fsError(path, err); }
      },
      async readlink(path: string): Promise<string> {
        try { return await fs.readlink(path); }
        catch (err) { throw fsError(path, err); }
      },
      async symlink(target: string, path: string): Promise<void> { await fs.symlink(target, path); },
      async chmod(_path: string, _mode: number): Promise<void> { /* no-op */ },
    },
  };
}
