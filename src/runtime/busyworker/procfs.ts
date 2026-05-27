// @ts-nocheck — vendored from busyworker. Refresh procedure in VENDORED.md.
// Minimal /proc — dynamic directory backed by the Machine's process map.
//
// Surfaces:
//   /proc/uptime
//   /proc/version
//   /proc/meminfo
//   /proc/cpuinfo
//   /proc/<pid>/cmdline    (NUL-separated argv + trailing NUL)
//   /proc/<pid>/cwd        (symlink → cwd)
//   /proc/<pid>/exe        (symlink → resolved argv[0])
//   /proc/<pid>/status     (key:value lines)
//   /proc/<pid>/stat       (single-line, classic procps format, minimal fields)
//   /proc/<pid>/fd/<n>     (symlink → entry.path)
//
// /proc/self → /proc/<caller_pid> is handled by Kernel.resolvePath.

import { Vfs } from "./vfs.js";
import type { FsNode, MachineRef, Proc } from "./types.js";

const enc = new TextEncoder();

let inoCounter = 100000;
function nextIno() { return inoCounter++; }

function regFile(content: Uint8Array | string): FsNode {
  const data = content instanceof Uint8Array ? content : enc.encode(String(content));
  return {
    type: "reg",
    mode: 0o100444,
    uid: 0, gid: 0, mtime: Math.floor(Date.now() / 1000),
    ino: nextIno(),
    data,
  };
}

function symlinkNode(target: string): FsNode {
  return {
    type: "symlink",
    mode: 0o120777,
    uid: 0, gid: 0, mtime: Math.floor(Date.now() / 1000),
    ino: nextIno(),
    link: target,
  };
}

function pidDir(_machine: MachineRef, proc: Proc): FsNode {
  const argv = proc.argv || [];
  const cmdline = enc.encode(argv.join("\0") + "\0");
  const exe = symlinkNode(proc.exePath || (argv[0] ? "/bin/" + argv[0] : "/bin/busybox"));
  const cwd = symlinkNode(proc.cwd || proc.kernel?.cwd || "/");
  const status =
    `Name:\t${argv[0] || "?"}\n` +
    `State:\t${proc.exited ? "Z (zombie)" : "S (sleeping)"}\n` +
    `Pid:\t${proc.pid}\n` +
    `PPid:\t${proc.ppid}\n` +
    `Uid:\t0\t0\t0\t0\n` +
    `Gid:\t0\t0\t0\t0\n` +
    `Threads:\t1\n` +
    `VmRSS:\t${(proc.memory?.buffer.byteLength || 0) >> 10} kB\n`;
  // Classic /proc/<pid>/stat: pid (comm) state ppid pgrp session ... (44 fields)
  // We emit the minimum that procps tolerates.
  const comm = "(" + (argv[0] || "?").slice(0, 15) + ")";
  const stat = `${proc.pid} ${comm} ${proc.exited ? "Z" : "S"} ${proc.ppid} ${proc.pid} ${proc.pid} 0 -1 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`;

  const fdDir = Vfs.makeDynamicDir(0o555, {
    list: () => {
      const k = proc.kernel;
      if (!k) return [];
      return [...k.fdt.map.keys()].map(String);
    },
    lookup: (name) => {
      const fd = Number(name);
      if (!Number.isInteger(fd)) return null;
      const k = proc.kernel;
      if (!k) return null;
      const entry = k.fdt.get(fd);
      if (!entry) return null;
      return symlinkNode(entry.path || "<unknown>");
    },
  });

  return Vfs.makeDynamicDir(0o555, {
    list: () => ["cmdline", "cwd", "exe", "status", "stat", "fd"],
    lookup: (name) => {
      switch (name) {
        case "cmdline": return regFile(cmdline);
        case "cwd":     return cwd;
        case "exe":     return exe;
        case "status":  return regFile(status);
        case "stat":    return regFile(stat);
        case "fd":      return fdDir;
        default:        return null;
      }
    },
  });
}

export function buildProcRoot(machine: MachineRef): FsNode {
  return Vfs.makeDynamicDir(0o555, {
    list: () => {
      const names = ["uptime", "version", "meminfo", "cpuinfo", "self"];
      for (const pid of machine.processes.keys()) names.push(String(pid));
      return names;
    },
    lookup: (name) => {
      if (/^\d+$/.test(name)) {
        const proc = machine.processes.get(Number(name));
        if (!proc) return null;
        return pidDir(machine, proc);
      }
      switch (name) {
        case "self": {
          // Best-effort: resolves via Kernel.resolvePath in the syscall layer,
          // but if somebody walks here directly, point at pid 1.
          return symlinkNode("/proc/1");
        }
        case "uptime": {
          const up = (Date.now() - machine.bootMs) / 1000;
          return regFile(`${up.toFixed(2)} ${up.toFixed(2)}\n`);
        }
        case "version":
          return regFile("Linux version 0.0.1-wasm (busyworker) #1 SMP wasm32\n");
        case "meminfo":
          return regFile(
            "MemTotal:       65536 kB\n" +
            "MemFree:        32768 kB\n" +
            "MemAvailable:   32768 kB\n"
          );
        case "cpuinfo":
          return regFile("processor\t: 0\nmodel name\t: wasm32 (Cloudflare Worker)\n\n");
        default:
          return null;
      }
    },
  });
}
