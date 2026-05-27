// @ts-nocheck — vendored from busyworker. Refresh procedure in VENDORED.md.
// Linux syscall dispatcher for wasm32 (asm-generic numbers).
//
// busybox.wasm calls __wasm_syscall_N(nr, ...args). We translate that into
// our in-process implementation of the Linux ABI.
//
// Conventions:
//   - Return 0 or positive on success.
//   - Return -errno (negative number) on failure.
//   - Pointers are u32 offsets into shared memory.

import * as E from "./errno.js";
import { O_RDONLY, O_WRONLY, O_RDWR, O_ACCMODE, O_CREAT, O_EXCL, O_TRUNC,
         O_APPEND, O_NONBLOCK, O_DIRECTORY, O_NOFOLLOW, O_CLOEXEC, FdTable } from "./fd.js";
import { Vfs } from "./vfs.js";
import { Pipe } from "./pipe.js";
import { createSocket, readSockaddrIn, writeSockaddrIn, AF_INET, SOCK_STREAM, SOCK_DGRAM } from "./socket.js";
import type { Tty } from "./tty.js";
import type { Proc, MachineRef, FdEntry, FsNode } from "./types.js";

// --- asm-generic syscall numbers (subset) ---
export const NR = {
  getcwd: 17,
  dup: 23,
  dup3: 24,
  fcntl: 25,
  ioctl: 29,
  mkdirat: 34,
  unlinkat: 35,
  renameat: 38,
  renameat2: 276,
  faccessat: 48,
  chdir: 49,
  openat: 56,
  close: 57,
  pipe2: 59,
  getdents64: 61,
  lseek: 62,
  read: 63,
  write: 64,
  readv: 65,
  writev: 66,
  ppoll: 73,
  readlinkat: 78,
  utimensat: 88,
  utimensat_time64: 412,
  newfstatat: 79,
  fstat: 80,
  exit: 93,
  exit_group: 94,
  waitid: 95,
  set_tid_address: 96,
  set_robust_list: 99,
  clock_gettime: 113,
  clock_nanosleep: 115,
  sched_yield: 124,
  kill: 129,
  tkill: 130,
  tgkill: 131,
  rt_sigaction: 134,
  rt_sigprocmask: 135,
  rt_sigreturn: 139,
  setpgid: 154,
  getpgid: 155,
  getsid: 156,
  setsid: 157,
  uname: 160,
  getrusage: 165,
  umask: 166,
  prctl: 167,
  gettimeofday: 169,
  getpid: 172,
  getppid: 173,
  getuid: 174,
  geteuid: 175,
  getgid: 176,
  getegid: 177,
  gettid: 178,
  sysinfo: 179,
  rseq: 213,
  brk: 214,
  munmap: 215,
  mremap: 216,
  clone: 220,
  execve: 221,
  mmap: 222,
  mprotect: 226,
  madvise: 233,
  wait4: 260,
  prlimit64: 261,
  getrandom: 278,
  statx: 291,
  clock_gettime64: 403,
  clock_nanosleep_time64: 407,
  ppoll_time64: 414,
  faccessat2: 439,
  // --- sockets (asm-generic) ---
  socket: 198,
  bind: 200,
  listen: 201,
  accept: 202,
  connect: 203,
  getsockname: 204,
  getpeername: 205,
  sendto: 206,
  recvfrom: 207,
  setsockopt: 208,
  getsockopt: 209,
  shutdown: 210,
  sendmsg: 211,
  recvmsg: 212,
  accept4: 242,
  // --- Custom syscalls (above any real Linux NR). Used by patched busybox. ---
  bb_spawn: 500,
  bb_wait:  501,
};

// Reverse name lookup for tracing
export const NR_NAME = Object.fromEntries(Object.entries(NR).map(([k,v]) => [v, k]));

// AT_FDCWD = -100 (the "current dir" sentinel)
export const AT_FDCWD = -100 >>> 0; // wasm32 passes as u32

export interface KernelOpts {
  vfs: Vfs;
  fdt: FdTable;
  tty: Tty;
  memory: WebAssembly.Memory | null;
  log: (s: string) => void;
  process?: Proc | null;
  machine?: MachineRef | null;
  traceSyscalls?: boolean;
}

export class Kernel {
  vfs: Vfs;
  fdt: FdTable;
  tty: Tty;
  memory: WebAssembly.Memory | null;
  log: (s: string) => void;
  trace: boolean;
  process: Proc | null;
  machine: MachineRef | null;
  pid: number;
  tid: number;
  ppid: number;
  cwd: string;
  umaskVal: number;
  brkEnd: number;
  brkMax: number;
  brkStart?: number;
  brkLimit?: number;
  mmapNext?: number;
  mmapLimit?: number;
  startTimeNs: bigint;
  exited: boolean;
  exitCode: number;
  instance: WebAssembly.Instance | null = null;
  cloneCallbackPromising: ((...args: any[]) => Promise<any>) | null = null;
  [k: string]: any;

  constructor({ vfs, fdt, tty, memory, log, process = null, machine = null, traceSyscalls = false }: KernelOpts) {
    this.vfs = vfs;
    this.fdt = fdt;
    this.tty = tty;
    this.memory = memory;
    this.log = log;
    this.trace = traceSyscalls;
    this.process = process;     // back-ref to owning Process
    this.machine = machine;     // back-ref to owning Machine (for spawn)
    this.pid = 1;
    this.tid = 1;
    this.ppid = 0;
    this.cwd = "/";             // per-process working directory
    this.umaskVal = 0o022;
    this.brkEnd = 0;
    this.brkMax = 0;
    this.startTimeNs = BigInt(Date.now()) * 1_000_000n;
    this.exited = false;
    this.exitCode = 0;
  }

  // ----- memory helpers -----
  u8() { return new Uint8Array(this.memory.buffer); }
  dv() { return new DataView(this.memory.buffer); }
  cstr(ptr) {
    const u = this.u8();
    let end = ptr;
    while (u[end]) end++;
    return new TextDecoder("utf-8").decode(u.slice(ptr, end));
  }
  writeCstr(ptr, s, maxlen) {
    const u = this.u8();
    const bytes = new TextEncoder().encode(s);
    const n = Math.min(bytes.length, maxlen - 1);
    for (let i = 0; i < n; i++) u[ptr + i] = bytes[i];
    u[ptr + n] = 0;
    return n;
  }

  // ----- path resolution with AT_FDCWD support -----
  resolvePath(dirfd, pathPtr) {
    let path = this.cstr(pathPtr);
    // Rewrite /proc/self → /proc/<this.pid> so each process sees its own info.
    if (path === "/proc/self" || path.startsWith("/proc/self/")) {
      path = "/proc/" + this.pid + path.slice("/proc/self".length);
    }
    if (path.startsWith("/")) return path;
    if (dirfd === AT_FDCWD || dirfd === -100) return this.cwd + (this.cwd.endsWith("/") ? "" : "/") + path;
    const e = this.fdt.get(dirfd);
    if (!e) return null;
    // AT_EMPTY_PATH: empty pathname → operate on the fd's own path.
    // (musl uses statx(fd, "", AT_EMPTY_PATH, …) as its fstat() fallback.)
    if (path === "") return e.path || "/";
    if (e.node.type !== "dir") return null;
    return (e.path || "/") + "/" + path;
  }

  // Walk `path` against the VFS, awaiting any dynamic-dir `preload()` hook
  // along the way. Used to give backends that need async I/O for metadata
  // (R2, network FS) a chance to populate their cache before the sync
  // walk that follows. Best-effort: errors are swallowed, the sync walk
  // surfaces them via the usual errno path.
  async preloadPath(path) {
    if (path === null || path === undefined) return;
    const abs = (typeof path === "string" && path.startsWith("/"))
      ? path
      : null;
    if (!abs) return;
    const parts = abs === "/" ? [] : abs.slice(1).split("/");
    let node = this.vfs.root;
    for (let i = 0; i < parts.length; i++) {
      if (!node || node.type !== "dir") return;
      if (node.dynamic && node.dynamic.preload) {
        try { await node.dynamic.preload(); } catch {}
      }
      const name = parts[i];
      let child = node.children && node.children.get(name);
      if (!child && node.dynamic) child = node.dynamic.lookup(name);
      if (!child) return;
      if (child.type === "symlink") return; // give up; sync walk handles links
      node = child;
    }
    // Also preload the final node if it's itself a dynamic dir (covers
    // `ls /mnt/r2` where the leaf is the dynamic dir).
    if (node && node.type === "dir" && node.dynamic && node.dynamic.preload) {
      try { await node.dynamic.preload(); } catch {}
    }
  }

