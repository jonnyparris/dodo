// @ts-nocheck — vendored from busyworker. Refresh procedure in VENDORED.md.
// Shared type definitions used across the "kernel" modules.
//
// Kept intentionally loose — many node/proc/machine fields are added or
// mutated piecemeal during boot, so most things are typed as `any` rather
// than via large discriminated unions. Tightening these is fine but not
// required for the runtime to work.

import type { Vfs } from "./vfs.js";
import type { FdTable } from "./fd.js";
import type { Tty } from "./tty.js";
import type { Kernel } from "./syscalls.js";
import type { ProgramRegistry } from "./programs.js";

// A VFS node. Discriminated by `type`.
export type NodeType = "dir" | "reg" | "symlink" | "char";

export interface FsNodeBase {
  type: NodeType;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
  ino: number;
  // Optional fields layered on by node type / mount type:
  children?: Map<string, FsNode>;
  data?: Uint8Array;
  /** Logical file size, used by stat when the body isn't materialized in
   *  `data` (e.g. R2-backed files that fetch on first read). Falls back to
   *  `data.length` when absent. */
  size?: number;
  link?: string;
  special?: SpecialOps | null;
  dynamic?: DynamicDirOps;
  // Free-form: socket/sock nodes attach the SocketLike here; other extensions
  // hang ad-hoc state off the node too.
  [k: string]: any;
}

export type FsNode = FsNodeBase;

export interface DynamicDirOps {
  list: () => string[];
  lookup: (name: string) => FsNode | null;
  /**
   * Optional async hook awaited by the kernel before path-resolving syscalls
   * (openat, stat, getdents, etc.) touch this directory. Lets backends that
   * need an async fetch (R2 list, S3, network FS) populate their cache so
   * the subsequent sync `list()`/`lookup()` calls succeed.
   *
   * Implementations should be idempotent and cheap on the cache-hit path.
   */
  preload?: () => Promise<void>;
  /**
   * Mutation hooks. Each returns 0 on success or a negative errno. When
   * present, the kernel routes the matching syscall through them; when
   * absent, the syscall falls back to the static-children sync path (which
   * is effectively read-only for dynamic dirs).
   */
  unlinkAsync?: (name: string) => Promise<number>;
  rmdirAsync?: (name: string) => Promise<number>;
  mkdirAsync?: (name: string, mode: number) => Promise<number>;
  /**
   * Rename `oldName` within this dir to `newName` within `newParent` (which
   * may be the same dir for in-place renames or another dir under the same
   * backend). Implementations should return -EXDEV if `newParent` belongs
   * to a different backend.
   */
  renameAsync?: (oldName: string, newParent: FsNode, newName: string) => Promise<number>;
  /**
   * Create a new regular file in this dir on O_CREAT. Returns the new
   * FsNode (which should be spliced into the dynamic dir's listing so a
   * subsequent walk finds it) or a negative errno. Called from
   * dispatchAsync when the kernel sees ENOENT + O_CREAT + a dynamic parent.
   */
  createAsync?: (name: string, mode: number) => Promise<FsNode | number>;
}

// "Special" file operations (tty, pipe, sockets, char devices, host-fs files).
//
// The optional `entry` argument is the FdEntry the syscall is operating on.
// Backends that need per-fd state (file offset, per-handle buffers) use this;
// stateless or node-shared backends (tty, pipe) ignore it.
export interface SpecialOps {
  read?: (u8mem: Uint8Array, buf: number, count: number, entry?: FdEntry) => number;
  readAsync?: (u8mem: Uint8Array, buf: number, count: number, entry?: FdEntry) => Promise<number>;
  write?: (u8mem: Uint8Array, buf: number, count: number, entry?: FdEntry) => number;
  writeAsync?: (u8mem: Uint8Array, buf: number, count: number, entry?: FdEntry) => Promise<number>;
  ioctl?: (u8mem: Uint8Array, dv: DataView, req: number, arg: number) => number;
  poll?: (events?: number) => number;
  inherit?: (entry?: FdEntry) => void;
  close?: (entry?: FdEntry) => void;
  /**
   * Optional async close hook. When present, the kernel awaits it after the
   * sync `close` runs (for explicit `close(2)` syscalls). Used by backends
   * that need to flush dirty buffers to a remote — e.g. r2fs PUT-on-close.
   * Sync teardown paths (process exit) call only the sync `close`.
   */
  closeAsync?: (entry?: FdEntry) => Promise<void>;
  isRead?: boolean;
  isWrite?: boolean;
  pipe?: any;
  [k: string]: any;
}

export interface FdEntry {
  node: FsNode;
  flags: number;
  offset: number;
  path?: string;
  [k: string]: any;
}

export interface JsProgramCtx {
  proc: Proc;
  machine: MachineRef;
  argv: string[];
  envp: string[];
}
export type JsProgramMain = (ctx: JsProgramCtx) => Promise<number> | number;

export interface Program {
  /** Required for linux/wasi ABIs; omitted for "js" programs. */
  module?: WebAssembly.Module;
  abi: "linux" | "wasi" | "js";
  /** Required for "js" ABI: the program's entry point, returns exit code. */
  main?: JsProgramMain;
}

// A running process. Fields are populated incrementally by spawnProcess
// and runLinuxProcess/runWasiProcess — many are nullable for that reason.
export interface Proc {
  pid: number;
  ppid: number;
  memory: WebAssembly.Memory | null;
  indirectTable: WebAssembly.Table | null;
  fdt: FdTable;
  instance: WebAssembly.Instance | null;
  cwd: string;
  argv: string[];
  envp: string[];
  exePath: string | null;
  abi: "linux" | "wasi" | "js";
  exitCode: number;
  exited: boolean;
  exitedResolve: ((code: number | string) => void) | null;
  exitedPromise: Promise<number | string>;
  kernel?: Kernel;
  machine?: MachineRef;
  runPromise?: Promise<void>;
  stackPointerGlobal?: WebAssembly.Global;
  [k: string]: any;
}

// Structural back-reference to the concrete Machine class (defined in the
// example worker, not here). Kernel modules use this rather than importing
// the class directly, to avoid circular deps.
export interface MachineRef {
  wsSend: (data: Uint8Array | string) => void;
  log: (s: string) => void;
  vfs: Vfs;
  tty: Tty;
  processes: Map<number, Proc>;
  nextPid: number;
  initialFdEntries: Map<number, FdEntry>;
  bootMs: number;
  programs: ProgramRegistry;
  zombies?: Map<number, { code?: number; exitCode?: number; pid?: number; ppid: number }>;
  setupFs: () => void;
  pushInput: (bytes: Uint8Array) => void;
  spawn: (opts: any) => Proc;
  run: (...args: any[]) => Promise<any>;
  resolveOutbound?: (ip: string, port: number) => LocalFetcher | null;
  isOutboundIp?: (ip: string) => boolean;
}

/**
 * Anything `fetch`-shaped: WorkerEntrypoint, service binding, plain object.
 * Used by `Machine.outbounds` to route in-VM TCP connections to JS handlers.
 */
export interface LocalFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}
