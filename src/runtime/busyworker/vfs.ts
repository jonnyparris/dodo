// @ts-nocheck — vendored from busyworker. Refresh procedure in VENDORED.md.
// In-memory virtual filesystem.
//
// Each node:
//   { type: 'dir'|'reg'|'symlink'|'char', mode, uid, gid, mtime, ino,
//     children: Map<string,Node> | data: Uint8Array | link: string | special: {read,write} }
//
// Paths are absolute, NUL-free, normalized (no //, no trailing /, no . or ..).

import { ENOENT, ENOTDIR, EISDIR, EEXIST, EINVAL, ELOOP, ENOTEMPTY, EPERM } from "./errno.js";
import type { FsNode, NodeType, DynamicDirOps, SpecialOps } from "./types.js";
import type { CpioEntry } from "./cpio.js";

const S_IFLNK  = 0o120000;
const S_IFREG  = 0o100000;
const S_IFDIR  = 0o040000;
const S_IFCHR  = 0o020000;

const MODE_OF: Record<NodeType, number> = { reg: S_IFREG, dir: S_IFDIR, symlink: S_IFLNK, char: S_IFCHR };

let nextIno = 1;

function makeNode(type: NodeType, mode: number): FsNode {
  const n: FsNode = {
    type,
    mode: (MODE_OF[type] || 0) | (mode & 0o7777),
    uid: 0, gid: 0,
    mtime: 0,
    ino: nextIno++,
  };
  if (type === "dir") n.children = new Map();
  else if (type === "reg") n.data = new Uint8Array(0);
  else if (type === "symlink") n.link = "";
  else if (type === "char") n.special = null;
  return n;
}

export interface WalkResult {
  err?: number;
  node?: FsNode | null;
  parent?: FsNode | null;
  name?: string;
}

export interface WalkOpts {
  nofollow?: boolean;
  parents?: boolean;
  cwd?: string | null;
}

export class Vfs {
  root: FsNode;
  cwd: string;

  constructor() {
    this.root = makeNode("dir", 0o755);
    // cwd is per-process; lives on the Kernel. Kept here only for the
    // normalize() default in legacy callers.
    this.cwd = "/";
  }

  // ---- path utilities ----
  static normalize(path: string, cwd: string = "/"): string | null {
    if (!path) return null;
    if (!path.startsWith("/")) path = (cwd === "/" ? "" : cwd) + "/" + path;
    const parts: string[] = [];
    for (const p of path.split("/")) {
      if (!p || p === ".") continue;
      if (p === "..") parts.pop();
      else parts.push(p);
    }
    return "/" + parts.join("/");
  }

  // Create a dynamic directory node. `ops`:
  //   list() -> string[]                — names to surface in readdir
  //   lookup(name) -> node | null       — resolve a child by name (synthesized)
  //
  // Dynamic dirs may also have static children (added via children.set); those
  // take precedence over dynamic.lookup().
  static makeDynamicDir(mode: number, ops: DynamicDirOps): FsNode {
    const n = makeNode("dir", mode);
    n.dynamic = ops;
    return n;
  }

  walk(path: string, opts: WalkOpts = {}): WalkResult {
    const { nofollow = false, parents = false, cwd = null } = opts;
    const abs = Vfs.normalize(path, cwd ?? this.cwd);
    if (abs === null) return { err: ENOENT };
    if (abs === "/") return { node: this.root, parent: null, name: "" };

    const parts = abs.slice(1).split("/");
    let node: FsNode = this.root;
    let parent: FsNode | null = null;
    let name = "";
    const LIMIT = 40;
    let loops = 0;

    for (let i = 0; i < parts.length; i++) {
      name = parts[i];
      if (node.type !== "dir") return { err: ENOTDIR };
      let child: FsNode | null | undefined = node.children!.get(name);
      if (!child && node.dynamic) {
        child = node.dynamic.lookup(name);
      }
      if (!child) {
        if (parents && i === parts.length - 1) {
          return { node: null, parent: node, name };
        }
        return { err: ENOENT, parent: node, name };
      }
      const isLast = i === parts.length - 1;
      if (child.type === "symlink" && (!isLast || !nofollow)) {
        if (++loops > LIMIT) return { err: ELOOP };
        // Resolve link: relative links are relative to dir of current node
        let target = child.link!;
        if (!target.startsWith("/")) {
          // Build base = current absolute path up to but not including child
          const base = "/" + parts.slice(0, i).join("/");
          target = base + (base === "/" ? "" : "/") + target;
        }
        // Continue resolving with remaining components appended
        const remaining = parts.slice(i + 1).join("/");
        const newPath = remaining ? target + "/" + remaining : target;
        return this.walk(newPath, { nofollow, parents });
      }
      parent = node;
      node = child;
    }
    return { node, parent, name };
  }