  // Walk to the parent dir of `path` and return it only if it is a dynamic
  // dir (has a `.dynamic` ops bag). Used by mutation syscalls to decide
  // whether to delegate to a backend hook. Returns null if the path is "/",
  // the parent doesn't exist, or the parent isn't a dynamic dir.
  _dynamicParentFor(path) {
    if (!path || path === "/") return null;
    const slash = path.lastIndexOf("/");
    const parentPath = slash === 0 ? "/" : path.slice(0, slash);
    const node = this.vfs.stat(parentPath);
    if (!node || node.type !== "dir" || !node.dynamic) return null;
    return node;
  }

  // Async dispatcher: same as dispatch, but for syscalls that need to wait
  // (read on stdin, ppoll, clock_nanosleep) it awaits.
  async dispatchAsync(nr, a0=0, a1=0, a2=0, a3=0, a4=0, a5=0) {
    if (this.trace && (nr === NR.connect || nr === NR.sendto || nr === NR.recvfrom || nr === NR.sendmsg || nr === NR.recvmsg)) {
      this.log(`sc.a ${NR_NAME[nr] || nr}(${a0},${a1},${a2},${a3},${a4},${a5})`);
    }
    // Path-resolving syscalls: await any dynamic-dir preload hooks along
    // the path before the sync dispatch walks the VFS. This is what lets
    // R2-backed mounts populate their listing cache on first access.
    switch (nr) {
      case NR.openat:
      case NR.newfstatat:
      case NR.statx:
      case NR.faccessat:
      case NR.faccessat2:
      case NR.mkdirat:
      case NR.unlinkat:
      case NR.utimensat:
      case NR.utimensat_time64:
      case NR.readlinkat: {
        const path = this.resolvePath(a0, a1);
        if (path) await this.preloadPath(path);
        break;
      }
    }
    // dup3(oldfd, newfd, flags): if newfd was already open and its entry
    // has an async-close hook (e.g. r2fs PUT-on-close), the implicit close
    // of the displaced fd needs to await that hook. Without this, shell
    // redirection-restore (`exec 1<&saved`) silently drops pending writes.
    if (nr === NR.dup3) {
      const displaced = this.fdt.get(a1);
      const ca = displaced?.node?.special?.closeAsync;
      if (displaced && ca && a0 !== a1) {
        // Run the displaced fd's sync + async close BEFORE the dup, so
        // the post-close fdt no longer holds the entry the flush is
        // tied to. The subsequent fdt.dup2 will then install the new
        // mapping into a vacant slot.
        try { displaced.node?.special?.close?.(displaced); } catch {}
        try { await ca(displaced); } catch {}
        this.fdt.map.delete(a1);
      }
    }
    // close: after the sync close, await any backend flush hook so the
    // PUT lands before the syscall returns (callers rely on close()
    // serialising writes to durable storage — e.g. tests inspecting R2).
    if (nr === NR.close) {
      const e = this.fdt.get(a0);
      const closeAsync = e?.node?.special?.closeAsync;
      const ret = this.dispatch(nr, a0, a1, a2, a3, a4, a5);
      if (closeAsync) {
        try { await closeAsync(e); } catch {}
      }
      return ret;
    }
    // unlinkat / mkdirat: if the path's parent is a dynamic dir with an
    // async mutation hook, route through it; otherwise fall through to the
    // sync VFS path. preloadPath above already populated the parent listing.
    // openat with O_CREAT under a dynamic dir: ask the backend to mint the
    // node (and splice it into parent.children) before we fall through to
    // sync sys_openat. Without this, sys_openat's own O_CREAT path would
    // call vfs.writeFile which creates a plain in-memory node that never
    // gets flushed back to R2.
    if (nr === NR.openat && (a2 & O_CREAT)) {
      const path = this.resolvePath(a0, a1);
      if (path) {
        const r = this.vfs.walk(path, { nofollow: (a2 & O_NOFOLLOW) !== 0 });
        if (r.err === E.ENOENT) {
          const parent = this._dynamicParentFor(path);
          if (parent) {
            if (!parent.dynamic.createAsync) return -E.EROFS;
            const name = path.slice(path.lastIndexOf("/") + 1);
            const result = await parent.dynamic.createAsync(name, a3 & ~this.umaskVal);
            if (typeof result === "number") return result;
            // createAsync attached the node to parent.children; sync
            // sys_openat below will find it via the normal walk.
          }
        }
      }
    }

    // Mutations on dynamic dirs:
    //   - If the parent dir is dynamic AND exposes the matching async hook,
    //     delegate to it.
    //   - If the parent is dynamic but the hook is absent (read-only
    //     backend), return -EROFS — the sync fallback would silently
    //     succeed because dynamic-dir mutations aren't reflected in the
    //     static children map.
    //   - Otherwise, fall through to the sync sys_* path.
    if (nr === NR.unlinkat) {
      const AT_REMOVEDIR = 0x200;
      const path = this.resolvePath(a0, a1);
      if (path) {
        const parent = this._dynamicParentFor(path);
        if (parent) {
          const name = path.slice(path.lastIndexOf("/") + 1);
          const hook = (a2 & AT_REMOVEDIR) ? parent.dynamic.rmdirAsync : parent.dynamic.unlinkAsync;
          if (hook) return await hook(name);
          return -E.EROFS;
        }
      }
    }
    // renameat / renameat2(olddirfd, oldpath, newdirfd, newpath[, flags]):
    // For same-dynamic-dir renames (or cross-dir under the same backend),
    // delegate to the parent's renameAsync hook. Cross-backend renames
    // surface as EXDEV so userspace falls back to copy + unlink.
    if (nr === NR.renameat || nr === NR.renameat2) {
      const oldPath = this.resolvePath(a0, a1);
      const newPath = this.resolvePath(a2, a3);
      if (oldPath && newPath) {
        await this.preloadPath(oldPath);
        await this.preloadPath(newPath);
        const oldParent = this._dynamicParentFor(oldPath);
        const newParent = this._dynamicParentFor(newPath);
        if (oldParent || newParent) {
          if (!oldParent || !newParent) return -E.EXDEV;
          const hook = oldParent.dynamic.renameAsync;
          if (!hook) return -E.EROFS;
          const oldName = oldPath.slice(oldPath.lastIndexOf("/") + 1);
          const newName = newPath.slice(newPath.lastIndexOf("/") + 1);
          return await hook(oldName, newParent, newName);
        }
      }
    }
    if (nr === NR.mkdirat) {
      const path = this.resolvePath(a0, a1);
      if (path) {
        const parent = this._dynamicParentFor(path);
        if (parent) {
          if (parent.dynamic.mkdirAsync) {
            const name = path.slice(path.lastIndexOf("/") + 1);
            return await parent.dynamic.mkdirAsync(name, a2 & ~this.umaskVal);
          }
          return -E.EROFS;
        }
      }
    }
    // getdents on an open dir fd: preload that dir before enumeration.
    if (nr === NR.getdents64) {
      const e = this.fdt.get(a0);
      if (e && e.node.type === "dir" && e.node.dynamic && e.node.dynamic.preload) {
        try { await e.node.dynamic.preload(); } catch {}
      }
    }
    if (nr === NR.read) {
      const e = this.fdt.get(a0);
      if (e && e.node.special && e.node.special.readAsync) {
        if (this.trace) this.log(`sc read(${a0},${a1},${a2}) [async]`);
        return await e.node.special.readAsync(this.u8(), a1, a2, e);
      }
    }
    if (nr === NR.write) {
      const e = this.fdt.get(a0);
      if (e && e.node.special && e.node.special.writeAsync) {
        return await e.node.special.writeAsync(this.u8(), a1, a2, e);
      }
    }
    // readv/writev against an fd with an async-only special must be awaited
    // per-iovec — falling through to the sync sys_readv would call a missing
    // `read` and crash. (Used by R2-backed files, which have no sync I/O.)
    if (nr === NR.readv) {
      const e = this.fdt.get(a0);
      if (e && e.node.special && e.node.special.readAsync && !e.node.special.read) {
        const dv = this.dv();
        let total = 0;
        for (let i = 0; i < a2; i++) {
          const base = a1 + i * 8;
          const ptr = dv.getUint32(base, true);
          const len = dv.getUint32(base + 4, true);
          const r = await e.node.special.readAsync(this.u8(), ptr, len, e);
          if (r < 0) return total > 0 ? total : r;
          total += r;
          if (r < len) break;
        }
        return total;
      }
    }
    if (nr === NR.writev) {
      const e = this.fdt.get(a0);
      if (e && e.node.special && e.node.special.writeAsync && !e.node.special.write) {
        const dv = this.dv();
        let total = 0;
        for (let i = 0; i < a2; i++) {
          const base = a1 + i * 8;
          const ptr = dv.getUint32(base, true);
          const len = dv.getUint32(base + 4, true);
          const r = await e.node.special.writeAsync(this.u8(), ptr, len, e);
          if (r < 0) return total > 0 ? total : r;
          total += r;
          if (r < len) break;
        }
        return total;
      }
    }
    if (nr === NR.ppoll || nr === NR.ppoll_time64) {
      // Wait until any monitored fd has data, or timeout.
      return await this.sys_ppoll_async(a0, a1, a2, a3);
    }
    if (nr === NR.bb_spawn)  return await this.sys_bb_spawn(a0, a1, a2, a3);
    if (nr === NR.bb_wait)   return await this.sys_bb_wait(a0, a1, a2);
    if (nr === NR.wait4)     return await this.sys_wait4(a0, a1, a2, a3);
    if (nr === NR.waitid)    return await this.sys_waitid(a0, a1, a2, a3);
    if (nr === NR.clone)     return await this.sys_clone(a0, a1, a2, a3, a4);
    if (nr === NR.execve)    return await this.sys_execve(a0, a1, a2);
    if (nr === NR.connect)   return await this.sys_connect(a0, a1, a2);
    if (nr === NR.sendto)    return await this.sys_sendto(a0, a1, a2, a3, a4, a5);
    if (nr === NR.recvfrom)  return await this.sys_recvfrom(a0, a1, a2, a3, a4, a5);
    if (nr === NR.sendmsg)   return await this.sys_sendmsg(a0, a1, a2);
    if (nr === NR.recvmsg)   return await this.sys_recvmsg(a0, a1, a2);
    if (nr === NR.clock_nanosleep || nr === NR.clock_nanosleep_time64) {
      const dv = this.dv();
      const sec = Number(dv.getBigInt64(a2, true));
      const nsec = Number(dv.getBigInt64(a2 + 8, true));
      const ms = sec * 1000 + nsec / 1e6;
      await new Promise((r) => setTimeout(r, Math.min(ms, 60000)));
      return 0;
    }
    return this.dispatch(nr, a0, a1, a2, a3, a4, a5);
  }

