// @ts-nocheck — vendored from busyworker. Refresh procedure in VENDORED.md.
// In-memory pipe: a ring buffer with read/write ends.
//
// Two fd entries share one Pipe object. The read-end has special.read/poll/readAsync;
// the write-end has special.write/poll. close() decrements a refcount per end; when
// the write-end ref hits 0 the pipe is "EOF" and reads return 0. When the read-end
// ref hits 0, writes return -EPIPE.

import { EAGAIN, EPIPE } from "./errno.js";
import type { SpecialOps } from "./types.js";

const CAPACITY = 65536;

export class Pipe {
  buf: Uint8Array;
  head: number;
  tail: number;
  size: number;
  readerRefs: number;
  writerRefs: number;
  readWaiters: Array<() => void>;
  writeWaiters: Array<() => void>;

  constructor() {
    this.buf = new Uint8Array(CAPACITY);
    this.head = 0;
    this.tail = 0;
    this.size = 0;
    this.readerRefs = 1;
    this.writerRefs = 1;
    this.readWaiters = [];
    this.writeWaiters = [];
  }

  _readBytes(u8mem: Uint8Array, dst: number, count: number): number {
    const n = Math.min(count, this.size);
    for (let i = 0; i < n; i++) {
      u8mem[dst + i] = this.buf[this.head];
      this.head = (this.head + 1) % CAPACITY;
    }
    this.size -= n;
    while (this.writeWaiters.length && this.size < CAPACITY) {
      this.writeWaiters.shift()!();
    }
    return n;
  }

  _writeBytes(u8mem: Uint8Array, src: number, count: number): number {
    const room = CAPACITY - this.size;
    const n = Math.min(count, room);
    for (let i = 0; i < n; i++) {
      this.buf[this.tail] = u8mem[src + i];
      this.tail = (this.tail + 1) % CAPACITY;
    }
    this.size += n;
    while (this.readWaiters.length && this.size > 0) {
      this.readWaiters.shift()!();
    }
    return n;
  }

  // Build the "read end" special node operations.
  readEnd(): SpecialOps {
    return {
      read: (u8mem, buf, count) => {
        if (this.size === 0) {
          if (this.writerRefs === 0) return 0; // EOF
          return -EAGAIN;
        }
        return this._readBytes(u8mem, buf, count);
      },
      readAsync: (u8mem, buf, count) => {
        return new Promise<number>((resolve) => {
          const tryFill = (): boolean => {
            if (this.size > 0) { resolve(this._readBytes(u8mem, buf, count)); return true; }
            if (this.writerRefs === 0) { resolve(0); return true; }
            return false;
          };
          if (!tryFill()) this.readWaiters.push(() => { tryFill(); });
        });
      },
      write: () => -EPIPE,
      ioctl: () => 0,
      poll: () => (this.size > 0 || this.writerRefs === 0) ? 1 /*POLLIN*/ : 0,
      inherit: () => { this.readerRefs++; },
      close: (_entry?) => {
        if (--this.readerRefs <= 0) {
          // Wake writers so they see EPIPE.
          while (this.writeWaiters.length) this.writeWaiters.shift()!();
        }
      },
      isRead: true,
      pipe: this,
    };
  }

  writeEnd(): SpecialOps {
    return {
      read: () => 0,
      write: (u8mem: Uint8Array, buf: number, count: number) => {
        if (this.readerRefs === 0) return -EPIPE;
        if (this.size === CAPACITY) return -EAGAIN;
        return this._writeBytes(u8mem, buf, count);
      },
      writeAsync: (u8mem: Uint8Array, buf: number, count: number) => {
        return new Promise<number>((resolve) => {
          const tryWrite = (): boolean => {
            if (this.readerRefs === 0) { resolve(-EPIPE); return true; }
            if (this.size < CAPACITY) { resolve(this._writeBytes(u8mem, buf, count)); return true; }
            return false;
          };
          if (!tryWrite()) this.writeWaiters.push(() => { tryWrite(); });
        });
      },
      ioctl: () => 0,
      poll: () => (this.size < CAPACITY || this.readerRefs === 0) ? 4 /*POLLOUT*/ : 0,
      inherit: () => { this.writerRefs++; },
      close: (_entry?) => {
        if (--this.writerRefs <= 0) {
          // Wake readers so they see EOF.
          while (this.readWaiters.length) this.readWaiters.shift()!();
        }
      },
      isWrite: true,
      pipe: this,
    };
  }
}
