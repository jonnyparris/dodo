// @ts-nocheck — vendored from busyworker. Refresh procedure in VENDORED.md.
// Mount a subtree of the Workers node:fs virtual filesystem into our VFS.
//
// Workers exposes a virtual FS via node:fs with:
//   /bundle  — read-only files included in the Worker bundle
//   /tmp     — writable, in-memory, per-isolate (not shared across requests)
//   /dev/*   — null/random/full/zero (we already supply our own)
//
// We expose host-backed paths as `dynamic` directories. Lookups translate
// into fs.statSync / fs.readFileSync etc., so the shell sees them as regular
// files. Writes go through fs.writeFileSync when the mount is writable.

import * as fs from "node:fs";

import { Vfs } from "./vfs.js";
import type { FsNode } from "./types.js";

let inoCounter = 200000;
const nextIno = (): number => inoCounter++;

function statToMode(st: fs.Stats): number {
  return st.mode || (st.isDirectory() ? 0o040755 : 0o100644);
}

function fileNode(hostPath: string, st: fs.Stats, { writable }: { writable: boolean }): FsNode {
  // Read file lazily on first access. Subsequent reads use the cached buffer
  // (we re-fetch on each lookup() anyway, so changes between lookups are
  // observable in the shell).
  let data: Uint8Array;
  try {
    data = new Uint8Array(fs.readFileSync(hostPath));
  } catch {
    data = new Uint8Array(0);
  }
  const node: FsNode = {
    type: "reg",
    mode: statToMode(st) & 0o7777 | 0o100000,
    uid: 0, gid: 0,
    mtime: Math.floor((st.mtimeMs || 0) / 1000),
    ino: nextIno(),
    data,
  };
  if (writable) {
    // Wrap as a "special" file so writes flush to the host fs.
    node.special = {
      read: (u8mem, buf, count) => {
        const n = Math.min(count, node.data!.length);
        if (n <= 0) return 0;
        u8mem.set(node.data!.subarray(0, n), buf);
        return n;
      },
      write: (u8mem, buf, count) => {
        const bytes = u8mem.slice(buf, buf + count);
        try {
          const grown = new Uint8Array(node.data!.length + bytes.length);
          grown.set(node.data!); grown.set(bytes, node.data!.length);
          node.data = grown;
          fs.writeFileSync(hostPath, node.data);
          return count;
        } catch {
          return -5; // EIO
        }
      },
      ioctl: () => 0,
      poll: () => 4,
    };
  }
  return node;
}

function dirNode(hostPath: string, { writable }: { writable: boolean }): FsNode {
  return Vfs.makeDynamicDir(0o555, {
    list: () => {
      try { return fs.readdirSync(hostPath); } catch { return []; }
    },
    lookup: (name: string) => {
      const child = hostPath.endsWith("/") ? hostPath + name : hostPath + "/" + name;
      let st: fs.Stats;
      try { st = fs.statSync(child); } catch { return null; }
      if (st.isDirectory()) return dirNode(child, { writable });
      if (st.isFile())      return fileNode(child, st, { writable });
      return null;
    },
  });
}

export function mountHostFs(
  vfs: Vfs,
  mountPath: string,
  hostPath: string,
  { writable = false }: { writable?: boolean } = {},
): void {
  const parts = mountPath.split("/").filter(Boolean);
  const leafName = parts.pop()!;
  const parentPath = "/" + parts.join("/");
  vfs.mkdirp(parentPath, 0o755);
  const parent = vfs.stat(parentPath);
  if (!parent || parent.type !== "dir") {
    throw new Error(`mountHostFs: parent ${parentPath} is not a dir`);
  }
  parent.children!.set(leafName, dirNode(hostPath, { writable }));
}