  // ----- dispatcher -----
  dispatch(nr, a0=0, a1=0, a2=0, a3=0, a4=0, a5=0) {
    if (this.trace) this.log(`sc ${NR_NAME[nr] || nr}(${a0},${a1},${a2},${a3},${a4},${a5})`);
    try {
      switch (nr) {
        case NR.read:           return this.sys_read(a0, a1, a2);
        case NR.write:          return this.sys_write(a0, a1, a2);
        case NR.writev:         return this.sys_writev(a0, a1, a2);
        case NR.readv:          return this.sys_readv(a0, a1, a2);
        case NR.close:          return this.sys_close(a0);
        case NR.openat:         return this.sys_openat(a0, a1, a2, a3);
        case NR.ioctl:          return this.sys_ioctl(a0, a1, a2);
        case NR.fcntl:          return this.sys_fcntl(a0, a1, a2);
        case NR.lseek:          return this.sys_llseek(a0, a1, a2, a3, a4);
        case NR.brk:            return this.sys_brk(a0);
        case NR.mmap:           return this.sys_mmap(a0, a1, a2, a3, a4, a5);
        case NR.munmap:         return this.sys_munmap(a0, a1);
        case NR.mprotect:       return 0;
        case NR.madvise:        return 0;
        case NR.set_tid_address:return this.tid;
        case NR.set_robust_list:return 0;
        case NR.rseq:           return -E.ENOSYS;
        case NR.getpid:         return this.pid;
        case NR.gettid:         return this.tid;
        case NR.getppid:        return this.ppid;
        case NR.getpgid:        return this.pid;  // single-process: pgid == pid
        case NR.getsid:         return this.pid;
        case NR.setpgid:        return 0;
        case NR.setsid:         return this.pid;
        case NR.dup:            return this.fdt.dup(a0);
        case NR.dup3:           return this.fdt.dup2(a0, a1);
        case NR.getuid:
        case NR.geteuid:
        case NR.getgid:
        case NR.getegid:        return 0;
        case NR.umask:          { const old = this.umaskVal; this.umaskVal = a0 & 0o777; return old; }
        case NR.uname:          return this.sys_uname(a0);
        case NR.getrandom:      return this.sys_getrandom(a0, a1, a2);
        case NR.clock_gettime:
        case NR.clock_gettime64:return this.sys_clock_gettime(a0, a1, nr === NR.clock_gettime64);
        case NR.gettimeofday:   return this.sys_gettimeofday(a0, a1);
        case NR.prlimit64:      return this.sys_prlimit64(a0, a1, a2, a3);
        case NR.rt_sigaction:   return 0;
        case NR.rt_sigprocmask: return 0;
        case NR.rt_sigreturn:   return 0;
        case NR.tgkill:
        case NR.tkill:
        case NR.kill:           return 0;  // ignore signals for now
        case NR.exit:
        case NR.exit_group:     this.exited = true; this.exitCode = a0 & 0xff; throw new ExitTrap(this.exitCode);
        case NR.mkdirat:        return this.sys_mkdirat(a0, a1, a2);
        case NR.unlinkat:       return this.sys_unlinkat(a0, a1, a2);
        case NR.utimensat:
        case NR.utimensat_time64: return this.sys_utimensat(a0, a1);
        case NR.faccessat:
        case NR.faccessat2:     return this.sys_faccessat(a0, a1, a2, a3);
        case NR.newfstatat:     return this.sys_newfstatat(a0, a1, a2, a3);
        case NR.fstat:          return this.sys_fstat(a0, a1);
        case NR.statx:          return this.sys_statx(a0, a1, a2, a3, a4);
        case NR.readlinkat:     return this.sys_readlinkat(a0, a1, a2, a3);
        case NR.getcwd:         return this.sys_getcwd(a0, a1);
        case NR.chdir:          return this.sys_chdir(a0);
        case NR.getdents64:     return this.sys_getdents64(a0, a1, a2);
        case NR.sched_yield:    return 0;
        case NR.sysinfo:        return this.sys_sysinfo(a0);
        case NR.prctl:          return -E.EINVAL;
        case NR.ppoll:
        case NR.ppoll_time64:   return this.sys_ppoll(a0, a1, a2, a3);
        case NR.clock_nanosleep:
        case NR.clock_nanosleep_time64: return 0;  // pretend slept
        case NR.getrusage:      return this.sys_getrusage(a0, a1);
        case NR.wait4:          // handled in dispatchAsync
        case NR.waitid:         return -E.EAGAIN;  // handled in dispatchAsync
        case NR.bb_spawn:       // handled in dispatchAsync
        case NR.bb_wait:        return -E.EAGAIN;  // never reached (async path)
        case NR.clone:          // handled in dispatchAsync
        case NR.execve:         return -E.EAGAIN;  // never reached
        case NR.pipe2:          return this.sys_pipe2(a0, a1);
        case NR.socket:         return this.sys_socket(a0, a1, a2);
        case NR.bind:           return this.sys_bind(a0, a1, a2);
        case NR.listen:         return -E.EOPNOTSUPP;
        case NR.accept:
        case NR.accept4:        return -E.EOPNOTSUPP;
        case NR.getsockname:    return this.sys_getsockname(a0, a1, a2);
        case NR.getpeername:    return this.sys_getpeername(a0, a1, a2);
        case NR.setsockopt:     return 0;   // accept any option silently
        case NR.getsockopt:     return this.sys_getsockopt(a0, a1, a2, a3, a4);
        case NR.shutdown:       return this.sys_shutdown(a0, a1);
        case NR.connect:        // handled in dispatchAsync
        case NR.sendto:
        case NR.recvfrom:
        case NR.sendmsg:
        case NR.recvmsg:        return -E.EAGAIN;  // never reached
        default:
          this.log(`unimplemented syscall ${NR_NAME[nr] || nr} (${nr})`);
          return -E.ENOSYS;
      }
    } catch (e: any) {
      if (e instanceof ExitTrap) throw e;
      this.log(`syscall ${NR_NAME[nr] || nr} threw: ${e.message}`);
      return -E.EINVAL;
    }
  }

  // ====================================================
  // Individual syscalls
  // ====================================================