  // ---- low-level ops ----
  mkdir(path: string, mode: number): number {
    const r = this.walk(path, { parents: true, nofollow: true });
    if (r.err) return -r.err;
    if (r.node) return -EEXIST;
    if (!r.parent) return -EINVAL;
    const node = makeNode("dir", mode & 0o7777);
    r.parent.children!.set(r.name!, node);
    return 0;
  }

  // Remove a non-directory entry. Returns 0 or -errno.
  unlink(path: string): number {
    const r = this.walk(path, { nofollow: true });
    if (r.err) return -r.err;
    if (!r.parent || !r.name) return -EPERM;       // can't unlink "/"
    if (r.node!.type === "dir") return -EISDIR;
    r.parent.children!.delete(r.name);
    return 0;
  }

  // Remove an empty directory. Returns 0 or -errno.
  rmdir(path: string): number {
    const r = this.walk(path, { nofollow: true });
    if (r.err) return -r.err;
    if (!r.parent || !r.name) return -EPERM;       // can't rmdir "/"
    if (r.node!.type !== "dir") return -ENOTDIR;
    if (r.node!.children && r.node!.children.size > 0) return -ENOTEMPTY;
    r.parent.children!.delete(r.name);
    return 0;
  }

  symlink(target: string, linkpath: string): number {
    const r = this.walk(linkpath, { parents: true, nofollow: true });
    if (r.err) return -r.err;
    if (r.node) return -EEXIST;
    const node = makeNode("symlink", 0o777);
    node.link = target;
    r.parent!.children!.set(r.name!, node);
    return 0;
  }

  writeFile(path: string, data: Uint8Array | ArrayBuffer | ArrayLike<number>, mode: number = 0o644): number {
    const r = this.walk(path, { parents: true, nofollow: true });
    if (r.err && r.err !== ENOENT) return -r.err;
    let node = r.node;
    if (!node) {
      node = makeNode("reg", mode);
      r.parent!.children!.set(r.name!, node);
    } else if (node.type !== "reg") {
      return -EISDIR;
    }
    node.data = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike);
    return 0;
  }

  // Create or attach a character device at path with read/write callbacks.
  mknodChar(path: string, mode: number, special: SpecialOps): number {
    const r = this.walk(path, { parents: true, nofollow: true });
    if (r.err && r.err !== ENOENT) return -r.err;
    if (r.node) return -EEXIST;
    const node = makeNode("char", mode);
    node.special = special;
    r.parent!.children!.set(r.name!, node);
    return 0;
  }

  // mkdir -p
  mkdirp(path: string, mode: number = 0o755): number {
    const abs = Vfs.normalize(path, this.cwd);
    if (abs === "/") return 0;
    const parts = abs!.slice(1).split("/");
    let dir = this.root;
    for (const part of parts) {
      let child = dir.children!.get(part);
      if (!child) {
        child = makeNode("dir", mode);
        dir.children!.set(part, child);
      } else if (child.type !== "dir") {
        return -ENOTDIR;
      }
      dir = child;
    }
    return 0;
  }

  // Resolve a path to a node, following symlinks. Returns node or null.
  stat(path: string, opts: { nofollow?: boolean } = {}): FsNode | null {
    const { nofollow = false } = opts;
    const r = this.walk(path, { nofollow });
    return r.err ? null : (r.node ?? null);
  }
}

// Load entries from cpio into vfs.
export function loadCpio(vfs: Vfs, entries: CpioEntry[]): void {
  // First pass: create dirs in order
  for (const e of entries) {
    if (e.path === "/") continue;
    if (e.type === "dir") vfs.mkdirp(e.path, e.mode);
  }
  // Second pass: files and symlinks
  for (const e of entries) {
    if (e.path === "/" || e.type === "dir") continue;
    if (e.type === "reg") {
      vfs.writeFile(e.path, e.data!, e.mode);
      const n = vfs.stat(e.path, { nofollow: true });
      if (n) { n.uid = e.uid; n.gid = e.gid; n.mtime = e.mtime; }
    } else if (e.type === "symlink") {
      vfs.symlink(e.link!, e.path);
    }
  }
}
