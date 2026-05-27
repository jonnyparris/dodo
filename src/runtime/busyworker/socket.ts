// @ts-nocheck — vendored from busyworker. Refresh procedure in VENDORED.md.
// Socket emulation for the Linux-syscall worker.
//
// Two backends:
//   1. TCP (SOCK_STREAM) → `connect()` from `cloudflare:sockets`.
//   2. UDP (SOCK_DGRAM) → forwarded to DNS-over-HTTPS when targeting port 53,
//      otherwise -EHOSTUNREACH. Workers can't speak raw UDP.
//
// A Socket is wrapped in a vfs "char" node and attached to the fd table the
// same way pipes are. It exposes `special` with read/write/close/ioctl/poll,
// plus async variants used by the syscall dispatcher.

import * as E from "./errno.js";
import { connect } from "cloudflare:sockets";
import type { LocalFetcher } from "./types.js";

export const AF_INET     = 2;
export const SOCK_STREAM = 1;
export const SOCK_DGRAM  = 2;
export const SOCK_CLOEXEC  = 0o2000000;
export const SOCK_NONBLOCK = 0o4000;

const POLLIN  = 0x1;
const POLLOUT = 0x4;
const POLLHUP = 0x10;

export interface SockAddrIn { family: number; port: number; ip: string }

// ---- sockaddr helpers --------------------------------------------------------

export function readSockaddrIn(u8: Uint8Array, dv: DataView, ptr: number, len: number): SockAddrIn | null {
  if (len < 8) return null;
  const family = dv.getUint16(ptr, true);
  const port = dv.getUint16(ptr + 2, false);  // network byte order
  const a = u8[ptr + 4], b = u8[ptr + 5], c = u8[ptr + 6], d = u8[ptr + 7];
  return { family, port, ip: `${a}.${b}.${c}.${d}` };
}

export function writeSockaddrIn(
  u8: Uint8Array, dv: DataView, ptr: number,
  { family = AF_INET, port = 0, ip = "0.0.0.0" }: Partial<SockAddrIn> = {},
): number {
  dv.setUint16(ptr, family, true);
  dv.setUint16(ptr + 2, port, false);
  const parts = ip.split(".").map((n) => parseInt(n, 10) & 0xff);
  for (let i = 0; i < 4; i++) u8[ptr + 4 + i] = parts[i] ?? 0;
  for (let i = 8; i < 16; i++) u8[ptr + i] = 0;
  return 16;
}

// ---- TCP socket via cloudflare:sockets --------------------------------------

class TcpSocket {
  kind: "tcp" = "tcp";
  state: "created" | "connecting" | "connected" | "closed" = "created";
  socket: Socket | null = null;
  writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  rxBuf: Uint8Array[] = [];
  rxBytes = 0;
  rxClosed = false;
  rxErr: any = null;
  readWaiters: Array<() => void> = [];
  peer: { ip: string; port: number } = { ip: "0.0.0.0", port: 0 };
  local: { ip: string; port: number } = { ip: "0.0.0.0", port: 0 };
  refs = 1;
  nonblock = false;
  connectErr = 0;
  tls = false;
  httpMode = false;
  httpReqBuf: Uint8Array[] = [];
  httpReqDone = false;
  /** If set, _doHttpFetch dispatches here instead of global fetch. */
  fetcher: LocalFetcher | null = null;
  /** Set when fetcher is bound — forces http:// scheme in synthesized URL. */
  fetcherForceHttp = false;
  resolveOutbound: ((ip: string, port: number) => LocalFetcher | null) | null = null;
  isOutboundIp: ((ip: string) => boolean) | null = null;

  inherit(): void { this.refs++; }

  close(): void {
    if (--this.refs > 0) return;
    if (this.state === "closed") return;
    this.state = "closed";
    if (!this.httpMode) {
      try { this.writer?.close().catch(() => {}); } catch {}
      try { this.reader?.cancel().catch(() => {}); } catch {}
      try { this.socket?.close().catch(() => {}); } catch {}
    }
    while (this.readWaiters.length) this.readWaiters.shift()!();
  }