  sys_read(fd, buf, count) {
    const e = this.fdt.get(fd);
    if (!e) return -E.EBADF;
    if (e.node.special) {
      if (!e.node.special.read) return -E.EAGAIN;  // async-only fd hit a sync path
      return e.node.special.read(this.u8(), buf, count, e);
    }
    if (e.node.type === "reg") {
      const n = Math.min(count, e.node.data.length - e.offset);
      if (n <= 0) return 0;
      this.u8().set(e.node.data.subarray(e.offset, e.offset + n), buf);
      e.offset += n;
      return n;
    }
    if (e.node.type === "dir") return -E.EISDIR;
    return -E.EINVAL;
  }

  sys_write(fd, buf, count) {
    const e = this.fdt.get(fd);
    if (!e) return -E.EBADF;
    if (e.node.special) {
      if (!e.node.special.write) return -E.EAGAIN;
      return e.node.special.write(this.u8(), buf, count, e);
    }
    if (e.node.type === "reg") {
      // O_APPEND: atomically seek to end before each write.
      if (e.flags & O_APPEND) e.offset = e.node.data.length;
      // grow file if needed
      const end = e.offset + count;
      if (end > e.node.data.length) {
        const grown = new Uint8Array(end);
        grown.set(e.node.data);
        e.node.data = grown;
      }
      e.node.data.set(this.u8().subarray(buf, buf + count), e.offset);
      e.offset = end;
      return count;
    }
    return -E.EINVAL;
  }

  sys_writev(fd, iov, iovcnt) {
    const dv = this.dv();
    let total = 0;
    for (let i = 0; i < iovcnt; i++) {
      const base = iov + i * 8;
      const ptr = dv.getUint32(base, true);
      const len = dv.getUint32(base + 4, true);
      const r = this.sys_write(fd, ptr, len);
      if (r < 0) return total > 0 ? total : r;
      total += r;
      if (r < len) break;
    }
    return total;
  }

  sys_readv(fd, iov, iovcnt) {
    const dv = this.dv();
    let total = 0;
    for (let i = 0; i < iovcnt; i++) {
      const base = iov + i * 8;
      const ptr = dv.getUint32(base, true);
      const len = dv.getUint32(base + 4, true);
      const r = this.sys_read(fd, ptr, len);
      if (r < 0) return total > 0 ? total : r;
      total += r;
      if (r < len) break;
    }
    return total;
  }

  sys_close(fd) { return this.fdt.close(fd); }

  sys_openat(dirfd, pathPtr, flags, mode) {
    const path = this.resolvePath(dirfd, pathPtr);
    if (path === null) return -E.EBADF;
    let r = this.vfs.walk(path, { nofollow: (flags & O_NOFOLLOW) !== 0 });
    if (r.err === E.ENOENT && (flags & O_CREAT)) {
      this.vfs.writeFile(path, new Uint8Array(0), mode & ~this.umaskVal);
      r = this.vfs.walk(path);
    }
    if (r.err) return -r.err;
    if (r.node.type === "dir" && (flags & O_ACCMODE) !== O_RDONLY) return -E.EISDIR;
    if ((flags & O_DIRECTORY) && r.node.type !== "dir") return -E.ENOTDIR;
    if ((flags & O_TRUNC) && r.node.type === "reg") r.node.data = new Uint8Array(0);
    const entry = { node: r.node, flags, offset: 0, path };
    return this.fdt.alloc(entry);
  }

  sys_mkdirat(dirfd, pathPtr, mode) {
    const path = this.resolvePath(dirfd, pathPtr);
    if (path === null) return -E.EBADF;
    return this.vfs.mkdir(path, mode & ~this.umaskVal);
  }

  // We don't track atime/mtime, but we still need to honor utimensat's
  // existence check so callers like `touch` fall through to open(O_CREAT)
  // when the path doesn't exist.
  sys_utimensat(dirfd, pathPtr) {
    // pathPtr == 0 → operate on dirfd itself (futimens). Always succeed.
    if (pathPtr === 0) return this.fdt.get(dirfd) ? 0 : -E.EBADF;
    const path = this.resolvePath(dirfd, pathPtr);
    if (path === null) return -E.EBADF;
    return this.vfs.stat(path) ? 0 : -E.ENOENT;
  }

  sys_unlinkat(dirfd, pathPtr, flags) {
    const AT_REMOVEDIR = 0x200;
    const path = this.resolvePath(dirfd, pathPtr);
    if (path === null) return -E.EBADF;
    return (flags & AT_REMOVEDIR) ? this.vfs.rmdir(path) : this.vfs.unlink(path);
  }

  sys_ioctl(fd, req, arg) {
    const e = this.fdt.get(fd);
    if (!e) return -E.EBADF;
    if (e.node.special && e.node.special.ioctl) return e.node.special.ioctl(this.u8(), this.dv(), req, arg);
    return -E.ENOTTY;
  }

  sys_fcntl(fd, cmd, arg) {
    const e = this.fdt.get(fd);
    if (!e) return -E.EBADF;
    const F_DUPFD = 0, F_GETFD = 1, F_SETFD = 2, F_GETFL = 3, F_SETFL = 4, F_DUPFD_CLOEXEC = 1030;
    switch (cmd) {
      case F_DUPFD:           return this.fdt.dup(fd, arg);
      case F_DUPFD_CLOEXEC:   return this.fdt.dup(fd, arg);
      case F_GETFD:           return e.cloexec ? 1 : 0;
      case F_SETFD:           e.cloexec = !!(arg & 1); return 0;
      case F_GETFL:           return e.flags;
      case F_SETFL:           e.flags = arg; return 0;
      default:                return -E.EINVAL;
    }
  }

  // wasm32 llseek-style: (fd, offset_hi, offset_lo, result_ptr, whence)
  // Writes 64-bit new offset to *result_ptr and returns 0 on success.
  sys_llseek(fd, offHi, offLo, resultPtr, whence) {
    const e = this.fdt.get(fd);
    if (!e) return -E.EBADF;
    if (e.node.type !== "reg") return -E.ESPIPE;
    const offset = Number(BigInt.asIntN(64, (BigInt(offHi) << 32n) | BigInt(offLo >>> 0)));
    let newOff;
    if (whence === 0) newOff = offset;
    else if (whence === 1) newOff = e.offset + offset;
    else if (whence === 2) newOff = e.node.data.length + offset;
    else return -E.EINVAL;
    if (newOff < 0) return -E.EINVAL;
    e.offset = newOff;
    if (resultPtr) this.dv().setBigInt64(resultPtr, BigInt(newOff), true);
    return 0;
  }

  ensurePages(highWaterMark) {
    const curPages = this.memory.buffer.byteLength >> 16;
    const needPages = (highWaterMark + 0xFFFF) >> 16;
    if (needPages > curPages) {
      try { this.memory.grow(needPages - curPages); }
      catch (e) { return false; }
    }
    return true;
  }

  sys_brk(newBrk) {
    if (newBrk === 0) return this.brkEnd;
    if (newBrk < this.brkStart || newBrk > this.brkLimit) return this.brkEnd;
    if (!this.ensurePages(newBrk)) return this.brkEnd;
    this.brkEnd = newBrk;
    return this.brkEnd;
  }

  // Anonymous mmap: bump-allocate from mmapNext upward.
  sys_mmap(addr, length, prot, flags, fd, offset) {
    const MAP_ANON = 0x20;
    if (!(flags & MAP_ANON)) return -E.ENOSYS;
    length = (length + 0xFFF) & ~0xFFF;
    const r = this.mmapNext;
    const end = r + length;
    if (end > this.mmapLimit) return -E.ENOMEM;
    if (!this.ensurePages(end)) return -E.ENOMEM;
    this.mmapNext = end;
    this.u8().fill(0, r, end);
    return r;
  }

  sys_munmap(_addr, _length) { return 0; }

  sys_uname(buf) {
    // struct utsname: 6 fields of 65 bytes each = 390 bytes
    const fields = ["Linux", "linuxwasm", "0.0.1-wasm", "#1 wasm", "wasm32", "(none)"];
    for (let i = 0; i < 6; i++) this.writeCstr(buf + i * 65, fields[i], 65);
    return 0;
  }

  sys_getrandom(buf, count, _flags) {
    const arr = new Uint8Array(count);
    crypto.getRandomValues(arr);
    this.u8().set(arr, buf);
    return count;
  }

