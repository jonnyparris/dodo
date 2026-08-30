import type { FileSystem, FsStat } from "@cloudflare/shell";

/**
 * Adapts @cloudflare/computer's WorkspaceFilesystem to @cloudflare/shell's
 * FileSystem interface. Used to back Dodo's codemode stateBackend with the
 * computer workspace while keeping the existing @cloudflare/shell Workspace
 * for file tools.
 *
 * Symlinks are not supported by the computer VFS — readlink/symlink throw
 * ENOSYS. cp/mv/glob are composed from primitive operations.
 */
export class ComputerFileSystem implements FileSystem {
  constructor(private readonly fs: any) {}

  async readFile(path: string): Promise<string> {
    return await this.fs.readFile(path, "utf8");
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const stream = await this.fs.readFile(path);
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((sum: number, c: Uint8Array) => sum + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.fs.writeFile(path, content);
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    await this.fs.writeFile(path, content);
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    let existing: Uint8Array;
    try {
      existing = await this.readFileBytes(path);
    } catch {
      existing = new Uint8Array(0);
    }
    const toAppend = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const combined = new Uint8Array(existing.length + toAppend.length);
    combined.set(existing);
    combined.set(toAppend, existing.length);
    await this.fs.writeFile(path, combined);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.fs.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FsStat> {
    const s = await this.fs.stat(path);
    return this.toFsStat(s);
  }

  async lstat(path: string): Promise<FsStat> {
    const s = await this.fs.lstat(path);
    return this.toFsStat(s);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.fs.mkdir(path, options);
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.fs.readdir(path);
    return entries.map((e: { name: string }) => e.name).sort();
  }

  async readdirWithFileTypes(path: string): Promise<Array<{ name: string; type: "file" | "directory" | "symlink" }>> {
    const entries = await this.fs.readdir(path);
    return entries
      .map((e: { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }) => ({
        name: e.name,
        type: (e.isFile ? "file" : e.isDirectory ? "directory" : "symlink") as "file" | "directory" | "symlink",
      }))
      .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    await this.fs.rm(path, options);
  }

  async cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    const srcStat = await this.stat(src);
    if (srcStat.type === "directory") {
      if (!options?.recursive) {
        throw new Error(`EISDIR: is a directory: ${src}`);
      }
      await this.mkdir(dest, { recursive: true });
      const entries = await this.readdirWithFileTypes(src);
      for (const entry of entries) {
        await this.cp(`${src}/${entry.name}`, `${dest}/${entry.name}`, { recursive: true });
      }
      return;
    }
    const content = await this.readFileBytes(src);
    await this.writeFileBytes(dest, content);
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true, force: true });
  }

  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw new Error("ENOSYS: symlink not supported by computer VFS");
  }

  async readlink(_path: string): Promise<string> {
    throw new Error("ENOSYS: readlink not supported by computer VFS");
  }

  async realpath(path: string): Promise<string> {
    return this.resolvePath("/", path);
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return this.normalizePath(path);
    const joined = base.endsWith("/") ? base + path : `${base}/${path}`;
    return this.normalizePath(joined);
  }

  async glob(pattern: string): Promise<string[]> {
    const entries = await this.fs.find("/", pattern);
    return entries.map((e: { path: string }) => e.path).sort();
  }

  private toFsStat(s: {
    name: string;
    inode: number;
    mode: number;
    mtime: number;
    size: number;
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
  }): FsStat {
    return {
      type: s.isFile ? "file" : s.isDirectory ? "directory" : "symlink",
      size: s.size,
      mtime: new Date(s.mtime * 1000),
      mode: s.mode,
    };
  }

  private normalizePath(path: string): string {
    const parts = path.split("/");
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        resolved.pop();
      } else {
        resolved.push(part);
      }
    }
    return "/" + resolved.join("/");
  }
}