  async connect(ip: string, port: number, log?: (s: string) => void): Promise<number> {
    if (this.state !== "created") return -E.EISCONN;
    this.state = "connecting";
    this.peer = { ip, port };
    // Local binding short-circuit: dispatch via fetcher, no CF socket.
    const bound = this.resolveOutbound?.(ip, port) ?? null;
    if (bound) {
      log && log(`tcp connect ${ip}:${port} → local binding`);
      this.fetcher = bound;
      this.fetcherForceHttp = true;
      this.state = "connected";
      this.httpMode = true;
      return 0;
    }
    // Synthetic outbound IP with no fetcher on this port → refuse fast.
    // (Otherwise we'd hand a fake IP to cloudflare:sockets and hang.)
    if (this.isOutboundIp?.(ip)) {
      log && log(`tcp connect ${ip}:${port} refused (outbound host, port not mapped)`);
      this.state = "closed";
      return -E.ECONNREFUSED;
    }
    try {
      this.socket = connect({ hostname: ip, port }, port === 443 ? { secureTransport: "on", allowHalfOpen: false } : { allowHalfOpen: false });
      await (this.socket as any).opened;
      this.writer = this.socket.writable.getWriter();
      this.reader = this.socket.readable.getReader();
      this.state = "connected";
      this._pumpReader().catch((e) => {
        this.rxErr = e;
        this.rxClosed = true;
        while (this.readWaiters.length) this.readWaiters.shift()!();
      });
      return 0;
    } catch (e: any) {
      log && log(`tcp connect ${ip}:${port} failed (${e.message}); falling back to HTTP-over-fetch`);
      this.state = "connected";
      this.httpMode = true;
      return 0;
    }
  }

  async _pumpReader(): Promise<void> {
    for (;;) {
      const { value, done } = await this.reader!.read();
      if (done) { this.rxClosed = true; break; }
      if (value && value.byteLength) {
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        this.rxBuf.push(chunk);
        this.rxBytes += chunk.byteLength;
        while (this.readWaiters.length) this.readWaiters.shift()!();
      }
    }
    while (this.readWaiters.length) this.readWaiters.shift()!();
  }

  _copyOutRx(u8: Uint8Array, buf: number, count: number): number {
    let off = 0;
    while (off < count && this.rxBuf.length) {
      const head = this.rxBuf[0];
      const n = Math.min(head.byteLength, count - off);
      u8.set(head.subarray(0, n), buf + off);
      off += n;
      if (n === head.byteLength) this.rxBuf.shift();
      else this.rxBuf[0] = head.subarray(n);
      this.rxBytes -= n;
    }
    return off;
  }

  read(u8: Uint8Array, buf: number, count: number): number {
    if (this.state === "closed" && this.rxBytes === 0) return 0;
    if (this.rxBytes === 0) {
      if (this.rxClosed) return 0;
      return -E.EAGAIN;
    }
    return this._copyOutRx(u8, buf, count);
  }

  async readAsync(u8: Uint8Array, buf: number, count: number): Promise<number> {
    while (this.rxBytes === 0 && !this.rxClosed && (this.state as string) !== "closed") {
      await new Promise<void>((r) => this.readWaiters.push(r));
    }
    if (this.rxBytes === 0) return 0;
    return this._copyOutRx(u8, buf, count);
  }

  write(u8: Uint8Array, buf: number, count: number): number {
    if (this.state !== "connected") return -E.ENOTCONN;
    const bytes = u8.slice(buf, buf + count);
    if (this.httpMode) { this._httpQueueWrite(bytes); return count; }
    this.writer!.write(bytes).catch(() => {});
    return count;
  }

  async writeAsync(u8: Uint8Array, buf: number, count: number): Promise<number> {
    if (this.state !== "connected") return -E.ENOTCONN;
    const bytes = u8.slice(buf, buf + count);
    if (this.httpMode) { this._httpQueueWrite(bytes); return count; }
    try { await this.writer!.write(bytes); } catch { return -E.ECONNRESET; }
    return count;
  }

  // ---- HTTP-over-fetch fallback ----

