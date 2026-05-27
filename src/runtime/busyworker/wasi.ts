// @ts-nocheck — vendored from busyworker. Refresh procedure in VENDORED.md.
// WASI preview1 shim.
//
// Bridges `wasi_snapshot_preview1.*` imports onto our existing VFS / FD /
// Kernel. WASI binaries run as ordinary processes in the same userspace as
// busybox: they share the VFS, see the same files, can be piped together, etc.
//
// All imports are wrapped in `WebAssembly.Suspending` so blocking I/O (TTY
// reads, socket reads) can yield via JSPI just like the Linux side does.
// Non-blocking calls return a plain number and continue without suspending.
//
// Notes on scope:
//   - preview1 only. WASIX extensions (threads, fork, sockets, signals) are
//     out of scope; binaries that need them won't run.
//   - The "capability sandbox" is intentionally disabled. We advertise "/" as
//     preopen fd 3 and accept absolute paths anywhere. This makes WASI
//     binaries see the same VFS as busybox, which is the whole point.
//   - fs_rights_* bitmasks are ignored. We honor the open flags only.

import * as LE from "./errno.js";
import {
  O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC,
  O_APPEND, O_NONBLOCK, O_DIRECTORY, O_NOFOLLOW,
} from "./fd.js";

// ---- WASI errno (NOT the same numbers as Linux) ----
const W = {
  SUCCESS: 0, ACCES: 2, AGAIN: 6, BADF: 8, BUSY: 10, EXIST: 20,
  FAULT: 21, INTR: 27, INVAL: 28, IO: 29, ISDIR: 31, LOOP: 32,
  MFILE: 33, NAMETOOLONG: 37, NOENT: 44, NOEXEC: 45, NOMEM: 48,
  NOSPC: 51, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, NOTSUP: 58,
  NOTTY: 59, PERM: 63, PIPE: 64, RANGE: 68, ROFS: 69, SPIPE: 70,
};

// Convert a Linux -errno (negative) to a WASI errno (positive).
function le2we(linuxNeg) {
  const e = -linuxNeg;
  switch (e) {
    case LE.EBADF:        return W.BADF;
    case LE.ENOENT:       return W.NOENT;
    case LE.EINVAL:       return W.INVAL;
    case LE.EISDIR:       return W.ISDIR;
    case LE.ENOTDIR:      return W.NOTDIR;
    case LE.EAGAIN:       return W.AGAIN;
    case LE.EACCES:       return W.ACCES;
    case LE.EEXIST:       return W.EXIST;
    case LE.ENOSPC:       return W.NOSPC;
    case LE.ENOSYS:       return W.NOSYS;
    case LE.EROFS:        return W.ROFS;
    case LE.ESPIPE:       return W.SPIPE;
    case LE.ERANGE:       return W.RANGE;
    case LE.EPIPE:        return W.PIPE;
    case LE.EIO:          return W.IO;
    case LE.ELOOP:        return W.LOOP;
    case LE.ENAMETOOLONG: return W.NAMETOOLONG;
    case LE.ENOMEM:       return W.NOMEM;
    case LE.ENOTEMPTY:    return W.NOTEMPTY;
    case LE.EPERM:        return W.PERM;
    default:              return W.INVAL;
  }
}

// WASI oflags bits
const O_CREAT_W      = 0x1;
const O_DIRECTORY_W  = 0x2;
const O_EXCL_W       = 0x4;
const O_TRUNC_W      = 0x8;

// WASI fdflags bits
const FD_APPEND   = 0x1;
const FD_NONBLOCK = 0x4;

// WASI rights bits we actually use
const RIGHTS_FD_READ  = 1n << 1n;
const RIGHTS_FD_WRITE = 1n << 6n;

// WASI filetypes
const FT_UNKNOWN          = 0;
const FT_BLOCK_DEVICE     = 1;
const FT_CHARACTER_DEVICE = 2;
const FT_DIRECTORY        = 3;
const FT_REGULAR_FILE     = 4;
const FT_SOCKET_DGRAM     = 5;
const FT_SOCKET_STREAM    = 6;
const FT_SYMBOLIC_LINK    = 7;

