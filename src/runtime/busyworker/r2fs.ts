// @ts-nocheck — vendored from busyworker. Refresh procedure in VENDORED.md.
// Mount an R2 bucket (or a key-prefix within one) as a read-only filesystem.
//
// Object layout convention:
//   - R2 keys map directly to file paths. A bucket containing the keys
//       docs/intro.md
//       docs/img/logo.png
//       README.md
//     mounted at /mnt/r2 exposes:
//       /mnt/r2/README.md
//       /mnt/r2/docs/intro.md
//       /mnt/r2/docs/img/logo.png
//   - "Directories" are derived from the `/` delimiter via R2's
//     `list({ delimiter: "/" })` (R2 has no real directory objects).
//   - Listings are cached per-directory for the lifetime of the Machine.
//     Call the returned `refresh(path?)` to invalidate.
//
// I/O model:
//   - readdir / stat populate from cached `list()` metadata (size, mtime).
//     No body fetch, no per-file HEAD.
//   - The first `read()` against a file fetches the whole object body via
//     `bucket.get()` and caches it on the FsNode. Subsequent reads are
//     served from memory. Range reads aren't used yet — see notes below.
//
// Not implemented (yet):
//   - Writes (mount is read-only; openat with O_WRONLY/O_RDWR will fail
//     with EROFS via mode bits, which busybox surfaces as "Read-only file
//     system").
//   - Range fetches. Big files load entirely on first byte. Fine for the
//     typical `cat`/`wget -O` shape; bad for `tail -c 1k bigfile`.
//   - Mutations: `rm`, `mv`, `mkdir`. R2 is currently a read-only mirror.

import { Vfs } from "./vfs.js";
import { ENOENT, EISDIR, ENOTDIR, ENOTEMPTY, EEXIST, EIO, EXDEV } from "./errno.js";
import { O_APPEND, O_TRUNC, O_ACCMODE, O_RDONLY } from "./fd.js";
import type { FsNode } from "./types.js";

/** Subset of `R2Bucket` we actually use. Matches @cloudflare/workers-types. */
export interface R2BucketLike {
  list(options?: {
    prefix?: string;
    delimiter?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    objects: Array<{ key: string; size: number; uploaded: Date }>;
    delimitedPrefixes?: string[];
    truncated?: boolean;
    cursor?: string;
  }>;
  get(key: string): Promise<null | { arrayBuffer(): Promise<ArrayBuffer> }>;
  put(key: string, value: ArrayBuffer | ArrayBufferView | string | null): Promise<{ size: number; uploaded: Date } | null>;
  delete(keys: string | string[]): Promise<void>;
}

export interface R2FsMountOpts {
  /** Key prefix inside the bucket to expose (default: ""). Trailing "/" optional. */
  prefix?: string;
  /** Logger for diagnostics. */
  log?: (s: string) => void;
  /**
   * Allow mutations (unlink, rmdir, mkdir, and — in a later pass — writes
   * and rename). Default: `false`. When `false`, the mount behaves like
   * Phase 1: read-only.
   */
  writable?: boolean;
}

type DirEntry =
  | { kind: "dir"; synthetic?: boolean; node?: FsNode }
  | { kind: "file"; size: number; mtime: number; key: string; node?: FsNode };

interface DirCache {
  /** child name → entry. Populated on first `ensureLoaded()`. */
  entries: Map<string, DirEntry>;
  loadedPromise: Promise<void> | null;
  loaded: boolean;
}

let inoCounter = 300000;
const nextIno = (): number => inoCounter++;

export function mountR2Fs(
  vfs: Vfs,
  mountPath: string,
  bucket: R2BucketLike,
  opts: R2FsMountOpts = {},
): { refresh: (subdir?: string) => void } {
  const log = opts.log ?? (() => {});
  const writable = opts.writable ?? false;
  // Normalize prefix: stored without leading "/", with trailing "/" if non-empty.
  let basePrefix = (opts.prefix ?? "").replace(/^\/+/, "");
  if (basePrefix && !basePrefix.endsWith("/")) basePrefix += "/";

  // Cache of directory contents, keyed by the R2 prefix (including trailing "/"
  // — "" for the mount root).
  const dirCaches = new Map<string, DirCache>();

  function getCache(prefix: string): DirCache {
    let c = dirCaches.get(prefix);
    if (!c) {
      c = { entries: new Map(), loadedPromise: null, loaded: false };
      dirCaches.set(prefix, c);
    }
    return c;
  }

  async function loadDir(prefix: string, cache: DirCache): Promise<void> {
    cache.entries.clear();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await bucket.list({
        prefix: basePrefix + prefix,
        delimiter: "/",
        cursor,
        limit: 1000,
      });
      const stripLen = (basePrefix + prefix).length;
      for (const obj of res.objects) {
        // Object key === directory prefix happens when something put a zero-
        // byte marker at the dir path; skip — directories are synthesized.
        if (obj.key.length <= stripLen) continue;
        const name = obj.key.slice(stripLen);
        if (name.includes("/")) continue; // shouldn't happen with delimiter
        cache.entries.set(name, {
          kind: "file",
          size: obj.size,
          mtime: Math.floor(obj.uploaded.getTime() / 1000),
          key: obj.key,
        });
      }
      for (const p of res.delimitedPrefixes ?? []) {
        // p ends with "/"; derive child name.
        const tail = p.slice(stripLen, -1);
        if (!tail) continue;
        // File takes precedence if same name (shouldn't happen normally).
        if (!cache.entries.has(tail)) cache.entries.set(tail, { kind: "dir" });
      }
      cursor = res.truncated ? res.cursor : undefined;
      pages++;
      if (pages > 100) {
        log(`r2fs: aborting listing of ${basePrefix + prefix} after 100 pages`);
        break;
      }
    } while (cursor);
    cache.loaded = true;
  }