  _httpQueueWrite(chunk: Uint8Array): void {
    if (this.httpReqDone) return;
    this.httpReqBuf.push(chunk);
    const tail = this._concat(this.httpReqBuf);
    const hdrEnd = this._findHeadersEnd(tail);
    if (hdrEnd < 0) return;
    this.httpReqDone = true;
    this._doHttpFetch(tail, hdrEnd).catch((_e) => {
      this._pushTextRx(`HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n`);
      this.rxClosed = true;
      while (this.readWaiters.length) this.readWaiters.shift()!();
    });
  }

  _concat(chunks: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  }

  _findHeadersEnd(buf: Uint8Array): number {
    for (let i = 3; i < buf.length; i++) {
      if (buf[i-3] === 0x0d && buf[i-2] === 0x0a && buf[i-1] === 0x0d && buf[i] === 0x0a) return i + 1;
    }
    return -1;
  }

  _pushTextRx(s: string): void {
    const enc = new TextEncoder().encode(s);
    this.rxBuf.push(enc);
    this.rxBytes += enc.byteLength;
    while (this.readWaiters.length && this.rxBytes > 0) this.readWaiters.shift()!();
  }

  async _doHttpFetch(reqBuf: Uint8Array, hdrEnd: number): Promise<void> {
    const headText = new TextDecoder("utf-8").decode(reqBuf.subarray(0, hdrEnd));
    const body = reqBuf.subarray(hdrEnd);
    const lines = headText.split("\r\n");
    const [method, rawPath] = lines[0].split(" ");
    const headers = new Headers();
    let host = this.peer.ip;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const k = line.slice(0, colon).trim();
      const v = line.slice(colon + 1).trim();
      if (k.toLowerCase() === "host") host = v;
      if (/^(connection|keep-alive|transfer-encoding|upgrade|proxy-connection|content-length|host)$/i.test(k)) continue;
      try { headers.set(k, v); } catch {}
    }
    const scheme = this.fetcherForceHttp ? "http" : (this.peer.port === 443 ? "https" : "http");
    const url = `${scheme}://${host}${rawPath.startsWith("/") ? rawPath : "/" + rawPath}`;
    const init: RequestInit = { method, headers, redirect: "follow" };
    if (method !== "GET" && method !== "HEAD" && body.byteLength > 0) (init as any).body = body;
    const resp = await (this.fetcher ?? globalThis).fetch(url, init);
    let head = `HTTP/1.1 ${resp.status} ${resp.statusText || ""}\r\n`;
    for (const [k, v] of resp.headers) {
      if (/^(transfer-encoding|connection)$/i.test(k)) continue;
      head += `${k}: ${v}\r\n`;
    }
    head += "\r\n";
    this._pushTextRx(head);
    if (resp.body) {
      const reader = resp.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength) {
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          this.rxBuf.push(chunk);
          this.rxBytes += chunk.byteLength;
          while (this.readWaiters.length && this.rxBytes > 0) this.readWaiters.shift()!();
        }
      }
    }
    this.rxClosed = true;
    while (this.readWaiters.length) this.readWaiters.shift()!();
  }

  ioctl(_u8: Uint8Array, _dv: DataView, req: number, _arg: number): number {
    if (req === 0x541B) return this.rxBytes;
    return 0;
  }

  poll(_events?: number): number {
    let r = 0;
    if (this.rxBytes > 0 || this.rxClosed || this.state === "closed") r |= POLLIN;
    if (this.state === "connected") r |= POLLOUT;
    if (this.state === "closed") r |= POLLHUP;
    return r;
  }

  shutdown(_how?: number): number {
    try { this.writer?.close().catch(() => {}); } catch {}
    return 0;
  }
}

// ---- UDP socket (DNS-over-HTTPS shim) ---------------------------------------

interface UdpDatagram { from: { ip: string; port: number }; data: Uint8Array }

class UdpSocket {
  kind: "udp" = "udp";
  state: "created" | "closed" = "created";
  rxBuf: UdpDatagram[] = [];
  rxClosed = false;
  readWaiters: Array<() => void> = [];
  peer: { ip: string; port: number } | null = null;
  refs = 1;