  sys_clock_gettime(clk, tsPtr, time64) {
    const nowMs = Date.now();
    const sec = BigInt(Math.floor(nowMs / 1000));
    const nsec = BigInt((nowMs % 1000) * 1_000_000);
    const dv = this.dv();
    if (time64) {
      dv.setBigInt64(tsPtr, sec, true);
      dv.setBigInt64(tsPtr + 8, nsec, true);
    } else {
      // 32-bit time_t: struct timespec64 on wasm32 uses 8-byte tv_sec, 4-byte tv_nsec with padding => still 16 bytes.
      // We'll emit the same time64 layout since wasm32 uses 64-bit time_t in modern musl.
      dv.setBigInt64(tsPtr, sec, true);
      dv.setBigInt64(tsPtr + 8, nsec, true);
    }
    return 0;
  }

  sys_gettimeofday(tvPtr, _tzPtr) {
    const dv = this.dv();
    const nowMs = Date.now();
    dv.setBigInt64(tvPtr, BigInt(Math.floor(nowMs / 1000)), true);
    dv.setUint32(tvPtr + 8, (nowMs % 1000) * 1000, true);
    return 0;
  }

  sys_prlimit64(_pid, _resource, _newPtr, oldPtr) {
    if (oldPtr) {
      const dv = this.dv();
      dv.setBigUint64(oldPtr, BigInt(8 * 1024 * 1024), true);   // rlim_cur = 8M
      dv.setBigUint64(oldPtr + 8, BigInt(-1n & 0xFFFFFFFFFFFFFFFFn), true); // rlim_max = unlimited
    }
    return 0;
  }

  sys_faccessat(dirfd, pathPtr, _mode, _flags) {
    const path = this.resolvePath(dirfd, pathPtr);
    if (path === null) return -E.EBADF;
    const node = this.vfs.stat(path);
    return node ? 0 : -E.ENOENT;
  }

  // struct stat (Linux generic 64-bit, wasm32 layout):
  //   dev(8) ino(8) mode(4) nlink(4) uid(4) gid(4) rdev(8) size(8) blksize(4) blocks(8) atime(16) mtime(16) ctime(16)
  // Total 128. The actual layout depends on the arch's <asm/stat.h>; wasm uses a custom one.
  writeStat(buf, node) {
    const dv = this.dv();
    // We use a "stat64-like" layout matching what asm-generic typically yields:
    dv.setBigUint64(buf + 0, BigInt(1), true);             // dev
    dv.setBigUint64(buf + 8, BigInt(node.ino), true);      // ino
    dv.setUint32(buf + 16, node.mode, true);               // mode
    dv.setUint32(buf + 20, 1, true);                       // nlink
    dv.setUint32(buf + 24, node.uid, true);                // uid
    dv.setUint32(buf + 28, node.gid, true);                // gid
    dv.setBigUint64(buf + 32, BigInt(0), true);            // rdev
    const size = node.type === "reg" ? (node.size ?? node.data?.length ?? 0) : node.type === "symlink" ? node.link.length : 0;
    dv.setBigInt64(buf + 40, BigInt(size), true);          // size
    dv.setUint32(buf + 48, 4096, true);                    // blksize
    dv.setBigInt64(buf + 56, BigInt(Math.ceil(size / 512)), true); // blocks
    const t = BigInt(node.mtime || 0);
    dv.setBigInt64(buf + 64, t, true); dv.setBigInt64(buf + 72, 0n, true);
    dv.setBigInt64(buf + 80, t, true); dv.setBigInt64(buf + 88, 0n, true);
    dv.setBigInt64(buf + 96, t, true); dv.setBigInt64(buf + 104, 0n, true);
  }

  sys_newfstatat(dirfd, pathPtr, statbuf, flags) {
    const AT_SYMLINK_NOFOLLOW = 0x100;
    const path = this.resolvePath(dirfd, pathPtr);
    if (path === null) return -E.EBADF;
    const node = this.vfs.stat(path, { nofollow: !!(flags & AT_SYMLINK_NOFOLLOW) });
    if (!node) return -E.ENOENT;
    this.writeStat(statbuf, node);
    return 0;
  }

  sys_fstat(fd, statbuf) {
    const e = this.fdt.get(fd);
    if (!e) return -E.EBADF;
    this.writeStat(statbuf, e.node);
    return 0;
  }

  sys_statx(dirfd, pathPtr, _flags, _mask, statxbuf) {
    const path = this.resolvePath(dirfd, pathPtr);
    if (path === null) return -E.EBADF;
    const node = this.vfs.stat(path);
    if (!node) return -E.ENOENT;
    // struct statx: 0x100 bytes; we fill minimum fields.
    const dv = this.dv();
    this.u8().fill(0, statxbuf, statxbuf + 0x100);
    dv.setUint32(statxbuf + 0, 0x7FF, true);                  // stx_mask
    dv.setUint32(statxbuf + 4, 4096, true);                   // stx_blksize
    dv.setUint16(statxbuf + 12, 1, true);                     // stx_nlink (offset varies by arch — approximate)
    dv.setUint16(statxbuf + 28, node.mode, true);             // stx_mode
    dv.setBigUint64(statxbuf + 32, BigInt(node.ino), true);   // stx_ino
    const size = node.type === "reg" ? (node.size ?? node.data?.length ?? 0) : 0;
    dv.setBigUint64(statxbuf + 40, BigInt(size), true);       // stx_size
    return 0;
  }

  sys_readlinkat(dirfd, pathPtr, buf, bufsize) {
    const path = this.resolvePath(dirfd, pathPtr);
    if (path === null) return -E.EBADF;
    const node = this.vfs.stat(path, { nofollow: true });
    if (!node) return -E.ENOENT;
    if (node.type !== "symlink") return -E.EINVAL;
    const link = new TextEncoder().encode(node.link);
    const n = Math.min(bufsize, link.length);
    this.u8().set(link.subarray(0, n), buf);
    return n;
  }

  sys_getcwd(buf, size) {
    const cwd = this.cwd;
    const bytes = new TextEncoder().encode(cwd);
    if (bytes.length + 1 > size) return -E.ERANGE;
    this.u8().set(bytes, buf);
    this.u8()[buf + bytes.length] = 0;
    return bytes.length + 1;
  }

  sys_chdir(pathPtr) {
    const path = Vfs.normalize(this.cstr(pathPtr), this.cwd);
    const node = this.vfs.stat(path);
    if (!node) return -E.ENOENT;
    if (node.type !== "dir") return -E.ENOTDIR;
    this.cwd = path;
    return 0;
  }

  sys_getdents64(fd, buf, count) {
    const e = this.fdt.get(fd);
    if (!e) return -E.EBADF;
    if (e.node.type !== "dir") return -E.ENOTDIR;
    if (!e.dirsIter) {
      const entries = [...e.node.children.entries()];
      if (e.node.dynamic) {
        const seen = new Set(entries.map(([n]) => n));
        for (const name of e.node.dynamic.list()) {
          if (seen.has(name)) continue;
          const child = e.node.dynamic.lookup(name);
          if (child) entries.push([name, child]);
        }
      }
      e.dirsIter = entries;
      e.dirsIdx = 0;
    }
    const dv = this.dv();
    const u = this.u8();
    let off = 0;
    while (e.dirsIdx < e.dirsIter.length) {
      const [name, child] = e.dirsIter[e.dirsIdx];
      const nameBytes = new TextEncoder().encode(name);
      // struct linux_dirent64 { u64 ino; s64 off; u16 reclen; u8 type; char name[]; }
      const reclen = (8 + 8 + 2 + 1 + nameBytes.length + 1 + 7) & ~7;
      if (off + reclen > count) break;
      dv.setBigUint64(buf + off + 0, BigInt(child.ino), true);
      dv.setBigInt64(buf + off + 8, BigInt(e.dirsIdx + 1), true);
      dv.setUint16(buf + off + 16, reclen, true);
      const dtype = child.type === "dir" ? 4 : child.type === "reg" ? 8 : child.type === "symlink" ? 10 : 0;
      u[buf + off + 18] = dtype;
      u.set(nameBytes, buf + off + 19);
      u[buf + off + 19 + nameBytes.length] = 0;
      off += reclen;
      e.dirsIdx++;
    }
    return off;
  }

  sys_sysinfo(infoPtr) {
    const dv = this.dv();
    this.u8().fill(0, infoPtr, infoPtr + 64);
    const uptimeSec = Math.floor((Number(BigInt(Date.now()) * 1_000_000n - this.startTimeNs) / 1e9));
    dv.setBigInt64(infoPtr + 0, BigInt(uptimeSec), true);
    return 0;
  }

