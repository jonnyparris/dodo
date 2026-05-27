// Mount a `@cloudflare/shell` FileSystem (typically the SQLite+R2-backed
// `WorkspaceFileSystem`) into busyworker's VFS as a dynamic-dir subtree.
//
// Modelled directly on `r2fs.ts` from the upstream busyworker source. The
// shapes are identical because the FileSystem interface and R2's
// `list`/`get`/`put`/`delete` map onto the same lazy-load-on-first-access,
// flush-on-close model. The main differences:
//
//   - Directory listings come from `fs.readdirWithFileTypes()` instead of
//     R2's `list({ delimiter: "/" })`, so there's no synthetic-dir vs
//     real-key distinction — the FileSystem already exposes a tree.
//   - File body reads use `fs.readFileBytes(path)` (one round-trip per
//     file, same as r2fs's `bucket.get`). No range reads.
//   - File writes flush via `fs.writeFileBytes(path, body)` on close. The
//     write-coalesce + dirty-bit dance is preserved so a `touch` lands a
//     zero-byte file and `cat foo | head` doesn't write back unchanged
//     bodies.
//
// The adapter is async-mutation-capable when `opts.writable` is true.
// Read-only mounts return EROFS for unlink/rmdir/mkdir/rename/create, which
// busybox surfaces as "Read-only file system".

import { Vfs } from "../busyworker/vfs.js";
import { ENOENT, EISDIR, ENOTDIR, ENOTEMPTY, EEXIST, EIO, EXDEV } from "../busyworker/errno.js";
import { O_APPEND, O_ACCMODE, O_RDONLY } from "../busyworker/fd.js";
import type { FsNode } from "../busyworker/types.js";

/**
 * Minimal slice of `@cloudflare/shell`'s `FileSystem` interface. Kept
 * structural so we don't have to import the package type just to type the
 * mount call site — Dodo's tests can pass a `WorkspaceFileSystem`, the
 * `InMemoryFs`, or any other compliant implementation.
 */
export interface WorkspaceFsLike {
  readFileBytes(path: string): Promise<Uint8Array>;
  writeFileBytes(path: string, content: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ type: "file" | "directory" | "symlink"; size: number; mtime: Date; mode?: number }>;
  readdirWithFileTypes(path: string): Promise<Array<{ name: string; type: "file" | "directory" | "symlink" }>>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  mv(src: string, dest: string): Promise<void>;
}

export interface WorkspaceFsMountOpts {
  /**
   * Optional sub-path of the underlying FileSystem to expose as the mount
   * root. Defaults to "/". A leading "/" is optional; trailing "/" is
   * preserved.
   */
  prefix?: string;
  /** Diagnostic logger. */
  log?: (s: string) => void;
  /**
   * Allow mutations (unlink/rmdir/mkdir/rename/create + writes). Default:
   * `false` (read-only). The flag wires the `*Async` hooks; without it the
   * kernel returns EROFS on mutation syscalls against the mount.
   */
  writable?: boolean;
}

type DirEntry =
  | { kind: "dir"; node?: FsNode }
  | { kind: "file"; size: number; mtime: number; node?: FsNode };

interface DirCache {
  /** child name → entry. Populated on first `ensureLoaded()`. */
  entries: Map<string, DirEntry>;
  loadedPromise: Promise<void> | null;
  loaded: boolean;
}

let inoCounter = 400000;
const nextIno = (): number => inoCounter++;

