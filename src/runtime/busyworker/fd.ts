// @ts-nocheck — vendored from busyworker. Refresh procedure in VENDORED.md.
// File descriptor table.
//
// Each fd entry: { node, flags, offset, ttyMode? }
// - node: a vfs node (reg, dir, char, ...)
// - flags: open flags (O_RDONLY etc), retained for fcntl(F_GETFL)
// - offset: file position for reg files; 0 for others
// - tty: optional tty backing (for /dev/console etc.)

import { EBADF } from "./errno.js";
import type { FdEntry } from "./types.js";

export const O_RDONLY    = 0o0;
export const O_WRONLY    = 0o1;
export const O_RDWR      = 0o2;
export const O_ACCMODE   = 0o3;
export const O_CREAT     = 0o100;
export const O_EXCL      = 0o200;
export const O_NOCTTY    = 0o400;
export const O_TRUNC     = 0o1000;
export const O_APPEND    = 0o2000;
export const O_NONBLOCK  = 0o4000;
export const O_DIRECTORY = 0o200000;
export const O_NOFOLLOW  = 0o400000;
export const O_CLOEXEC   = 0o2000000;

export class FdTable {
  map: Map<number, FdEntry>;
  next: number;

  constructor() {
    this.map = new Map();
    this.next = 3;
  }

  alloc(entry: FdEntry, fd: number = -1): number {
    if (fd < 0) {
      while (this.map.has(this.next)) this.next++;
      fd = this.next++;
    }
    this.map.set(fd, entry);
    return fd;
  }

  get(fd: number): FdEntry | null {
    return this.map.get(fd) ?? null;
  }

  close(fd: number): number {
    if (!this.map.has(fd)) return -EBADF;
    const e = this.map.get(fd)!;
    if (e.node && e.node.special && e.node.special.close) e.node.special.close(e);
    this.map.delete(fd);
    return 0;
  }

  dup(fd: number, minfd: number = 0): number {
    const e = this.map.get(fd);
    if (!e) return -EBADF;
    let nfd = Math.max(minfd, 3);
    while (this.map.has(nfd)) nfd++;
    const dup: FdEntry = { ...e };
    if (dup.node?.special?.inherit) dup.node.special.inherit(dup);
    this.map.set(nfd, dup);
    return nfd;
  }

  dup2(oldfd: number, newfd: number): number {
    const e = this.map.get(oldfd);
    if (!e) return -EBADF;
    if (oldfd === newfd) return newfd;
    if (this.map.has(newfd)) this.close(newfd);
    const dup: FdEntry = { ...e };
    if (dup.node?.special?.inherit) dup.node.special.inherit(dup);
    this.map.set(newfd, dup);
    return newfd;
  }
}