function nodeFiletype(node) {
  if (!node) return FT_UNKNOWN;
  if (node.type === "dir")     return FT_DIRECTORY;
  if (node.type === "reg")     return FT_REGULAR_FILE;
  if (node.type === "symlink") return FT_SYMBOLIC_LINK;
  if (node.type === "char")    return FT_CHARACTER_DEVICE;
  return FT_UNKNOWN;
}

// Single preopen: fd 3 → "/".
const PREOPEN_FD = 3;
const PREOPEN_DIR = "/";

export class WasiExit extends Error {
  code: number;
  constructor(code: number) { super(`wasi exit(${code})`); this.code = code; }
}

export interface WasiOpts {
  proc: any;
  argv: string[];
  envp: string[];
  log?: (s: string) => void;
}

export class Wasi {
  proc: any;
  argv: string[];
  envp: string[];
  log: (s: string) => void;
  fdPaths: Map<number, string>;
  preopenServed: boolean;
  [k: string]: any;

  // proc: the Process object (has .kernel, .fdt, .memory, .exitCode...)
  // argv, envp: arrays of strings as passed to _start.
  constructor({ proc, argv, envp, log }: WasiOpts) {
    this.proc = proc;
    this.argv = argv;
    this.envp = envp;
    this.log = log || (() => {});
    // Path tracking per fd. Mirrors what kernel openat sets, but for prestats.
    this.fdPaths = new Map();
    this.fdPaths.set(PREOPEN_FD, PREOPEN_DIR);
    // Track whether the preopen has been consumed yet (libc walks 3,4,5,...).
    this.preopenServed = false;
  }

  // ---- memory helpers ----
  _u8() { return new Uint8Array(this.proc.memory.buffer); }
  _dv() { return new DataView(this.proc.memory.buffer); }
  _readStr(ptr, len) {
    return new TextDecoder().decode(this._u8().subarray(ptr, ptr + len));
  }
  _writeStr(s, ptr) {
    const b = new TextEncoder().encode(s);
    this._u8().set(b, ptr);
    return b.length;
  }

  // Resolve a WASI (dirfd, path) into an absolute VFS path. WASI binaries
  // typically pass dirfd=3 (the preopen) plus a path that may be absolute or
  // relative. We accept both.
  _resolve(dirfd, pathStr) {
    if (pathStr.startsWith("/")) return pathStr;
    if (dirfd === PREOPEN_FD) {
      return PREOPEN_DIR + (PREOPEN_DIR.endsWith("/") ? "" : "/") + pathStr;
    }
    const e = this.proc.fdt.get(dirfd);
    if (!e) return null;
    const base = e.path || "/";
    return base + (base.endsWith("/") ? "" : "/") + pathStr;
  }

