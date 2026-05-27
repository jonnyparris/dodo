// @ts-nocheck — vendored from busyworker. Refresh procedure in VENDORED.md.
// Machine: wires together a Vfs, Tty, program registry, procfs, and host-fs
// mounts into a single "kernel" you can spawn processes inside. One Machine
// per running session (typically one per WebSocket in worker examples).
//
// The Machine takes the initramfs as an ArrayBuffer/Uint8Array so it has no
// build-system dependency on a specific bundler — the embedding worker is
// responsible for static-importing the .cpio.gz blob and handing the bytes
// in here.

import { gunzipSync } from "node:zlib";

import { parseCpio } from "./cpio.js";
import { Vfs, loadCpio } from "./vfs.js";
import { O_RDWR } from "./fd.js";
import { Tty } from "./tty.js";
import { spawnProcess, type SpawnOpts } from "./process.js";
import { buildProcRoot } from "./procfs.js";
import { mountHostFs } from "./hostfs.js";
import { mountR2Fs, type R2BucketLike } from "./r2fs.js";
import { ProgramRegistry } from "./programs.js";
import type { MachineRef, Proc, FdEntry, LocalFetcher } from "./types.js";

export interface MachineOpts {
  /** Stream to send TTY output to (e.g. WebSocket.send). */
  wsSend: (data: Uint8Array | string) => void;
  /** Diagnostic logger (`console.log` or a no-op). */
  log: (s: string) => void;
  /** Program registry — must include the default program (busybox). */
  programs: ProgramRegistry;
  /**
   * Initramfs source. Accepts:
   *   - WebAssembly.Module — produced by scripts/blob-to-wasm.mjs; we
   *     instantiate it and read N bytes from its exported memory (length
   *     provided by the exported `length` global). Preferred: lets the
   *     bundle ride the CompiledWasm rule, no Data rule needed.
   *   - ArrayBuffer / Uint8Array — raw bytes (gzipped or not).
   * Gzipped input is auto-decompressed before passing to parseCpio.
   */
  initramfs: WebAssembly.Module | ArrayBuffer | Uint8Array;
  /**
   * Optional host-fs mounts. Each entry mounts a node:fs host path at the
   * given VFS path. Used by Workers examples to expose /bundle and /tmp.
   */
  hostMounts?: Array<{ vfsPath: string; hostPath: string; writable?: boolean }>;
  /**
   * Optional R2 mounts. Each entry mounts an R2 bucket (or key-prefix) at
   * the given VFS path. Read-only — see `r2fs.ts` for the mount semantics
   * and limitations.
   */
  r2Mounts?: Array<{ vfsPath: string; bucket: R2BucketLike; prefix?: string; writable?: boolean }>;
  /**
   * Outbound traffic routing: in-VM TCP connections that match here are
   * dispatched to a JS `fetch()` handler instead of going through
   * `cloudflare:sockets`. Inspired by Cloudflare Containers' outbound
   * traffic config (https://developers.cloudflare.com/containers/platform-details/outbound-traffic/).
   *
   * Keys are `"host"` (port 80 by default) or `"host:port"`:
   *   - `"localhost:3000"` — connect()s to 127.0.0.1:3000.
   *   - `"foo"` — connect()s to host `foo` on port 80.
   *   - `"api.local:8080"` — connect()s to host `api.local` on port 8080.
   *
   * Non-loopback hostnames are assigned a synthetic IP in 127.0.1.0/24 and
   * written into /etc/hosts so musl resolves them without DNS. The same
   * hostname appearing in multiple keys (different ports) shares one IP.
   *
   * All dispatched requests are synthesized as `http://...` — no TLS.
   */
  outbounds?: Record<string, LocalFetcher>;
}

const GZIP_MAGIC = [0x1f, 0x8b];

function initramfsToBytes(src: WebAssembly.Module | ArrayBuffer | Uint8Array): Uint8Array {
  if (src instanceof WebAssembly.Module) {
    const inst = new WebAssembly.Instance(src);
    const exports = inst.exports as { memory: WebAssembly.Memory; length: WebAssembly.Global };
    const len = exports.length.value as number;
    return new Uint8Array(exports.memory.buffer, 0, len).slice();
  }
  return src instanceof Uint8Array ? src : new Uint8Array(src);
}