export function mountWorkspaceFs(
  vfs: Vfs,
  mountPath: string,
  fs: WorkspaceFsLike,
  opts: WorkspaceFsMountOpts = {},
): { refresh: (subdir?: string) => void } {
  const log = opts.log ?? (() => {});
  const writable = opts.writable ?? false;
  // Normalize prefix: stored with a leading "/" and a trailing "/" so we
  // can concat sub-prefixes by appending child names.
  let basePrefix = opts.prefix ?? "/";
  if (!basePrefix.startsWith("/")) basePrefix = "/" + basePrefix;
  if (!basePrefix.endsWith("/")) basePrefix += "/";

  // Cache of directory contents, keyed by the **sub-path inside the mount**
  // (with trailing "/", "" for the mount root). The absolute FileSystem
  // path is `basePrefix + subPath` minus a trailing slash.
  const dirCaches = new Map<string, DirCache>();

  // Track every dynamic-dir node we've handed out so renameAsync can
  // resolve `newParentNode` back to its sub-path.
  const parentDirNodes = new Map<string, FsNode>();

  function getCache(subPath: string): DirCache {
    let c = dirCaches.get(subPath);
    if (!c) {
      c = { entries: new Map(), loadedPromise: null, loaded: false };
      dirCaches.set(subPath, c);
    }
    return c;
  }

  function fsPath(subPath: string, name: string = ""): string {
    // basePrefix has a trailing "/". subPath has a trailing "/" or is "".
    // Strip the final trailing "/" unless we're at the mount root with no
    // name (then return basePrefix sans trailing "/", or "/" for "/").
    const joined = basePrefix + subPath + name;
    if (joined === "/") return "/";
    return joined.endsWith("/") ? joined.slice(0, -1) : joined;
  }

  async function loadDir(subPath: string, cache: DirCache): Promise<void> {
    cache.entries.clear();
    const absolute = fsPath(subPath);
    let dirents: Array<{ name: string; type: "file" | "directory" | "symlink" }>;
    try {
      dirents = await fs.readdirWithFileTypes(absolute);
    } catch (e: unknown) {
      // ENOENT on the directory itself: leave cache empty + loaded so a
      // subsequent lookup() returns null. Other errors logged.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/ENOENT/i.test(msg)) {
        log(`workspace-fs: readdir(${absolute}) failed: ${msg}`);
      }
      cache.loaded = true;
      return;
    }

    // For files, we need a stat for size + mtime up front so stat()/ls -l
    // works without a body fetch. Files are usually small inside a session
    // workspace; if this proves slow on large dirs, switch to lazy stat in
    // lookup().
    for (const dirent of dirents) {
      if (dirent.type === "directory") {
        cache.entries.set(dirent.name, { kind: "dir" });
      } else if (dirent.type === "file") {
        // Stat for size + mtime. Errors here are non-fatal; treat as 0 size.
        let size = 0;
        let mtime = 0;
        try {
          const st = await fs.stat(fsPath(subPath, dirent.name));
          size = st.size;
          mtime = Math.floor(st.mtime.getTime() / 1000);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          log(`workspace-fs: stat(${dirent.name}) failed: ${msg}`);
        }
        cache.entries.set(dirent.name, { kind: "file", size, mtime });
      }
      // Symlinks: surfaced as their target type by `readdirWithFileTypes`
      // through WorkspaceFileSystem; if the impl actually exposes raw
      // symlinks we don't support them and skip — busybox sees a missing
      // entry. (Workspace doesn't have first-class symlink support today.)
    }
    cache.loaded = true;
  }

  function ensureLoaded(subPath: string): Promise<void> {
    const c = getCache(subPath);
    if (c.loaded) return Promise.resolve();
    if (!c.loadedPromise) {
      c.loadedPromise = loadDir(subPath, c).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        log(`workspace-fs: ensureLoaded(${subPath}) failed: ${msg}`);
        c.loaded = true;
      });
    }
    return c.loadedPromise;
  }

  // FsNode for a workspace-backed regular file. Materialise the body on
  // first read; buffer writes and flush on close.
  function makeFileNode(
    subPath: string,
    name: string,
    fileEntry: { size: number; mtime: number },
    initialData?: Uint8Array,
    fileOpts: { freshlyCreated?: boolean } = {},
  ): FsNode {
    const node: FsNode = {
      type: "reg",
      mode: writable ? 0o100644 : 0o100444,
      uid: 0,
      gid: 0,
      mtime: fileEntry.mtime,
      ino: nextIno(),
      size: fileEntry.size,
    };
    if (initialData) {
      node.data = initialData;
      node.size = initialData.length;
    }

    let fetching: Promise<void> | null = null;
    let dirty = !!fileOpts.freshlyCreated;
    let openWriters = 0;
    let flushPending: Promise<void> | null = null;

    const absPath = fsPath(subPath, name);

    const materialize = async (skipFetch = false): Promise<void> => {
      if (node.data) return;
      if (skipFetch) {
        node.data = new Uint8Array(0);
        node.size = 0;
        return;
      }
      if (!fetching) {
        fetching = (async () => {
          try {
            node.data = await fs.readFileBytes(absPath);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            log(`workspace-fs: readFileBytes(${absPath}) failed: ${msg}`);
            node.data = new Uint8Array(0);
          }
          node.size = node.data.length;
        })();
      }
      await fetching;
    };

    const flush = async (): Promise<void> => {
      if (!dirty) return;
      if (flushPending) {
        await flushPending;
        return;
      }
      const body = node.data!.slice();
      flushPending = (async () => {
        try {
          await fs.writeFileBytes(absPath, body);
          fileEntry.size = body.length;
          fileEntry.mtime = Math.floor(Date.now() / 1000);
          node.size = body.length;
          node.mtime = fileEntry.mtime;
          dirty = false;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          log(`workspace-fs: writeFileBytes(${absPath}) failed: ${msg}`);
          throw e;
        }
      })();
      try {
        await flushPending;
      } finally {
        flushPending = null;
      }
    };

    node.special = {
      readAsync: async (u8mem, buf, count, fd) => {
        await materialize();
        const data = node.data!;
        const off = fd?.offset ?? 0;
        const n = Math.min(count, data.length - off);
        if (n <= 0) return 0;
        u8mem.set(data.subarray(off, off + n), buf);
        if (fd) fd.offset = off + n;
        return n;
      },
      writeAsync: !writable
        ? undefined
        : async (u8mem, buf, count, fd) => {
            // O_TRUNC on open zeroed node.data synchronously; otherwise we
            // need the existing body first (for O_RDWR / O_APPEND).
            await materialize();
            let off = fd?.offset ?? 0;
            if (fd && (fd.flags & O_APPEND)) off = node.data!.length;
            const end = off + count;
            if (end > node.data!.length) {
              const grown = new Uint8Array(end);
              grown.set(node.data!);
              node.data = grown;
            }
            node.data!.set(u8mem.subarray(buf, buf + count), off);
            if (fd) fd.offset = end;
            node.size = node.data!.length;
            dirty = true;
            return count;
          },
      poll: () => (writable ? 5 : 1), // POLLIN | (POLLOUT if writable)
      inherit: (entry) => {
        if (entry && (entry.flags & O_ACCMODE) !== O_RDONLY) openWriters++;
      },
      close: (entry) => {
        if (!entry || (entry.flags & O_ACCMODE) === O_RDONLY) return;
        openWriters--;
      },
      closeAsync: !writable
        ? undefined
        : async (entry) => {
            if (!entry || (entry.flags & O_ACCMODE) === O_RDONLY) return;
            if (openWriters <= 0 && dirty) await flush();
          },
    };
    return node;
  }

  function makeDirNode(subPath: string): FsNode {
    const mode = writable ? 0o755 : 0o555;
    const dirNode = Vfs.makeDynamicDir(mode, {
      preload: () => ensureLoaded(subPath),
      list: () => {
        const c = getCache(subPath);
        if (!c.loaded) {
          void ensureLoaded(subPath);
          return [];
        }
        return Array.from(c.entries.keys());
      },
      lookup: (name: string): FsNode | null => {
        const c = getCache(subPath);
        if (!c.loaded) {
          void ensureLoaded(subPath);
          return null;
        }
        const ent = c.entries.get(name);
        if (!ent) return null;
        if (ent.node) return ent.node;
        const node =
          ent.kind === "dir"
            ? makeDirNode(subPath + name + "/")
            : makeFileNode(subPath, name, ent);
        ent.node = node;
        return node;
      },
      unlinkAsync: !writable
        ? undefined
        : async (name: string): Promise<number> => {
            await ensureLoaded(subPath);
            const c = getCache(subPath);
            const ent = c.entries.get(name);
            if (!ent) return -ENOENT;
            if (ent.kind === "dir") return -EISDIR;
            try {
              await fs.rm(fsPath(subPath, name), { force: true });
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              log(`workspace-fs: rm(${fsPath(subPath, name)}) failed: ${msg}`);
              return -EIO;
            }
            c.entries.delete(name);
            return 0;
          },
      rmdirAsync: !writable
        ? undefined
        : async (name: string): Promise<number> => {
            await ensureLoaded(subPath);
            const c = getCache(subPath);
            const ent = c.entries.get(name);
            if (!ent) return -ENOENT;
            if (ent.kind !== "dir") return -ENOTDIR;
            const childSubPath = subPath + name + "/";
            await ensureLoaded(childSubPath);
            const childCache = getCache(childSubPath);
            if (childCache.entries.size > 0) return -ENOTEMPTY;
            try {
              await fs.rm(fsPath(subPath, name), { recursive: false, force: true });
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              log(`workspace-fs: rmdir(${fsPath(subPath, name)}) failed: ${msg}`);
              return -EIO;
            }
            c.entries.delete(name);
            dirCaches.delete(childSubPath);
            return 0;
          },
      mkdirAsync: !writable
        ? undefined
        : async (name: string, _mode: number): Promise<number> => {
            await ensureLoaded(subPath);
            const c = getCache(subPath);
            if (c.entries.has(name)) return -EEXIST;
            try {
              await fs.mkdir(fsPath(subPath, name), { recursive: false });
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              log(`workspace-fs: mkdir(${fsPath(subPath, name)}) failed: ${msg}`);
              return -EIO;
            }
            c.entries.set(name, { kind: "dir" });
            // Mark child cache as loaded + empty so subsequent walk
            // doesn't try a remote readdir on a fresh dir.
            const childCache = getCache(subPath + name + "/");
            childCache.loaded = true;
            return 0;
          },
      renameAsync: !writable
        ? undefined
        : async (oldName, newParentNode, newName): Promise<number> => {
            await ensureLoaded(subPath);
            const srcCache = getCache(subPath);
            const srcEnt = srcCache.entries.get(oldName);
            if (!srcEnt) return -ENOENT;
            // Resolve newParentNode back to its sub-path by reverse-lookup
            // through the parentDirNodes map. Reject cross-backend renames
            // with EXDEV (userspace falls back to copy + unlink).
            let dstSubPath: string | null = null;
            for (const [p, n] of parentDirNodes) {
              if (n === newParentNode) {
                dstSubPath = p;
                break;
              }
            }
            if (dstSubPath === null) return -EXDEV;
            await ensureLoaded(dstSubPath);
            const dstCache = getCache(dstSubPath);
            if (dstCache.entries.has(newName)) {
              const collision = dstCache.entries.get(newName)!;
              if (collision.kind === "dir") return -EISDIR;
              // Overwriting an existing file: let mv() handle it. The
              // backing FileSystem mv may or may not be atomic — we treat
              // it as best-effort.
            }
            try {
              await fs.mv(fsPath(subPath, oldName), fsPath(dstSubPath, newName));
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              log(
                `workspace-fs: mv(${fsPath(subPath, oldName)} -> ${fsPath(dstSubPath, newName)}) failed: ${msg}`,
              );
              return -EIO;
            }
            // Move the cache entry. Reuse the existing node when possible
            // (file body cache survives the rename) and invalidate the
            // old position.
            dstCache.entries.set(newName, srcEnt);
            srcCache.entries.delete(oldName);
            // If we moved a directory, the child sub-path keys change.
            // Conservative approach: drop the old sub-path's nested
            // caches so subsequent walks re-read from the FileSystem.
            if (srcEnt.kind === "dir") {
              const oldChildPrefix = subPath + oldName + "/";
              for (const key of Array.from(dirCaches.keys())) {
                if (key.startsWith(oldChildPrefix)) {
                  dirCaches.delete(key);
                }
              }
            }
            return 0;
          },
      createAsync: !writable
        ? undefined
        : async (name: string, mode: number): Promise<FsNode | number> => {
            await ensureLoaded(subPath);
            const c = getCache(subPath);
            if (c.entries.has(name)) {
              // Should not normally hit: kernel calls createAsync only on
              // ENOENT + O_CREAT. Treat as a successful "found existing"
              // by returning the cached node so openat retries via the
              // sync path and finds it.
              const ent = c.entries.get(name)!;
              if (ent.kind === "dir") return -EISDIR;
              if (ent.node) return ent.node;
              const node = makeFileNode(subPath, name, ent);
              ent.node = node;
              return node;
            }
            try {
              await fs.writeFileBytes(fsPath(subPath, name), new Uint8Array(0));
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              log(
                `workspace-fs: writeFileBytes(${fsPath(subPath, name)}) failed: ${msg}`,
              );
              return -EIO;
            }
            const fileEnt: DirEntry = {
              kind: "file",
              size: 0,
              mtime: Math.floor(Date.now() / 1000),
            };
            const node = makeFileNode(subPath, name, fileEnt as { size: number; mtime: number }, new Uint8Array(0), {
              freshlyCreated: true,
            });
            (fileEnt as DirEntry & { kind: "file"; node?: FsNode }).node = node;
            c.entries.set(name, fileEnt);
            // Surface the file mode busybox requested; we still store as
            // 0644 in the backing fs (no mode storage there).
            node.mode = (node.mode & ~0o7777) | (mode & 0o7777);
            return node;
          },
    });
    parentDirNodes.set(subPath, dirNode);
    return dirNode;
  }

  // Materialise the mount root node and splice it into the VFS. mkdir up to
  // the parent dir so the mount path resolves on lookup.
  const normalizedMount = Vfs.normalize(mountPath, "/");
  if (!normalizedMount || normalizedMount === "/") {
    throw new Error(`workspace-fs: invalid mount path '${mountPath}'`);
  }
  const lastSlash = normalizedMount.lastIndexOf("/");
  const parentPath = lastSlash === 0 ? "/" : normalizedMount.slice(0, lastSlash);
  const leaf = normalizedMount.slice(lastSlash + 1);
  if (parentPath !== "/") vfs.mkdirp(parentPath, 0o755);
  const parentRes = vfs.walk(parentPath, { nofollow: true });
  if (parentRes.err || !parentRes.node || parentRes.node.type !== "dir") {
    throw new Error(`workspace-fs: parent of mount path '${mountPath}' is not a directory`);
  }
  if (parentRes.node.children?.has(leaf)) {
    throw new Error(`workspace-fs: '${mountPath}' already exists in the VFS`);
  }
  parentRes.node.children!.set(leaf, makeDirNode(""));

  return {
    refresh(subdir?: string) {
      if (!subdir) {
        dirCaches.clear();
        return;
      }
      const key = subdir.replace(/^\/+/, "").replace(/\/?$/, "/");
      dirCaches.delete(key === "/" ? "" : key);
    },
  };
}