  async sys_ppoll_async(fdsPtr, nfds, tsPtr, _sigmaskPtr) {
    // Compute timeout in ms (or -1 for infinite)
    let timeoutMs = -1;
    if (tsPtr) {
      const dv = this.dv();
      const sec = Number(dv.getBigInt64(tsPtr, true));
      const nsec = Number(dv.getBigInt64(tsPtr + 8, true));
      timeoutMs = sec * 1000 + nsec / 1e6;
    }
    const deadline = timeoutMs < 0 ? Infinity : Date.now() + timeoutMs;
    while (true) {
      const r = this.sys_ppoll(fdsPtr, nfds, tsPtr, _sigmaskPtr);
      if (r > 0) return r;
      if (Date.now() >= deadline) return 0;
      // Wait briefly for input to arrive, then re-check.
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  sys_ppoll(fdsPtr, nfds, _tsPtr, _sigmaskPtr) {
    // Single-process: never any signals; report stdin readable if data available.
    const dv = this.dv();
    let ready = 0;
    for (let i = 0; i < nfds; i++) {
      const fd = dv.getInt32(fdsPtr + i * 8, true);
      const events = dv.getInt16(fdsPtr + i * 8 + 4, true);
      let revents = 0;
      const e = this.fdt.get(fd);
      if (!e) revents = 0x20; // POLLNVAL
      else if (e.node.special && e.node.special.poll) {
        revents = e.node.special.poll(events);
      } else {
        revents = events & 0x5;  // POLLIN|POLLOUT
      }
      dv.setInt16(fdsPtr + i * 8 + 6, revents, true);
      if (revents) ready++;
    }
    return ready;
  }

  sys_getrusage(_who, ru) {
    this.u8().fill(0, ru, ru + 144);
    return 0;
  }

  sys_pipe2(fdsPtr, _flags) {
    const pipe = new Pipe();
    const rNode: FsNode = { type: "char", mode: 0o010600, ino: 0, uid: 0, gid: 0, mtime: 0, special: pipe.readEnd() };
    const wNode: FsNode = { type: "char", mode: 0o010600, ino: 0, uid: 0, gid: 0, mtime: 0, special: pipe.writeEnd() };
    const rFd = this.fdt.alloc({ node: rNode, flags: 0, offset: 0, path: "<pipe:r>" });
    const wFd = this.fdt.alloc({ node: wNode, flags: 1, offset: 0, path: "<pipe:w>" });
    const dv = this.dv();
    dv.setInt32(fdsPtr, rFd, true);
    dv.setInt32(fdsPtr + 4, wFd, true);
    return 0;
  }

  // ---- Custom: __bb_spawn(path, argv, envp, fd_actions) -> pid ----
  //
  // argv/envp: NULL-terminated arrays of char*.
  // fd_actions: NULL-terminated array of u32 triples (type, a, b):
  //     type=1: dup2(a, b)
  //     type=2: close(a)
  //     type=0: end-of-list.
  // Returns child pid (>0) on success, -errno on failure.
  // The child runs concurrently with the parent (via JSPI). Use bb_wait or wait4.
  async sys_bb_spawn(pathPtr, argvPtr, envpPtr, fdActionsPtr) {
    const machine = this.machine;
    if (!machine) return -E.ENOSYS;
    const path = this.cstr(pathPtr);
    const argv = this.readStringVec(argvPtr);
    const envp = envpPtr ? this.readStringVec(envpPtr) : [];

    // Clone the current process's fd entries (shallow), then apply fd_actions.
    const fdEntries = new Map();
    for (const [fd, e] of this.fdt.map) fdEntries.set(fd, { ...e });
    // Bump refcounts on pipe ends being inherited
    for (const [, e] of fdEntries) {
      if (e.node?.special?.inherit) e.node.special.inherit(e);
    }

    if (fdActionsPtr) {
      const dv = this.dv();
      let p = fdActionsPtr;
      while (true) {
        const t = dv.getUint32(p, true);
        if (t === 0) break;
        const a = dv.getInt32(p + 4, true);
        const b = dv.getInt32(p + 8, true);
        p += 12;
        if (t === 1) {
          // dup2(a, b)
          const src = fdEntries.get(a);
          if (!src) continue;
          if (fdEntries.has(b)) {
            const old = fdEntries.get(b);
            if (old.node?.special?.close) old.node.special.close(old);
            fdEntries.delete(b);
          }
          const dup = { ...src };
          if (dup.node?.special?.inherit) dup.node.special.inherit(dup);
          fdEntries.set(b, dup);
        } else if (t === 2) {
          // close(a)
          const ent = fdEntries.get(a);
          if (ent?.node?.special?.close) ent.node.special.close(ent);
          fdEntries.delete(a);
        }
      }
    }

    const proc = machine.spawn({
      argv: argv.length ? argv : [path],
      envp: envp.length ? envp : ["HOME=/", "PATH=/bin:/sbin:/usr/bin:/usr/sbin", "TERM=xterm"],
      fdEntries,
      cwd: this.cwd,
      parentPid: this.pid,
      exePath: path,
    });
    return proc.pid;
  }

  // __bb_wait(pid, statusPtr, options) -> pid or -errno
  async sys_bb_wait(pid, statusPtr, _options) {
    return await this.sys_wait4(pid, statusPtr, _options, 0);
  }

  // wait4(pid, statusPtr, options, rusagePtr) -> pid or -errno
  // waitid(idtype, id, siginfo*, options)
  //   idtype: P_ALL=0, P_PID=1, P_PGID=2, P_PIDFD=3
  //   options: WNOHANG=1, WSTOPPED=2, WEXITED=4, WCONTINUED=8, WNOWAIT=0x01000000
  //
  // Writes a siginfo_t laid out per the Linux kernel ABI (used directly by
  // musl on 32-bit): si_signo=SIGCHLD, si_code=CLD_EXITED|CLD_KILLED,
  // si_pid, si_uid=0, si_status=<exit code or signal number>.
  async sys_waitid(idtype, id, infoPtr, options) {
    const machine = this.machine;
    if (!machine) return -E.ECHILD;
    machine.zombies ??= new Map();
    const P_ALL = 0, P_PID = 1;
    const WNOHANG = 1, WEXITED = 4;
    if (idtype !== P_ALL && idtype !== P_PID) return -E.EINVAL;
    if (!(options & WEXITED)) return -E.EINVAL; // we only report exited children
    const matchPid = (p) => idtype === P_ALL ? true : p === id;
    const writeSiginfo = (pid, code) => {
      if (!infoPtr) return;
      const dv = this.dv();
      const u8 = this.u8();
      // Zero a 128-byte siginfo_t window.
      u8.fill(0, infoPtr, infoPtr + 128);
      dv.setInt32(infoPtr + 0,  17, true);          // si_signo = SIGCHLD
      dv.setInt32(infoPtr + 4,  0,  true);          // si_errno
      dv.setInt32(infoPtr + 8,  1,  true);          // si_code = CLD_EXITED
      dv.setInt32(infoPtr + 12, pid, true);         // si_pid
      dv.setInt32(infoPtr + 16, 0,   true);         // si_uid
      dv.setInt32(infoPtr + 20, code, true);        // si_status
    };
    // First check zombies.
    for (const [zpid, z] of machine.zombies) {
      if (z.ppid === this.pid && matchPid(zpid)) {
        machine.zombies.delete(zpid);
        writeSiginfo(zpid, z.exitCode ?? 0);
        return 0;
      }
    }
    // Then live children.
    let target: any = null;
    if (idtype === P_PID) {
      const p = machine.processes.get(id);
      if (p && p.ppid === this.pid) target = p;
    } else {
      for (const p of machine.processes.values()) {
        if (p.ppid === this.pid && p !== this.process) { target = p; break; }
      }
    }
    if (!target) {
      if (options & WNOHANG) {
        // POSIX: zero the siginfo and return 0 if no child available.
        if (infoPtr) this.u8().fill(0, infoPtr, infoPtr + 128);
        return 0;
      }
      return -E.ECHILD;
    }
    const code = await target.exitedPromise;
    writeSiginfo(target.pid, typeof code === "number" ? code : 0);
    machine.processes.delete(target.pid);
    return 0;
  }

  async sys_wait4(pid, statusPtr, _options, _rusagePtr) {
    const machine = this.machine;
    if (!machine) return -E.ECHILD;
    machine.zombies ??= new Map();
    // First check zombies (synchronously-finished clone children).
    const writeStatus = (code) => {
      if (statusPtr) this.dv().setInt32(statusPtr, (code & 0xff) << 8, true);
    };
    if (pid > 0) {
      const z = machine.zombies.get(pid);
      if (z && z.ppid === this.pid) {
        machine.zombies.delete(pid);
        writeStatus(z.exitCode);
        return pid;
      }
    } else {
      for (const [zpid, z] of machine.zombies) {
        if (z.ppid === this.pid) {
          machine.zombies.delete(zpid);
          writeStatus(z.exitCode);
          return zpid;
        }
      }
    }
    // Then check live (async-spawned) children via __bb_spawn.
    let target = null;
    if (pid > 0) {
      const p = machine.processes.get(pid);
      if (!p || p.ppid !== this.pid) return -E.ECHILD;
      target = p;
    } else {
      for (const p of machine.processes.values()) {
        if (p.ppid === this.pid && p !== this.process) { target = p; break; }
      }
      if (!target) return -E.ECHILD;
    }
    const code = await target.exitedPromise;
    writeStatus(code);
    const tpid = target.pid;
    machine.processes.delete(tpid);
    return tpid;
  }

  // ---- clone (Linux wasm32 musl model) ----
  //
  // The musl-wasm port turns clone() into a special syscall: the host detects
  // the syscall, sets up the child's stack pointer + tls, and CALLS the
  // exported `__libc_clone_callback`. The callback reads (fn, arg) from
  // *__stack_pointer, calls fn(arg), then issues SYS_exit with the return.
  //
  // We don't have a second wasm execution context — but we don't need one:
  //   1. Parent is suspended via JSPI at the clone import.
  //   2. We reentrantly invoke __libc_clone_callback in the same Instance
  //      after swapping __stack_pointer (and fd table / pid / cwd) to a
  //      child context.
  //   3. The child eventually exits (or execve()s, which we handle by
  //      spawning a fresh subprocess with a new Memory; see sys_execve).
  //   4. We catch ExitTrap, restore parent context, return childPid.
  //
  // This gives us CLONE_VFORK semantics (parent blocks until child exits).
  // Concurrent execution (needed for real pipelines from hush) would require
  // a scheduler over JSPI that snapshots/restores __stack_pointer on every
  // import boundary — not implemented here.
  async sys_clone(flags, newsp, _ptid, _ctid, tlsArg) {
    const machine = this.machine;
    const instance = this.instance;
    if (!machine || !instance) return -E.ENOSYS;

    const spGlobal = this.process.stackPointerGlobal;
    const parentSp = spGlobal.value;
    // Locate fn/arg. C clone() pushes fn at *sp, arg at *(sp+4) (or at *newsp).
    const childSp = newsp || parentSp;
    const dv = this.dv();
    const fn  = dv.getUint32(childSp,     true);
    const arg = dv.getUint32(childSp + 4, true);

    // Allocate child pid + a small per-task record.
    const childPid = machine.nextPid++;

    // Snapshot parent's fd table and replace with a shallow copy for the
    // child. dup2/close in the child only affect this copy. Bump refcounts on
    // any pipe ends being inherited.
    const parentFdtMap = this.fdt.map;
    const childMap = new Map();
    for (const [fd, e] of parentFdtMap) {
      const dup = { ...e };
      if (dup.node?.special?.inherit) dup.node.special.inherit(dup);
      childMap.set(fd, dup);
    }
    const savedFdtMap = parentFdtMap;
    this.fdt.map = childMap;

    // Save other per-task state.
    const savedPid = this.pid;
    const savedPpid = this.ppid;
    const savedCwd = this.cwd;
    const savedTls = instance.exports.__get_tls_base ? (instance.exports.__get_tls_base as any)() : 0;
    this.pid = childPid;
    this.ppid = savedPid;
    this.inCloneChild = true;
    this.cloneExitCode = 0;

    // Switch stack pointer + tls.
    spGlobal.value = childSp;
    const CLONE_SETTLS = 0x00080000;
    if ((flags & CLONE_SETTLS) && instance.exports.__set_tls_base) {
      (instance.exports.__set_tls_base as any)(tlsArg);
    }

    // Reentrantly run the child callback. It must be invoked through
    // WebAssembly.promising so the child's syscall imports can suspend.
    let exitCode = 0;
    let didExec = false;
    try {
      // __libc_clone_callback reads (fn, arg) from *__stack_pointer, calls
      // fn(arg), then calls SYS_exit(retval). We catch the resulting ExitTrap.
      await this.cloneCallbackPromising();
    } catch (e: any) {
      if (e instanceof CloneExecComplete) {
        didExec = true; // subprocess already adopted childPid; no zombie
      } else if (e instanceof ExitTrap) {
        exitCode = e.code;
      } else {
        this.log(`clone child pid ${childPid} crashed: ${e.message}`);
        exitCode = 139;
      }
    }

    // Close any fds still open in the child fdt (releases pipe refcounts).
    // Await any backend flush hooks (e.g. r2fs PUT-on-close) so writes a
    // forked child made to a mounted file system are durable before the
    // parent observes the child as exited.
    const closeWaits: Array<Promise<void>> = [];
    for (const [, ent] of childMap) {
      const sp = ent.node?.special;
      try { sp?.close?.(ent); } catch {}
      const ca = sp?.closeAsync;
      if (ca) {
        try {
          const p = ca(ent);
          if (p && typeof p.then === "function") closeWaits.push(p.catch(() => {}));
        } catch {}
      }
    }
    if (closeWaits.length) await Promise.all(closeWaits);

    // Restore parent context.
    spGlobal.value = parentSp;
    if (instance.exports.__set_tls_base) (instance.exports.__set_tls_base as any)(savedTls);
    this.fdt.map = savedFdtMap;
    this.pid = savedPid;
    this.ppid = savedPpid;
    this.cwd = savedCwd;
    this.inCloneChild = false;

    // If the child didn't exec, store it as a "zombie" so wait4 can find it.
    // If it did exec, the live subprocess in machine.processes already has
    // childPid and will be reaped by wait4 normally.
    if (!didExec) {
      machine.zombies ??= new Map();
      machine.zombies.set(childPid, { exitCode, ppid: savedPid });
    }

    return childPid;
  }

  // execve() in a clone-child context: spawn a fresh subprocess (new Memory +
  // Instance) and HAND OFF this clone-child's identity to it. We don't await;
  // the subprocess runs concurrently while the parent continues. We then throw
  // an exception to unwind the clone-child's wasm stack.
  //
  // Concurrent execution is what makes real pipelines work: hush forks two
  // children back-to-back without waiting in between.
  async sys_execve(pathPtr, argvPtr, envpPtr) {
    const machine = this.machine;
    if (!machine) return -E.ENOSYS;
    const path = this.cstr(pathPtr);
    const argv = this.readStringVec(argvPtr);
    const envp = envpPtr ? this.readStringVec(envpPtr) : [];

    // POSIX: execve must fail with -ENOENT if the file doesn't exist.
    // hush relies on this for its execvp() PATH walk — without it, the very
    // first failing lookup ends up spawning busybox-as-fallback (the default
    // registry entry) which prints "applet not found" and falsely succeeds.
    const node = this.vfs.stat(path);
    if (!node) return -E.ENOENT;
    if (node.type !== "reg" && node.type !== "char") return -E.EACCES;

    // The child's current fdt (with redirections applied) goes into the new
    // subprocess. Hand off ownership: clear the child fdt in place so the
    // post-execve cleanup in sys_clone doesn't double-close pipe ends.
    const fdEntries = new Map();
    for (const [fd, e] of this.fdt.map) fdEntries.set(fd, e);
    this.fdt.map.clear();

    // Spawn but DON'T await. ppid is the original parent (hush), not the
    // clone-child pid (which is about to be reassigned to the subprocess).
    // Program selection (busybox vs. WASI binary) happens inside spawn() via
    // the program registry keyed on exePath.
    const subproc = machine.spawn({
      argv: argv.length ? argv : [path],
      envp: envp.length ? envp : ["HOME=/", "PATH=/bin:/sbin:/usr/bin:/usr/sbin", "TERM=dumb"],
      fdEntries,
      cwd: this.cwd,
      parentPid: this.ppid,    // hush's pid (was saved as ppid by clone)
      exePath: path,
    });

    // Re-key the subprocess to use the clone-child's pid, so wait4(childPid)
    // in the parent finds this subprocess.
    machine.processes.delete(subproc.pid);
    subproc.pid = this.pid;    // this.pid is the clone-child pid
    machine.processes.set(subproc.pid, subproc);

    // Unwind the clone-child's wasm stack (don't run the post-execve
    // _exit(127) block).
    throw new CloneExecComplete(0);
  }

  // ====================================================
  // Socket syscalls
  // ====================================================

  _sockOf(fd) {
    const e = this.fdt.get(fd);
    if (!e || !e.node?.sock) return null;
    return e.node.sock;
  }

  sys_socket(family, type, _proto) {
    const machine = this.machine;
    const sock = createSocket(family, type, {
      resolveOutbound: machine?.resolveOutbound
        ? (ip: string, port: number) => machine.resolveOutbound!(ip, port)
        : undefined,
      isOutboundIp: machine?.isOutboundIp
        ? (ip: string) => machine.isOutboundIp!(ip)
        : undefined,
    });
    if (!sock) return -E.EAFNOSUPPORT;
    // Wrap socket as a vfs "char"-ish node and put it in the fd table.
    const node: FsNode = {
      type: "char",
      mode: 0o140600,    // S_IFSOCK | 0600
      ino: 0, uid: 0, gid: 0, mtime: 0,
      sock,
      special: {
        read:       (u8, buf, count) => sock.read(u8, buf, count),
        readAsync:  (u8, buf, count) => sock.readAsync(u8, buf, count),
        write:      (u8, buf, count) => sock.write(u8, buf, count),
        writeAsync: (u8, buf, count) => sock.writeAsync(u8, buf, count),
        ioctl:      (u8, dv, req, arg) => sock.ioctl(u8, dv, req, arg),
        poll:       (events) => sock.poll(events),
        inherit:    () => sock.inherit(),
        close:      () => sock.close(),
      },
    };
    const cloexec = (type & 0o2000000) !== 0;
    const nonblock = (type & 0o4000) !== 0;
    (sock as any).nonblock = nonblock;
    return this.fdt.alloc({ node, flags: O_RDWR | (nonblock ? O_NONBLOCK : 0), offset: 0, path: "<socket>", cloexec });
  }

  async sys_connect(fd, addrPtr, addrlen) {
    const sock = this._sockOf(fd);
    if (!sock) return -E.ENOTSOCK;
    const addr = readSockaddrIn(this.u8(), this.dv(), addrPtr, addrlen);
    if (!addr) return -E.EINVAL;
    if (addr.family !== AF_INET) return -E.EAFNOSUPPORT;
    if (sock.kind === "udp") return sock.connect(addr.ip, addr.port);
    return await sock.connect(addr.ip, addr.port, this.log);
  }

  sys_bind(fd, _addrPtr, _addrlen) {
    const sock = this._sockOf(fd);
    if (!sock) return -E.ENOTSOCK;
    // UDP/TCP bind is mostly a no-op for outbound-only sockets. Accept it.
    return 0;
  }

  sys_getsockname(fd, addrPtr, addrlenPtr) {
    const sock = this._sockOf(fd);
    if (!sock) return -E.ENOTSOCK;
    const u8 = this.u8(), dv = this.dv();
    const cap = dv.getInt32(addrlenPtr, true);
    if (cap < 16) return -E.EINVAL;
    writeSockaddrIn(u8, dv, addrPtr, { ip: "0.0.0.0", port: 0 });
    dv.setInt32(addrlenPtr, 16, true);
    return 0;
  }

  sys_getpeername(fd, addrPtr, addrlenPtr) {
    const sock = this._sockOf(fd);
    if (!sock) return -E.ENOTSOCK;
    if (sock.kind === "tcp" && sock.state !== "connected") return -E.ENOTCONN;
    const peer = sock.peer || { ip: "0.0.0.0", port: 0 };
    const u8 = this.u8(), dv = this.dv();
    const cap = dv.getInt32(addrlenPtr, true);
    if (cap < 16) return -E.EINVAL;
    writeSockaddrIn(u8, dv, addrPtr, peer);
    dv.setInt32(addrlenPtr, 16, true);
    return 0;
  }

  sys_getsockopt(fd, _level, optname, optvalPtr, optlenPtr) {
    const sock = this._sockOf(fd);
    if (!sock) return -E.ENOTSOCK;
    // SO_ERROR = 4. Report any pending connect error then clear it.
    const SO_ERROR = 4;
    if (optname === SO_ERROR) {
      const dv = this.dv();
      const err = sock.connectErr || 0;
      sock.connectErr = 0;
      dv.setInt32(optvalPtr, err, true);
      dv.setInt32(optlenPtr, 4, true);
      return 0;
    }
    // Default: return 0.
    const dv = this.dv();
    dv.setInt32(optvalPtr, 0, true);
    dv.setInt32(optlenPtr, 4, true);
    return 0;
  }

  sys_shutdown(fd, how) {
    const sock = this._sockOf(fd);
    if (!sock) return -E.ENOTSOCK;
    return sock.shutdown(how);
  }

  async sys_sendto(fd, buf, len, _flags, destPtr, destLen) {
    const sock = this._sockOf(fd);
    if (!sock) return -E.ENOTSOCK;
    if (sock.kind === "tcp") {
      // sendto on a connected TCP socket = write.
      return await sock.writeAsync(this.u8(), buf, len);
    }
    // UDP
    const bytes = this.u8().slice(buf, buf + len);
    let to = null;
    if (destPtr && destLen >= 8) to = readSockaddrIn(this.u8(), this.dv(), destPtr, destLen);
    return await sock.sendto(bytes, to, this.log);
  }

  async sys_recvfrom(fd, buf, len, _flags, srcPtr, srcLenPtr) {
    const sock = this._sockOf(fd);
    if (!sock) return -E.ENOTSOCK;
    if (sock.kind === "tcp") {
      const n = await sock.readAsync(this.u8(), buf, len);
      if (srcPtr && srcLenPtr) {
        const dv = this.dv();
        const cap = dv.getInt32(srcLenPtr, true);
        if (cap >= 16) {
          writeSockaddrIn(this.u8(), dv, srcPtr, sock.peer || { ip: "0.0.0.0", port: 0 });
          dv.setInt32(srcLenPtr, 16, true);
        }
      }
      return n;
    }
    const r = await sock.recvfromAsync(this.u8(), buf, len);
    if (r.r > 0 && srcPtr && srcLenPtr) {
      const dv = this.dv();
      const cap = dv.getInt32(srcLenPtr, true);
      if (cap >= 16) {
        writeSockaddrIn(this.u8(), dv, srcPtr, r.from);
        dv.setInt32(srcLenPtr, 16, true);
      }
    }
    return r.r;
  }

  // struct msghdr (wasm32):
  //   msg_name (ptr) | msg_namelen (u32) | msg_iov (ptr) | msg_iovlen (u32) |
  //   msg_control (ptr) | msg_controllen (u32) | msg_flags (i32)
  async sys_sendmsg(fd, msgPtr, _flags) {
    const dv = this.dv();
    const namePtr = dv.getUint32(msgPtr, true);
    const namelen = dv.getUint32(msgPtr + 4, true);
    const iovPtr  = dv.getUint32(msgPtr + 8, true);
    const iovlen  = dv.getUint32(msgPtr + 12, true);
    let total = 0;
    for (let i = 0; i < iovlen; i++) {
      const base = iovPtr + i * 8;
      const p = dv.getUint32(base, true);
      const l = dv.getUint32(base + 4, true);
      const r = await this.sys_sendto(fd, p, l, 0, namePtr, namelen);
      if (r < 0) return total > 0 ? total : r;
      total += r;
      if (r < l) break;
    }
    return total;
  }

  async sys_recvmsg(fd, msgPtr, _flags) {
    const dv = this.dv();
    const namePtr = dv.getUint32(msgPtr, true);
    const namelen = dv.getUint32(msgPtr + 4, true);
    const iovPtr  = dv.getUint32(msgPtr + 8, true);
    const iovlen  = dv.getUint32(msgPtr + 12, true);
    if (iovlen === 0) return 0;
    // Recv into the first iov; if more bytes than fit, drop (UDP-ish).
    const p0 = dv.getUint32(iovPtr, true);
    const l0 = dv.getUint32(iovPtr + 4, true);
    // We need a namelenPtr to write back into msg.namelen.
    // Trick: write the address into a scratch by reusing msgPtr+4 location.
    const r = await this.sys_recvfrom(fd, p0, l0, 0, namePtr, msgPtr + 4);
    return r;
  }

  // Read a NULL-terminated array of C-string pointers.
  readStringVec(ptr) {
    const dv = this.dv();
    const out = [];
    let p = ptr;
    while (true) {
      const sp = dv.getUint32(p, true);
      if (sp === 0) break;
      out.push(this.cstr(sp));
      p += 4;
    }
    return out;
  }
}



export class ExitTrap extends Error {
  code: number;
  constructor(code: number) { super(`exit(${code})`); this.code = code; }
}

// Thrown by sys_execve to unwind the clone-child's wasm stack after the
// real subprocess (running the exec'd program) has finished.
export class CloneExecComplete extends Error {
  code: number;
  constructor(code: number) { super(`clone-exec(${code})`); this.code = code; }
}
