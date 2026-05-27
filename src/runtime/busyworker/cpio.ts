// @ts-nocheck — vendored from busyworker. Refresh procedure in VENDORED.md.
// Minimal cpio (newc format) parser. Returns an array of { path, mode, type, data, link, uid, gid, mtime }.
// type: 'reg' | 'dir' | 'symlink' | 'char' | 'block' | 'fifo' | 'sock'
//
// newc header (110 bytes ASCII hex, big-endian conceptually but each field is 8 hex chars):
//   magic[6]="070701"
//   ino[8] mode[8] uid[8] gid[8] nlink[8] mtime[8] filesize[8]
//   devmajor[8] devminor[8] rdevmajor[8] rdevminor[8] namesize[8] check[8]
// Then name (namesize bytes, NUL-terminated), padded to 4-byte boundary AFTER header+name.
// Then data (filesize bytes), padded to 4-byte boundary.
// Terminating entry has name "TRAILER!!!".

const S_IFMT   = 0o170000;
const S_IFSOCK = 0o140000;
const S_IFLNK  = 0o120000;
const S_IFREG  = 0o100000;
const S_IFBLK  = 0o060000;
const S_IFDIR  = 0o040000;
const S_IFCHR  = 0o020000;
const S_IFIFO  = 0o010000;

export interface CpioEntry {
  path: string;
  mode: number;
  type: string;
  uid: number;
  gid: number;
  mtime: number;
  data: Uint8Array | null;
  link: string | null;
}

function typeOf(mode: number): string {
  switch (mode & S_IFMT) {
    case S_IFREG:  return "reg";
    case S_IFDIR:  return "dir";
    case S_IFLNK:  return "symlink";
    case S_IFCHR:  return "char";
    case S_IFBLK:  return "block";
    case S_IFIFO:  return "fifo";
    case S_IFSOCK: return "sock";
    default:       return "reg";
  }
}

function hex(buf: Uint8Array, off: number): number {
  // 8 ASCII hex digits
  let n = 0;
  for (let i = 0; i < 8; i++) {
    const c = buf[off + i];
    n = n * 16 + (c >= 0x61 ? c - 0x61 + 10 : c >= 0x41 ? c - 0x41 + 10 : c - 0x30);
  }
  return n >>> 0;
}

const align4 = (n: number): number => (n + 3) & ~3;

export function parseCpio(bytes: Uint8Array): CpioEntry[] {
  const dec = new TextDecoder("utf-8");
  const entries: CpioEntry[] = [];
  let off = 0;
  while (off < bytes.length) {
    if (off + 110 > bytes.length) break;
    // Check magic
    if (!(bytes[off] === 0x30 && bytes[off+1] === 0x37 && bytes[off+2] === 0x30 &&
          bytes[off+3] === 0x37 && bytes[off+4] === 0x30 && bytes[off+5] === 0x31)) {
      throw new Error(`cpio: bad magic at offset ${off}`);
    }
    const mode     = hex(bytes, off +  6 + 1*8);
    const uid      = hex(bytes, off +  6 + 2*8);
    const gid      = hex(bytes, off +  6 + 3*8);
    const mtime    = hex(bytes, off +  6 + 5*8);
    const filesize = hex(bytes, off +  6 + 6*8);
    const namesize = hex(bytes, off +  6 + 11*8);

    const nameStart = off + 110;
    const nameEnd = nameStart + namesize - 1; // strip trailing NUL
    const name = dec.decode(bytes.slice(nameStart, nameEnd));

    const dataStart = align4(nameStart + namesize);
    const dataEnd = dataStart + filesize;

    if (name === "TRAILER!!!") break;

    const type = typeOf(mode);
    const entry: CpioEntry = {
      path: name.startsWith("/") ? name : "/" + name,
      mode: mode & 0o7777,
      type,
      uid, gid, mtime,
      data: type === "reg" ? bytes.slice(dataStart, dataEnd) : null,
      link: type === "symlink" ? dec.decode(bytes.slice(dataStart, dataEnd)) : null,
    };
    // Normalize "/." to "/"
    if (entry.path === "/.") entry.path = "/";
    entries.push(entry);

    off = align4(dataEnd);
  }
  return entries;
}