  /** Block via `ensureLoaded()` would need async; we synthesize a node
   *  whose `list()`/`lookup()` schedule a load on the first miss. Until
   *  the load resolves, the dir appears empty — callers should ensure they
   *  await the cache (e.g. via the `prewarm` helper) before relying on it. */
  function ensureLoaded(prefix: string): Promise<void> {
    const c = getCache(prefix);
    if (c.loaded) return Promise.resolve();
    if (!c.loadedPromise) {
      c.loadedPromise = loadDir(prefix, c).catch((e: any) => {
        log(`r2fs: list(${basePrefix + prefix}) failed: ${e?.message ?? e}`);
        c.loaded = true; // give up, expose empty dir
      });
    }
    return c.loadedPromise;
  }

  // FsNode for an R2-backed regular file. Handles both reads (materialise
  // on first byte, serve from `node.data`) and — when the mount is
  // writable — writes (buffer in `node.data`, refcount opens, flush via
  // `bucket.put` when the last writer closes).
  //
  // `initialData` lets us bypass the initial GET when we already know the
  // body (e.g. a freshly-created file via createAsync starts empty).
  function makeFileNode(
    fileEntry: { size: number; mtime: number; key: string },
    initialData?: Uint8Array,
    opts: { freshlyCreated?: boolean } = {},
  ): FsNode {
    const node: FsNode = {
      type: "reg",
      mode: writable ? 0o100644 : 0o100444,
      uid: 0, gid: 0,
      mtime: fileEntry.mtime,
      ino: nextIno(),
      size: fileEntry.size,
    };
    if (initialData) {
      node.data = initialData;
      node.size = initialData.length;
    }

    // Per-node state shared across all fds opened on it.
    let fetching: Promise<void> | null = null;
    // Freshly-created files start dirty so that even `touch foo` (open +
    // close without writing) lands a zero-byte object in R2.
    let dirty = !!opts.freshlyCreated;
    let openWriters = 0;
    let flushPending: Promise<void> | null = null;

    const materialize = async (skipFetch = false): Promise<void> => {
      if (node.data) return;
      if (skipFetch) { node.data = new Uint8Array(0); node.size = 0; return; }
      if (!fetching) {
        fetching = (async () => {
          try {
            const obj = await bucket.get(fileEntry.key);
            node.data = obj ? new Uint8Array(await obj.arrayBuffer()) : new Uint8Array(0);
          } catch (e: any) {
            log(`r2fs: get(${fileEntry.key}) failed: ${e?.message ?? e}`);
            node.data = new Uint8Array(0);
          }
          node.size = node.data!.length;
        })();
      }
      await fetching;
    };

    const flush = async (): Promise<void> => {
      if (!dirty) return;
      // Coalesce concurrent flushes — only one PUT in flight at a time.
      if (flushPending) { await flushPending; return; }
      const body = node.data!.slice();
      flushPending = (async () => {
        try {
          const res = await bucket.put(fileEntry.key, body);
          if (res) {
            fileEntry.size = res.size;
            fileEntry.mtime = Math.floor(res.uploaded.getTime() / 1000);
            node.mtime = fileEntry.mtime;
          } else {
            fileEntry.size = body.length;
          }
          node.size = body.length;
          dirty = false;
        } catch (e: any) {
          log(`r2fs: put(${fileEntry.key}) failed: ${e?.message ?? e}`);
          throw e;
        }
      })();
      try { await flushPending; }
      finally { flushPending = null; }
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
      writeAsync: !writable ? undefined : async (u8mem, buf, count, fd) => {
        // O_TRUNC on open zeroed node.data synchronously, so materialize()
        // is a no-op in that case. For O_RDWR / O_APPEND we need the
        // existing body first.
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
      // The sync close path only adjusts the writer refcount. The PUT
      // itself lives in closeAsync — initiating `bucket.put` from a
      // fire-and-forget Promise can race with the surrounding RPC's I/O
      // context ending, and the upload's request body becomes unreadable.
      inherit: (entry) => {
        if (entry && (entry.flags & O_ACCMODE) !== O_RDONLY) openWriters++;
      },
      close: (entry) => {
        if (!entry || (entry.flags & O_ACCMODE) === O_RDONLY) return;
        openWriters--;
      },
      closeAsync: !writable ? undefined : async (entry) => {
        if (!entry || (entry.flags & O_ACCMODE) === O_RDONLY) return;
        if (openWriters <= 0 && dirty) await flush();
      },
    };
    return node;
  }

  function makeDirNode(prefix: string): FsNode {
    const mode = writable ? 0o755 : 0o555;
    const dirNode = Vfs.makeDynamicDir(mode, {
      // Awaited by the kernel before path-resolving syscalls touch this
      // directory; see `Kernel.preloadPath`. After it resolves, `list()` and
      // `lookup()` are guaranteed to return populated results.
      preload: () => ensureLoaded(prefix),
      list: () => {
        const c = getCache(prefix);
        if (!c.loaded) { void ensureLoaded(prefix); return []; }
        return Array.from(c.entries.keys());
      },
      lookup: (name: string): FsNode | null => {
        const c = getCache(prefix);
        if (!c.loaded) { void ensureLoaded(prefix); return null; }
        const ent = c.entries.get(name);
        if (!ent) return null;
        if (ent.node) return ent.node;
        const node = ent.kind === "dir"
          ? makeDirNode(prefix + name + "/")
          : makeFileNode(ent);
        ent.node = node;
        return node;
      },
      unlinkAsync: !writable ? undefined : async (name: string): Promise<number> => {
        await ensureLoaded(prefix);
        const c = getCache(prefix);
        const ent = c.entries.get(name);
        if (!ent) return -ENOENT;
        if (ent.kind === "dir") return -EISDIR;
        try {
          await bucket.delete(ent.key);
        } catch (e: any) {
          log(`r2fs: delete(${ent.key}) failed: ${e?.message ?? e}`);
          return -EIO;
        }
        c.entries.delete(name);
        return 0;
      },
      rmdirAsync: !writable ? undefined : async (name: string): Promise<number> => {
        await ensureLoaded(prefix);
        const c = getCache(prefix);
        const ent = c.entries.get(name);
        if (!ent) return -ENOENT;
        if (ent.kind !== "dir") return -ENOTDIR;
        // R2 has no real dirs; the only requirement is that no objects live
        // under prefix+name+"/" — load that subdir and check.
        const childPrefix = prefix + name + "/";
        await ensureLoaded(childPrefix);
        const childCache = getCache(childPrefix);
        if (childCache.entries.size > 0) return -ENOTEMPTY;
        c.entries.delete(name);
        dirCaches.delete(childPrefix);
        return 0;
      },
      mkdirAsync: !writable ? undefined : async (name: string, _mode: number): Promise<number> => {
        await ensureLoaded(prefix);
        const c = getCache(prefix);
        if (c.entries.has(name)) return -EEXIST;
        c.entries.set(name, { kind: "dir", synthetic: true });
        const childCache = getCache(prefix + name + "/");
        childCache.loaded = true;
        return 0;
      },
      renameAsync: !writable ? undefined : async (oldName, newParentNode, newName): Promise<number> => {
        await ensureLoaded(prefix);
        const srcCache = getCache(prefix);
        const srcEnt = srcCache.entries.get(oldName);
        if (!srcEnt) return -ENOENT;
        // Find which prefix newParentNode belongs to in this mount; reject
        // cross-backend renames with EXDEV (userspace falls back to copy +
        // unlink, which works through our normal write path).
        let dstPrefix: string | null = null;
        for (const [p, n] of parentDirNodes) {
          if (n === newParentNode) { dstPrefix = p; break; }
        }
        if (dstPrefix === null) return -EXDEV;
        await ensureLoaded(dstPrefix);
        const dstCache = getCache(dstPrefix);
        if (dstCache.entries.has(newName)) {
          const collision = dstCache.entries.get(newName)!;
          if (collision.kind === "dir") return -EISDIR;
          // Overwrite is allowed for files — delete the destination first.
          try { await bucket.delete(collision.key!); } catch (e: any) {
            log(`r2fs: rename: delete dst failed: ${e?.message ?? e}`);
            return -EIO;
          }
          dstCache.entries.delete(newName);
          const dstDirNode = parentDirNodes.get(dstPrefix);
          dstDirNode?.children?.delete(newName);
        }
        if (srcEnt.kind === "dir") {
          // Renaming a (synthetic) dir: relabel cache only — no R2 work.
          srcCache.entries.delete(oldName);
          dstCache.entries.set(newName, srcEnt);
          // Re-key any cached subtree.
          const oldChildPrefix = prefix + oldName + "/";
          const newChildPrefix = dstPrefix + newName + "/";
          const sub = dirCaches.get(oldChildPrefix);
          if (sub) { dirCaches.set(newChildPrefix, sub); dirCaches.delete(oldChildPrefix); }
          const subDir = parentDirNodes.get(oldChildPrefix);
          if (subDir) { parentDirNodes.set(newChildPrefix, subDir); parentDirNodes.delete(oldChildPrefix); }
          return 0;
        }
        // File rename: R2 has no server-side rename. Stream the body and
        // delete the source. Not atomic — documented limitation.
        const newKey = basePrefix + dstPrefix + newName;
        try {
          const obj = await bucket.get(srcEnt.key);
          const body = obj ? new Uint8Array(await obj.arrayBuffer()) : new Uint8Array(0);
          await bucket.put(newKey, body);
          await bucket.delete(srcEnt.key);
        } catch (e: any) {
          log(`r2fs: rename ${srcEnt.key}->${newKey} failed: ${e?.message ?? e}`);
          return -EIO;
        }
        // Update caches. The cached node, if any, keeps pointing at the
        // same FsNode but its underlying key has moved — refresh both.
        srcCache.entries.delete(oldName);
        const movedEnt = { ...srcEnt, key: newKey };
        dstCache.entries.set(newName, movedEnt);
        // Drop stale children-map entries on both sides; lookups will
        // rebuild lazily.
        const srcDirNode = parentDirNodes.get(prefix);
        srcDirNode?.children?.delete(oldName);
        const dstDirNode = parentDirNodes.get(dstPrefix);
        dstDirNode?.children?.delete(newName);
        return 0;
      },
      createAsync: !writable ? undefined : async (name: string, _mode: number): Promise<FsNode | number> => {
        await ensureLoaded(prefix);
        const c = getCache(prefix);
        if (c.entries.has(name)) return -EEXIST;
        const file = { size: 0, mtime: Math.floor(Date.now() / 1000), key: basePrefix + prefix + name };
        const node = makeFileNode(file, new Uint8Array(0), { freshlyCreated: true });
        c.entries.set(name, { kind: "file", size: 0, mtime: file.mtime, key: file.key, node });
        // Splice into the static children of the parent dir node so
        // sys_openat's sync walk finds this new node before dynamic.lookup
        // re-resolves through the cache (and to avoid colliding with
        // sys_openat's own vfs.writeFile fallback).
        const parentDirNode = parentDirNodes.get(prefix);
        if (parentDirNode) parentDirNode.children!.set(name, node);
        return node;
      },
    });
    parentDirNodes.set(prefix, dirNode);
    return dirNode;
  }

  // Map each prefix → the FsNode we minted for it, so createAsync can
  // attach new children to the right static-children map.
  const parentDirNodes = new Map<string, FsNode>();

  // Splice the dynamic root into the VFS at mountPath.
  const parts = mountPath.split("/").filter(Boolean);
  const leafName = parts.pop()!;
  const parentPath = "/" + parts.join("/");
  vfs.mkdirp(parentPath, 0o755);
  const parent = vfs.stat(parentPath);
  if (!parent || parent.type !== "dir") {
    throw new Error(`mountR2Fs: parent ${parentPath} is not a dir`);
  }
  parent.children!.set(leafName, makeDirNode(""));

  return {
    refresh: (subdir?: string): void => {
      if (!subdir) {
        dirCaches.clear();
        return;
      }
      let p = subdir.replace(/^\/+/, "");
      if (p && !p.endsWith("/")) p += "/";
      dirCaches.delete(p);
    },
  };
}