export class Machine implements MachineRef {
  wsSend: (data: Uint8Array | string) => void;
  log: (s: string) => void;
  programs: ProgramRegistry;
  vfs: Vfs;
  tty: Tty;
  processes: Map<number, Proc>;
  nextPid: number;
  initialFdEntries: Map<number, FdEntry>;
  bootMs: number;
  initramfs: WebAssembly.Module | ArrayBuffer | Uint8Array;
  hostMounts: Array<{ vfsPath: string; hostPath: string; writable?: boolean }>;
  r2Mounts: NonNullable<MachineOpts["r2Mounts"]>;
  outbounds: NonNullable<MachineOpts["outbounds"]>;
  /** "ip:port" → fetcher, populated in setupFs. */
  private outboundsByIpPort: Map<string, LocalFetcher> = new Map();
  /** Synthetic IPs we own (from 127.0.1.0/24). Unmapped ports on these IPs
   *  should ECONNREFUSED instead of trying cloudflare:sockets. */
  private outboundSyntheticIps: Set<string> = new Set();

  constructor({ wsSend, log, programs, initramfs, hostMounts = [], r2Mounts = [], outbounds = {} }: MachineOpts) {
    this.wsSend = wsSend;
    this.log = log;
    this.programs = programs;
    this.vfs = new Vfs();
    this.tty = new Tty({ write: (bytes: Uint8Array) => this.wsSend(bytes) });
    this.processes = new Map();
    this.nextPid = 1;
    this.initialFdEntries = new Map();
    this.bootMs = Date.now();
    this.initramfs = initramfs;
    this.hostMounts = hostMounts;
    this.r2Mounts = r2Mounts;
    this.outbounds = outbounds;
  }

  /**
   * Look up a fetcher for a (resolved-IP, port) connect target. Called from
   * TcpSocket.connect() before reaching for cloudflare:sockets.
   */
  resolveOutbound(ip: string, port: number): LocalFetcher | null {
    return this.outboundsByIpPort.get(`${ip}:${port}`) ?? null;
  }

  /** True if `ip` is a synthetic outbound IP (a hostname we own). Used to
   *  fast-fail connects to unmapped ports on those IPs. */
  isOutboundIp(ip: string): boolean {
    return this.outboundSyntheticIps.has(ip);
  }

  setupFs(): void {
    let bytes = initramfsToBytes(this.initramfs);
    if (bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1]) {
      bytes = new Uint8Array(gunzipSync(Buffer.from(bytes)));
    }
    const entries = parseCpio(bytes);
    loadCpio(this.vfs, entries);

    const ttyNode = {
      read:      (u8: Uint8Array, buf: number, count: number) => this.tty.read(u8, buf, count),
      readAsync: (u8: Uint8Array, buf: number, count: number) => this.tty.readAsync(u8, buf, count),
      write:     (u8: Uint8Array, buf: number, count: number) => this.tty.write(u8, buf, count),
      ioctl:     (u8: Uint8Array, dv: DataView, req: number, arg: number) => this.tty.ioctl(u8, dv, req, arg),
      poll:      () => this.tty.inputQ.length > 0 ? 1 : 0,
    };
    this.vfs.mkdirp("/dev", 0o755);
    this.vfs.mknodChar("/dev/console", 0o600, ttyNode);
    this.vfs.mknodChar("/dev/tty", 0o666, ttyNode);
    this.vfs.mknodChar("/dev/null", 0o666, {
      read: () => 0, write: (_u, _b, c) => c, ioctl: () => 0, poll: () => 4,
    });
    this.vfs.mknodChar("/dev/zero", 0o666, {
      read: (u, b, c) => { u.fill(0, b, b + c); return c; },
      write: (_u, _b, c) => c, ioctl: () => 0, poll: () => 4,
    });
    this.vfs.mknodChar("/dev/urandom", 0o666, {
      read: (u, b, c) => { const a = new Uint8Array(c); crypto.getRandomValues(a); u.set(a, b); return c; },
      write: (_u, _b, c) => c, ioctl: () => 0, poll: () => 1,
    });
    // Replace the static /proc placeholder with a dynamic procfs root.
    const procRoot = buildProcRoot(this);
    this.vfs.root.children!.set("proc", procRoot);
    this.vfs.mkdirp("/sys", 0o555);
    this.vfs.mkdirp("/tmp", 0o1777);

    // DNS resolver config — musl reads this for getaddrinfo().
    this.vfs.mkdirp("/etc", 0o755);
    this.vfs.writeFile("/etc/resolv.conf",
      new TextEncoder().encode("nameserver 1.1.1.1\nnameserver 1.0.0.1\noptions edns0\n"),
      0o644);

