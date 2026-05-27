// @ts-nocheck — vendored from busyworker. Refresh procedure in VENDORED.md.
// @busyworker/core — public API.
//
// A "kernel" runtime that lets you run busybox.wasm (and other Linux/WASI
// binaries) inside a single JS isolate. Designed for Cloudflare Workers but
// has no Workers-specific dependencies at this layer (the cloudflare:sockets
// shim only activates if you actually use sockets).

export { Machine, type MachineOpts } from "./machine.js";
export { ProgramRegistry, type ProgramSpec, type ProgramRegistryOpts } from "./programs.js";
export { Pipe } from "./pipe.js";
export { Vfs, loadCpio } from "./vfs.js";
export { Tty } from "./tty.js";
export { FdTable, O_RDONLY, O_WRONLY, O_RDWR, O_ACCMODE, O_CREAT, O_EXCL,
         O_NOCTTY, O_TRUNC, O_APPEND, O_NONBLOCK, O_DIRECTORY, O_NOFOLLOW,
         O_CLOEXEC } from "./fd.js";
export { spawnProcess, type SpawnOpts, MEMLAYOUT } from "./process.js";
export { Kernel, ExitTrap, NR } from "./syscalls.js";
export { Wasi, WasiExit } from "./wasi.js";
export { parseCpio, type CpioEntry } from "./cpio.js";
export { mountHostFs } from "./hostfs.js";
export { mountR2Fs, type R2BucketLike, type R2FsMountOpts } from "./r2fs.js";
export { buildProcRoot } from "./procfs.js";
export {
  AF_INET, SOCK_STREAM, SOCK_DGRAM,
  createSocket,
} from "./socket.js";
export * as errno from "./errno.js";
export type {
  MachineRef,
  Proc,
  Program,
  JsProgramCtx,
  JsProgramMain,
  FdEntry,
  FsNode,
  NodeType,
  SpecialOps,
  DynamicDirOps,
  LocalFetcher,
} from "./types.js";