  inherit(): void { this.refs++; }
  close(): void {
    if (--this.refs > 0) return;
    this.state = "closed";
    while (this.readWaiters.length) this.readWaiters.shift()!();
  }

  connect(ip: string, port: number): number {
    this.peer = { ip, port };
    return 0;
  }

  async sendto(bytes: Uint8Array, to: { ip: string; port: number } | null, log?: ((s: string) => void) | null): Promise<number> {
    const dest = to || this.peer;
    if (!dest) return -E.EDESTADDRREQ;
    if (dest.port !== 53) {
      log && log(`udp sendto ${dest.ip}:${dest.port} not supported (only DNS)`);
      return -E.EHOSTUNREACH;
    }
    try {
      const resp = await fetch("https://cloudflare-dns.com/dns-query", {
        method: "POST",
        headers: { "content-type": "application/dns-message", "accept": "application/dns-message" },
        body: bytes as BodyInit,
      });
      if (!resp.ok) {
        log && log(`DoH ${resp.status}`);
        return -E.EHOSTUNREACH;
      }
      const buf = new Uint8Array(await resp.arrayBuffer());
      this.rxBuf.push({ from: { ip: "1.1.1.1", port: 53 }, data: buf });
      while (this.readWaiters.length) this.readWaiters.shift()!();
      return bytes.length;
    } catch (e: any) {
      log && log(`DoH fetch failed: ${e.message}`);
      return -E.EHOSTUNREACH;
    }
  }

  recvfromSync(u8: Uint8Array, buf: number, count: number): { r: number; from?: { ip: string; port: number } } {
    if (this.rxBuf.length === 0) return { r: -E.EAGAIN };
    const m = this.rxBuf.shift()!;
    const n = Math.min(m.data.byteLength, count);
    u8.set(m.data.subarray(0, n), buf);
    return { r: n, from: m.from };
  }

  async recvfromAsync(u8: Uint8Array, buf: number, count: number): Promise<{ r: number; from?: { ip: string; port: number } }> {
    while (this.rxBuf.length === 0 && this.state !== "closed") {
      await new Promise<void>((r) => this.readWaiters.push(r));
    }
    if (this.rxBuf.length === 0) return { r: 0 };
    return this.recvfromSync(u8, buf, count);
  }

  read(u8: Uint8Array, buf: number, count: number): number {
    return this.recvfromSync(u8, buf, count).r;
  }
  async readAsync(u8: Uint8Array, buf: number, count: number): Promise<number> {
    return (await this.recvfromAsync(u8, buf, count)).r;
  }
  write(_u8: Uint8Array, _buf: number, _count: number): number {
    if (!this.peer) return -E.EDESTADDRREQ;
    return -E.EAGAIN;
  }
  async writeAsync(u8: Uint8Array, buf: number, count: number): Promise<number> {
    if (!this.peer) return -E.EDESTADDRREQ;
    const bytes = u8.slice(buf, buf + count);
    return await this.sendto(bytes, this.peer, null);
  }

  ioctl(_u8: Uint8Array, _dv: DataView, req: number, _arg: number): number {
    if (req === 0x541B) return this.rxBuf[0]?.data.byteLength ?? 0;
    return 0;
  }

  poll(_events?: number): number {
    let r = POLLOUT;
    if (this.rxBuf.length > 0) r |= POLLIN;
    return r;
  }

  shutdown(): number { return 0; }
}

export type SocketLike = TcpSocket | UdpSocket;

// ---- factory ----------------------------------------------------------------

export interface CreateSocketOpts {
  resolveOutbound?: (ip: string, port: number) => LocalFetcher | null;
  isOutboundIp?: (ip: string) => boolean;
}

export function createSocket(family: number, type: number, opts: CreateSocketOpts = {}): SocketLike | null {
  const t = type & 0xff;
  if (family !== AF_INET) return null;
  if (t === SOCK_STREAM) {
    const s = new TcpSocket();
    if (opts.resolveOutbound) s.resolveOutbound = opts.resolveOutbound;
    if (opts.isOutboundIp) s.isOutboundIp = opts.isOutboundIp;
    return s;
  }
  if (t === SOCK_DGRAM)  return new UdpSocket();
  return null;
}