  // ============================================================
  //  Imports table
  // ============================================================
  buildImports() {
    const Suspending = WebAssembly.Suspending;
    const k = this.proc.kernel;
    const fdt = this.proc.fdt;

    // Register the preopen as a real fdt entry pointing at the VFS root, so
    // syscalls like fd_fdstat_get(3) work. wasi-libc's open() implementation
    // calls fd_fdstat_get on the preopen during path resolution; without a
    // real entry it returns BADF and every open() through wasi-libc fails
    // with EBADF.
    if (!fdt.get(PREOPEN_FD)) {
      const rootNode = k.vfs.stat(PREOPEN_DIR);
      if (rootNode) {
        fdt.map.set(PREOPEN_FD, { node: rootNode, flags: 0, offset: 0, path: PREOPEN_DIR });
        if (fdt.next <= PREOPEN_FD) fdt.next = PREOPEN_FD + 1;
      }
    }

    // Most calls are sync; we still wrap in Suspending so blocking ones can
    // return a Promise. Suspending() on a sync return is a no-op.
    // Note: Workers' JSPI passes wasm args directly to the JS function (no
    // suspender-prefix args), so we register handlers with the natural arity.
    const I: Record<string, any> = {};
    const reg = (name, fn) => { I[name] = new Suspending(fn); };

    // -------- args_* / environ_* --------
    const argv = this.argv;
    const envp = this.envp;

    reg("args_sizes_get", (countPtr, bufPtr) => {
      const bytes = argv.reduce((n, s) => n + new TextEncoder().encode(s).length + 1, 0);
      const dv = this._dv();
      dv.setUint32(countPtr, argv.length, true);
      dv.setUint32(bufPtr, bytes, true);
      return W.SUCCESS;
    });
    reg("args_get", (argvPtr, bufPtr) => {
      const dv = this._dv();
      const u8 = this._u8();
      let p = bufPtr;
      for (let i = 0; i < argv.length; i++) {
        dv.setUint32(argvPtr + i * 4, p, true);
        const b = new TextEncoder().encode(argv[i] + "\0");
        u8.set(b, p);
        p += b.length;
      }
      return W.SUCCESS;
    });
    reg("environ_sizes_get", (countPtr, bufPtr) => {
      const bytes = envp.reduce((n, s) => n + new TextEncoder().encode(s).length + 1, 0);
      const dv = this._dv();
      dv.setUint32(countPtr, envp.length, true);
      dv.setUint32(bufPtr, bytes, true);
      return W.SUCCESS;
    });
    reg("environ_get", (envPtr, bufPtr) => {
      const dv = this._dv();
      const u8 = this._u8();
      let p = bufPtr;
      for (let i = 0; i < envp.length; i++) {
        dv.setUint32(envPtr + i * 4, p, true);
        const b = new TextEncoder().encode(envp[i] + "\0");
        u8.set(b, p);
        p += b.length;
      }
      return W.SUCCESS;
    });

    // -------- clocks / random / yield --------
    reg("clock_time_get", (_clkId, _prec, outPtr) => {
      const ns = BigInt(Date.now()) * 1_000_000n;
      this._dv().setBigUint64(outPtr, ns, true);
      return W.SUCCESS;
    });
    reg("clock_res_get", (_clkId, outPtr) => {
      this._dv().setBigUint64(outPtr, 1_000_000n, true); // 1ms
      return W.SUCCESS;
    });
    reg("random_get", (ptr, len) => {
      const chunk = Math.min(len, 65536);
      for (let off = 0; off < len; off += chunk) {
        const n = Math.min(chunk, len - off);
        const tmp = new Uint8Array(n);
        crypto.getRandomValues(tmp);
        this._u8().set(tmp, ptr + off);
      }
      return W.SUCCESS;
    });
    reg("sched_yield", () => W.SUCCESS);

    // -------- proc_exit --------
    reg("proc_exit", (code) => { throw new WasiExit(code & 0xff); });

    // -------- preopens (advertise / as fd 3) --------
    reg("fd_prestat_get", (fd, outPtr) => {
      if (fd !== PREOPEN_FD || this.preopenServed) return W.BADF;
      const dv = this._dv();
      dv.setUint8(outPtr, 0);                           // tag: dir
      // 32-bit u_dir_name_len at offset 4 (struct is padded to 8)
      dv.setUint32(outPtr + 4, new TextEncoder().encode(PREOPEN_DIR).length, true);
      return W.SUCCESS;
    });
    reg("fd_prestat_dir_name", (fd, pathPtr, pathLen) => {
      if (fd !== PREOPEN_FD) return W.BADF;
      const b = new TextEncoder().encode(PREOPEN_DIR);
      if (pathLen < b.length) return W.NAMETOOLONG;
      this._u8().set(b, pathPtr);
      this.preopenServed = true;
      return W.SUCCESS;
    });

    // -------- fd_* --------
    reg("fd_close", (fd) => {
      const r = fdt.close(fd);
      this.fdPaths.delete(fd);
      return r < 0 ? le2we(r) : W.SUCCESS;
    });

    // fd_read / fd_write: WASI passes iovecs (ptr,len) pairs. We loop and
    // call into the kernel's read/write paths (which handle TTY, pipes,
    // sockets, regular files uniformly).
    const writeIovs = async (fd, iovsPtr, iovsLen, nwrittenPtr, useAsync) => {
      const dv = this._dv();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const base = iovsPtr + i * 8;
        const ptr = dv.getUint32(base, true);
        const len = dv.getUint32(base + 4, true);
        const r = useAsync
          ? await this._writeFd(fd, ptr, len)
          : k.sys_write(fd, ptr, len);
        if (r < 0) {
          if (total > 0) break;
          this._dv().setUint32(nwrittenPtr, 0, true);
          return le2we(r);
        }
        total += r;
        if (r < len) break;
      }
      this._dv().setUint32(nwrittenPtr, total, true);
      return W.SUCCESS;
    };
    const readIovs = async (fd, iovsPtr, iovsLen, nreadPtr) => {
      const dv = this._dv();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const base = iovsPtr + i * 8;
        const ptr = dv.getUint32(base, true);
        const len = dv.getUint32(base + 4, true);
        const r = await this._readFd(fd, ptr, len);
        if (r < 0) {
          if (total > 0) break;
          this._dv().setUint32(nreadPtr, 0, true);
          return le2we(r);
        }
        total += r;
        if (r < len) break;          // short read → stop, like POSIX read
      }
      this._dv().setUint32(nreadPtr, total, true);
      return W.SUCCESS;
    };
    // fd_write is async because TTY may technically buffer, but in practice
    // sys_write is sync for regular files / TTY out. Stay async-safe.
    I.fd_write = new Suspending(async (fd, iovs, iovsLen, nwrittenPtr) =>
      writeIovs(fd, iovs, iovsLen, nwrittenPtr, true));
    I.fd_read  = new Suspending(async (fd, iovs, iovsLen, nreadPtr) =>
      readIovs(fd, iovs, iovsLen, nreadPtr));

    // fd_seek(fd:i32, offset:i64, whence:i32, newOffsetPtr:i32) — i64 arrives
    // as a BigInt under Workers' wasm BigInt integration.
    reg("fd_seek", (fd, offsetBig, whence, newOffsetPtr) => {
      const offset = Number(offsetBig);
      const r = k.sys_llseek(fd, (offset / 0x100000000) | 0, offset & 0xFFFFFFFF, 0, whence);
      if (r < 0) return le2we(r);
      const e = fdt.get(fd);
      if (newOffsetPtr) this._dv().setBigUint64(newOffsetPtr, BigInt(e ? e.offset : 0), true);
      return W.SUCCESS;
    });

    reg("fd_tell", (fd, outPtr) => {
      const e = fdt.get(fd);
      if (!e) return W.BADF;
      this._dv().setBigUint64(outPtr, BigInt(e.offset || 0), true);
      return W.SUCCESS;
    });

    reg("fd_fdstat_get", (fd, outPtr) => {
      const e = fdt.get(fd);
      if (!e) return W.BADF;
      const dv = this._dv();
      this._u8().fill(0, outPtr, outPtr + 24);
      dv.setUint8(outPtr + 0, nodeFiletype(e.node));
      dv.setUint16(outPtr + 2, (e.flags & O_APPEND ? FD_APPEND : 0) | (e.flags & O_NONBLOCK ? FD_NONBLOCK : 0), true);
      // Grant all rights — capability check is off.
      dv.setBigUint64(outPtr + 8, 0xFFFFFFFFFFFFFFFFn, true);
      dv.setBigUint64(outPtr + 16, 0xFFFFFFFFFFFFFFFFn, true);
      return W.SUCCESS;
    });
    reg("fd_fdstat_set_flags", (fd, fdflags) => {
      const e = fdt.get(fd);
      if (!e) return W.BADF;
      e.flags = (e.flags & ~(O_APPEND | O_NONBLOCK))
              | (fdflags & FD_APPEND   ? O_APPEND   : 0)
              | (fdflags & FD_NONBLOCK ? O_NONBLOCK : 0);
      return W.SUCCESS;
    });
    reg("fd_fdstat_set_rights", () => W.SUCCESS);

    // filestat — fill a 64-byte struct.
    const writeFilestat = (outPtr, node) => {
      const dv = this._dv();
      this._u8().fill(0, outPtr, outPtr + 64);
      dv.setBigUint64(outPtr + 0,  1n, true);                    // dev
      dv.setBigUint64(outPtr + 8,  BigInt(node.ino), true);      // ino
      dv.setUint8   (outPtr + 16, nodeFiletype(node));           // filetype
      dv.setBigUint64(outPtr + 24, 1n, true);                    // nlink
      const size = node.type === "reg" ? node.data.length
                 : node.type === "symlink" ? node.link.length
                 : 0;
      dv.setBigUint64(outPtr + 32, BigInt(size), true);          // size
      const tns = BigInt(node.mtime || 0) * 1_000_000_000n;
      dv.setBigUint64(outPtr + 40, tns, true);                   // atim
      dv.setBigUint64(outPtr + 48, tns, true);                   // mtim
      dv.setBigUint64(outPtr + 56, tns, true);                   // ctim
    };
    reg("fd_filestat_get", (fd, outPtr) => {
      const e = fdt.get(fd);
      if (!e) return W.BADF;
      writeFilestat(outPtr, e.node);
      return W.SUCCESS;
    });
    reg("path_filestat_get", (dirfd, _lookupFlags, pathPtr, pathLen, outPtr) => {
      const path = this._resolve(dirfd, this._readStr(pathPtr, pathLen));
      if (path === null) return W.BADF;
      const node = k.vfs.stat(path);
      if (!node) return W.NOENT;
      writeFilestat(outPtr, node);
      return W.SUCCESS;
    });

    // path_open(dirfd:i32, dirflags:i32, path:i32, path_len:i32, oflags:i32,
    //           rights_base:i64, rights_inheriting:i64, fdflags:i32, opened_fd_ptr:i32)
    // i64s arrive as BigInt.
    reg("path_open", (dirfd, _lookupFlags, pathPtr, pathLen, oflags, rightsBase, _rightsInh, fdflags, outPtr) => {
      const pathStr = this._readStr(pathPtr, pathLen);
      const abs = this._resolve(dirfd, pathStr);
      if (abs === null) return W.BADF;

      // Translate flags.
      const wantWrite = (rightsBase & RIGHTS_FD_WRITE) !== 0n;
      const wantRead  = (rightsBase & RIGHTS_FD_READ)  !== 0n;
      let linuxFlags = 0;
      if (wantRead && wantWrite) linuxFlags |= O_RDWR;
      else if (wantWrite)         linuxFlags |= O_WRONLY;
      else                        linuxFlags |= O_RDONLY;
      if (oflags & O_CREAT_W)     linuxFlags |= O_CREAT;
      if (oflags & O_EXCL_W)      linuxFlags |= O_EXCL;
      if (oflags & O_TRUNC_W)     linuxFlags |= O_TRUNC;
      if (oflags & O_DIRECTORY_W) linuxFlags |= O_DIRECTORY;
      if (fdflags & FD_APPEND)    linuxFlags |= O_APPEND;
      if (fdflags & FD_NONBLOCK)  linuxFlags |= O_NONBLOCK;

      // Re-use the kernel's openat machinery via a synthetic pathPtr.
      // Easiest: walk the vfs ourselves and allocate an fd, mirroring sys_openat.
      let r = k.vfs.walk(abs);
      if (r.err === LE.ENOENT && (linuxFlags & O_CREAT)) {
        k.vfs.writeFile(abs, new Uint8Array(0), 0o644);
        r = k.vfs.walk(abs);
      }
      if (r.err) return le2we(-r.err);
      if (r.node.type === "dir" && (linuxFlags & 3) !== O_RDONLY) return W.ISDIR;
      if ((linuxFlags & O_DIRECTORY) && r.node.type !== "dir") return W.NOTDIR;
      if ((linuxFlags & O_TRUNC) && r.node.type === "reg") r.node.data = new Uint8Array(0);
      const fd = fdt.alloc({ node: r.node, flags: linuxFlags, offset: 0, path: abs });
      this.fdPaths.set(fd, abs);
      this._dv().setUint32(outPtr, fd, true);
      return W.SUCCESS;
    });

    // fd_readdir — pack linux_dirent-ish entries. Each WASI dirent:
    //   d_next: u64 (cookie of next entry)
    //   d_ino:  u64
    //   d_namlen: u32
    //   d_type: u8 (filetype)
    // followed by name (no NUL).
    reg("fd_readdir", (fd, bufPtr, bufLen, cookie, sizePtr) => {
      const e = fdt.get(fd);
      if (!e || e.node.type !== "dir") return W.NOTDIR;
      if (!e._wasiDirents) {
        const entries = [...e.node.children.entries()];
        if (e.node.dynamic) {
          const seen = new Set(entries.map(([n]) => n));
          for (const name of e.node.dynamic.list()) {
            if (seen.has(name)) continue;
            const child = e.node.dynamic.lookup(name);
            if (child) entries.push([name, child]);
          }
        }
        e._wasiDirents = entries;
      }
      const dv = this._dv();
      const u8 = this._u8();
      let off = 0;
      let i = Number(cookie);
      while (i < e._wasiDirents.length) {
        const [name, child] = e._wasiDirents[i];
        const nameBytes = new TextEncoder().encode(name);
        const recLen = 24 + nameBytes.length;
        if (off + recLen > bufLen) break;
        dv.setBigUint64(bufPtr + off + 0,  BigInt(i + 1), true);   // d_next
        dv.setBigUint64(bufPtr + off + 8,  BigInt(child.ino), true);
        dv.setUint32   (bufPtr + off + 16, nameBytes.length, true);
        dv.setUint8    (bufPtr + off + 20, nodeFiletype(child));
        u8.set(nameBytes, bufPtr + off + 24);
        off += recLen;
        i++;
      }
      dv.setUint32(sizePtr, off, true);
      return W.SUCCESS;
    });

    // path_create_directory / path_unlink_file / path_rename / path_symlink /
    // path_readlink — minimal coverage so binaries that touch the fs don't
    // immediately blow up.
    reg("path_create_directory", (dirfd, pathPtr, pathLen) => {
      const abs = this._resolve(dirfd, this._readStr(pathPtr, pathLen));
      if (abs === null) return W.BADF;
      const r = k.vfs.mkdir(abs, 0o755);
      return r < 0 ? le2we(r) : W.SUCCESS;
    });
    reg("path_unlink_file", (dirfd, pathPtr, pathLen) => {
      const abs = this._resolve(dirfd, this._readStr(pathPtr, pathLen));
      if (abs === null) return W.BADF;
      const r = k.vfs.walk(abs, { parents: true, nofollow: true });
      if (r.err) return le2we(-r.err);
      if (!r.node || r.node.type === "dir") return W.ISDIR;
      r.parent.children.delete(r.name);
      return W.SUCCESS;
    });
    reg("path_remove_directory", (dirfd, pathPtr, pathLen) => {
      const abs = this._resolve(dirfd, this._readStr(pathPtr, pathLen));
      if (abs === null) return W.BADF;
      const r = k.vfs.walk(abs, { parents: true, nofollow: true });
      if (r.err) return le2we(-r.err);
      if (!r.node || r.node.type !== "dir") return W.NOTDIR;
      if (r.node.children.size > 0) return W.NOTEMPTY;
      r.parent.children.delete(r.name);
      return W.SUCCESS;
    });
    reg("path_readlink", (dirfd, pathPtr, pathLen, bufPtr, bufLen, sizePtr) => {
      const abs = this._resolve(dirfd, this._readStr(pathPtr, pathLen));
      if (abs === null) return W.BADF;
      const node = k.vfs.stat(abs, { nofollow: true });
      if (!node) return W.NOENT;
      if (node.type !== "symlink") return W.INVAL;
      const b = new TextEncoder().encode(node.link);
      const n = Math.min(bufLen, b.length);
      this._u8().set(b.subarray(0, n), bufPtr);
      this._dv().setUint32(sizePtr, n, true);
      return W.SUCCESS;
    });

    // poll_oneoff — bare minimum: handle CLOCK + FD_READ/FD_WRITE subscriptions
    // by polling once. Many WASI programs use it just for sleep().
    I.poll_oneoff = new Suspending(async (inPtr, outPtr, nsubs, neventsPtr) => {
      const dv = this._dv();
      // Subscription: u64 userdata | u8 tag | (variant payload)
      // We only handle: tag=0 (clock) and tag=1/2 (fd_read/fd_write).
      let nevents = 0;
      let earliestDeadlineMs = Infinity;
      const subs = [];
      for (let i = 0; i < nsubs; i++) {
        const base = inPtr + i * 48;
        const userdata = dv.getBigUint64(base, true);
        const tag = dv.getUint8(base + 8);
        if (tag === 0) {
          // clock: id(u32) timeout(u64) precision(u64) flags(u16)
          const timeout  = dv.getBigUint64(base + 24, true);
          const flags    = dv.getUint16(base + 40, true);
          const ms = Number(timeout / 1_000_000n);
          // flags bit 0 = ABSTIME (we approximate by treating as relative anyway)
          const deadline = Date.now() + (flags & 1 ? Math.max(0, ms - Date.now()) : ms);
          earliestDeadlineMs = Math.min(earliestDeadlineMs, deadline);
          subs.push({ kind: "clock", userdata });
        } else {
          // fd_read (1) / fd_write (2): fd(u32)
          const fd = dv.getUint32(base + 16, true);
          subs.push({ kind: tag === 1 ? "read" : "write", userdata, fd });
        }
      }
      // Poll loop: fire any ready fds, optionally sleep until clock deadline.
      const start = Date.now();
      while (true) {
        let off = 0;
        nevents = 0;
        for (const s of subs) {
          if (s.kind === "clock") continue;
          const e = fdt.get(s.fd);
          let ready = false;
          if (!e) {
            // Emit a BADF event.
            dv.setBigUint64(outPtr + off + 0,  s.userdata, true);
            dv.setUint16   (outPtr + off + 8,  W.BADF, true);
            dv.setUint8    (outPtr + off + 10, s.kind === "read" ? 1 : 2);
            off += 32;
            nevents++;
            continue;
          }
          if (e.node.special?.poll) {
            const events = s.kind === "read" ? 1 : 4;
            ready = (e.node.special.poll(events) & events) !== 0;
          } else {
            ready = true;
          }
          if (ready) {
            dv.setBigUint64(outPtr + off + 0,  s.userdata, true);
            dv.setUint16   (outPtr + off + 8,  W.SUCCESS, true);
            dv.setUint8    (outPtr + off + 10, s.kind === "read" ? 1 : 2);
            off += 32;
            nevents++;
          }
        }
        if (nevents > 0) {
          // Pad event records to spec size if needed — done implicitly.
          dv.setUint32(neventsPtr, nevents, true);
          return W.SUCCESS;
        }
        if (Date.now() >= earliestDeadlineMs) {
          // Fire clock event(s).
          off = 0;
          for (const s of subs) {
            if (s.kind !== "clock") continue;
            dv.setBigUint64(outPtr + off + 0,  s.userdata, true);
            dv.setUint16   (outPtr + off + 8,  W.SUCCESS, true);
            dv.setUint8    (outPtr + off + 10, 0);
            off += 32;
            nevents++;
          }
          dv.setUint32(neventsPtr, nevents, true);
          return W.SUCCESS;
        }
        await new Promise((r) => setTimeout(r, Math.min(50, Math.max(1, earliestDeadlineMs - Date.now()))));
        // Sanity cap so we never hang the isolate forever.
        if (Date.now() - start > 60000) {
          dv.setUint32(neventsPtr, 0, true);
          return W.SUCCESS;
        }
      }
    });

    // Stubs for less common calls — return NOSYS so binaries see a clean error
    // instead of crashing on missing import.
    for (const stub of [
      "fd_advise", "fd_allocate", "fd_datasync", "fd_sync", "fd_renumber",
      "fd_pread", "fd_pwrite", "fd_filestat_set_size", "fd_filestat_set_times",
      "path_filestat_set_times", "path_link", "path_rename", "path_symlink",
      "proc_raise", "sock_recv", "sock_send", "sock_shutdown", "sock_accept",
    ]) {
      reg(stub, () => W.NOSYS);
    }

    return { wasi_snapshot_preview1: I };
  }

  // ---- Internal: route reads/writes through the kernel's special-aware paths.
  async _writeFd(fd, buf, count) {
    const e = this.proc.fdt.get(fd);
    if (!e) return -LE.EBADF;
    if (e.node.special?.writeAsync) return await e.node.special.writeAsync(this._u8(), buf, count, e);
    return this.proc.kernel.sys_write(fd, buf, count);
  }
  async _readFd(fd, buf, count) {
    const e = this.proc.fdt.get(fd);
    if (!e) return -LE.EBADF;
    if (e.node.special?.readAsync) return await e.node.special.readAsync(this._u8(), buf, count, e);
    return this.proc.kernel.sys_read(fd, buf, count);
  }
}
