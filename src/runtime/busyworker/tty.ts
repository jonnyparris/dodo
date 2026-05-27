// @ts-nocheck — vendored from busyworker. Refresh procedure in VENDORED.md.
// A TTY backing: ring buffer for input + write callback for output.
// `read(buf, count)` returns bytes copied (0 if no data ready), used by /dev/console etc.
// `write(buf, count)` calls back to the host (typically WebSocket send).
//
// ioctl handles enough for busybox to set raw mode.

import { EAGAIN, ENOTTY } from "./errno.js";

type Termios = {
  c_iflag: number;
  c_oflag: number;
  c_cflag: number;
  c_lflag: number;
  c_line: number;
  c_cc: Uint8Array;
};

// ioctl numbers (asm-generic, what most Linux ABIs use)
export const TCGETS     = 0x5401;
export const TCSETS     = 0x5402;
export const TCSETSW    = 0x5403;
export const TCSETSF    = 0x5404;
export const TIOCGPGRP  = 0x540F;
export const TIOCSPGRP  = 0x5410;
export const TIOCGWINSZ = 0x5413;
export const TIOCSWINSZ = 0x5414;
export const TIOCSCTTY  = 0x540E;
export const FIONREAD   = 0x541B;
export const FIONBIO    = 0x5421;

// termios c_lflag bits
const ICANON = 0o000002;
const ECHO   = 0o000010;
const ISIG   = 0o000001;
const IEXTEN = 0o100000;

export class Tty {
  writeHost: (bytes: Uint8Array) => void;
  inputQ: number[];
  waiters: Array<() => void>;
  cols: number;
  rows: number;
  termios: Termios;

  constructor({ write }: { write: (bytes: Uint8Array) => void }) {
    this.writeHost = write;
    this.inputQ = [];   // queue of bytes (numbers 0-255)
    this.waiters = [];  // pending read resolvers (for JSPI later)
    this.cols = 80;
    this.rows = 25;
    // Default termios: cooked mode with echo
    this.termios = {
      c_iflag: 0o000400,                          // ICRNL
      c_oflag: 0o000005,                          // OPOST | ONLCR
      c_cflag: 0o002000 | 0o000060 | 0o000200,    // B38400 | CS8 | CREAD
      c_lflag: ICANON | ECHO | ISIG | IEXTEN,
      c_line: 0,
      c_cc: new Uint8Array(19),
    };
    // c_cc defaults (minimal)
    this.termios.c_cc[0] = 0x03; // VINTR  = Ctrl-C
    this.termios.c_cc[1] = 0x1c; // VQUIT  = Ctrl-\
    this.termios.c_cc[2] = 0x7f; // VERASE = DEL
    this.termios.c_cc[3] = 0x15; // VKILL  = Ctrl-U
    this.termios.c_cc[4] = 0x04; // VEOF   = Ctrl-D
  }

  // ---- input (from host: WS message) ----
  pushInput(bytes: Uint8Array): void {
    for (const b of bytes) {
      // If termios has ECHO set, echo it back to host.
      if (this.termios.c_lflag & ECHO) {
        this.writeHost(new Uint8Array([b === 0x0d ? 0x0a : b]));
      }
      this.inputQ.push(b);
    }
    // Wake any waiters.
    while (this.waiters.length && this.inputQ.length) {
      const w = this.waiters.shift()!;
      w();
    }
  }

  // ---- reads from busybox ----
  read(u8mem: Uint8Array, buf: number, count: number): number {
    if (this.inputQ.length === 0) return -EAGAIN;
    const n = Math.min(count, this.inputQ.length);
    for (let i = 0; i < n; i++) u8mem[buf + i] = this.inputQ.shift()!;
    return n;
  }

  // Promise-returning read for JSPI use later. Resolves when at least 1 byte is available.
  readAsync(u8mem: Uint8Array, buf: number, count: number): Promise<number> {
    return new Promise<number>((resolve) => {
      const tryFill = (): boolean => {
        if (this.inputQ.length > 0) {
          const n = Math.min(count, this.inputQ.length);
          for (let i = 0; i < n; i++) u8mem[buf + i] = this.inputQ.shift()!;
          resolve(n);
          return true;
        }
        return false;
      };
      if (!tryFill()) this.waiters.push(() => { tryFill(); });
    });
  }

  // ---- writes from busybox ----
  write(u8mem: Uint8Array, buf: number, count: number): number {
    const bytes = u8mem.slice(buf, buf + count);
    this.writeHost(bytes);
    return count;
  }

  ioctl(u8mem: Uint8Array, dv: DataView, req: number, arg: number): number {
    switch (req) {
      case TCGETS: {
        // struct termios (kernel): c_iflag, c_oflag, c_cflag, c_lflag (u32 each),
        //   c_line (u8), c_cc[19] (u8), then ispeed/ospeed (u32 each) for some arches.
        // Layout (32-bit): 4+4+4+4+1+19+? We write 36 bytes (4*4 + 1 + 19 = 36).
        dv.setUint32(arg + 0, this.termios.c_iflag, true);
        dv.setUint32(arg + 4, this.termios.c_oflag, true);
        dv.setUint32(arg + 8, this.termios.c_cflag, true);
        dv.setUint32(arg + 12, this.termios.c_lflag, true);
        u8mem[arg + 16] = this.termios.c_line;
        for (let i = 0; i < 19; i++) u8mem[arg + 17 + i] = this.termios.c_cc[i];
        return 0;
      }
      case TCSETS:
      case TCSETSW:
      case TCSETSF: {
        this.termios.c_iflag = dv.getUint32(arg + 0, true);
        this.termios.c_oflag = dv.getUint32(arg + 4, true);
        this.termios.c_cflag = dv.getUint32(arg + 8, true);
        this.termios.c_lflag = dv.getUint32(arg + 12, true);
        this.termios.c_line = u8mem[arg + 16];
        for (let i = 0; i < 19; i++) this.termios.c_cc[i] = u8mem[arg + 17 + i];
        return 0;
      }
      case TIOCGWINSZ: {
        // struct winsize { u16 ws_row, ws_col, ws_xpixel, ws_ypixel }
        dv.setUint16(arg + 0, this.rows, true);
        dv.setUint16(arg + 2, this.cols, true);
        dv.setUint16(arg + 4, 0, true);
        dv.setUint16(arg + 6, 0, true);
        return 0;
      }
      case TIOCSWINSZ: {
        this.rows = dv.getUint16(arg + 0, true);
        this.cols = dv.getUint16(arg + 2, true);
        return 0;
      }
      case TIOCGPGRP: {
        dv.setUint32(arg, 1, true);
        return 0;
      }
      case TIOCSPGRP:
      case TIOCSCTTY:
        return 0;
      case FIONREAD: {
        dv.setUint32(arg, this.inputQ.length, true);
        return 0;
      }
      case FIONBIO:
        // Toggle non-blocking; we treat reads as always non-blocking anyway.
        return 0;
      default:
        return -ENOTTY;
    }
  }
}