    // Outbound routing. Keys are "host" (→ port 80) or "host:port".
    // Loopback hosts use 127.0.0.1; other hostnames get a synthetic IP from
    // 127.0.1.0/24 and an /etc/hosts entry (so musl resolves without DNS).
    let hostsFile = "127.0.0.1 localhost\n::1 localhost\n";
    let nextSyntheticOctet = 1;
    const ipByHost = new Map<string, string>(); // hostname (lowercased) → ip
    ipByHost.set("localhost", "127.0.0.1");
    ipByHost.set("127.0.0.1", "127.0.0.1");
    const HOST_RE = /^[a-z0-9]([a-z0-9-.]*[a-z0-9])?$/i;
    for (const [key, fetcher] of Object.entries(this.outbounds)) {
      const colon = key.lastIndexOf(":");
      const host = colon >= 0 ? key.slice(0, colon) : key;
      const portStr = colon >= 0 ? key.slice(colon + 1) : "80";
      const port = Number(portStr);
      if (!host || !HOST_RE.test(host)) {
        throw new Error(`outbounds: invalid host in '${key}'`);
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`outbounds: invalid port in '${key}'`);
      }
      const lower = host.toLowerCase();
      let ip = ipByHost.get(lower);
      if (!ip) {
        if (nextSyntheticOctet > 254) {
          throw new Error(`outbounds: too many distinct hosts (max 254)`);
        }
        ip = `127.0.1.${nextSyntheticOctet++}`;
        ipByHost.set(lower, ip);
        this.outboundSyntheticIps.add(ip);
        hostsFile += `${ip} ${host}\n`;
      }
      const mapKey = `${ip}:${port}`;
      if (this.outboundsByIpPort.has(mapKey)) {
        throw new Error(`outbounds: duplicate target ${mapKey} (from '${key}')`);
      }
      this.outboundsByIpPort.set(mapKey, fetcher);
    }
    this.vfs.writeFile("/etc/hosts", new TextEncoder().encode(hostsFile), 0o644);

    // Host-fs mounts (node:fs paths into VFS).
    for (const m of this.hostMounts) {
      try {
        mountHostFs(this.vfs, m.vfsPath, m.hostPath, { writable: m.writable ?? false });
      } catch (e: any) {
        this.log(`mount ${m.vfsPath} failed: ${e.message}`);
      }
    }

    // R2 mounts (read-only).
    for (const m of this.r2Mounts) {
      try {
        mountR2Fs(this.vfs, m.vfsPath, m.bucket, { prefix: m.prefix, log: this.log, writable: m.writable });
      } catch (e: any) {
        this.log(`r2 mount ${m.vfsPath} failed: ${e.message}`);
      }
    }

    // Stub VFS entries for every program in the registry. execve() consults
    // the registry by path, not by reading file contents — we just need
    // stat()/PATH lookup to succeed.
    for (const path of this.programs.paths()) {
      const dir = path.slice(0, path.lastIndexOf("/"));
      if (dir) this.vfs.mkdirp(dir, 0o755);
      this.vfs.writeFile(path, new Uint8Array(0), 0o755);
    }

    // Initial fd table: 0,1,2 → /dev/console
    const cttyNode = this.vfs.stat("/dev/console")!;
    this.initialFdEntries.set(0, { node: cttyNode, flags: O_RDWR, offset: 0, path: "/dev/console" });
    this.initialFdEntries.set(1, { node: cttyNode, flags: O_RDWR, offset: 0, path: "/dev/console" });
    this.initialFdEntries.set(2, { node: cttyNode, flags: O_RDWR, offset: 0, path: "/dev/console" });
  }

  pushInput(bytes: Uint8Array): void {
    this.tty.pushInput(bytes);
  }

  /** Spawn a new child process inheriting fdEntries. */
  spawn(opts: SpawnOpts): Proc {
    return spawnProcess(this, opts);
  }

  /** Boot busybox sh as PID 1 and wait for it to exit. */
  async run(argv: string[] = ["busybox", "sh", "-i"], envp: string[] = ["HOME=/", "PATH=/bin:/sbin:/usr/bin:/usr/sbin", "PS1=/ # ", "TERM=xterm"]): Promise<number | string> {
    this.setupFs();
    const proc = this.spawn({
      argv,
      envp,
      fdEntries: this.initialFdEntries,
      cwd: "/",
      parentPid: 0,
    });
    this.log(`pid ${proc.pid}: ${argv.join(" ")} started`);
    const code = await proc.exitedPromise;
    this.log(`pid ${proc.pid}: exited with ${code}`);
    return code;
  }
}
