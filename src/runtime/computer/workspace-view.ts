import type { ComputerFileSystem } from "./computer-fs";

/**
 * Shape shell Workspace consumers depend on. Mirrors @cloudflare/shell's
 * FileInfo/FileStat (path, name, type, mimeType, size, timestamps) so
 * facet RPC return types and `mapWorkspaceEntry` keep working unchanged.
 */
export interface WorkspaceFileInfo {
  path: string;
  name: string;
  type: "file" | "directory" | "symlink";
  mimeType: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  target?: string;
}

const MIME_BY_EXT: Record<string, string> = {
  css: "text/css",
  csv: "text/csv",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  md: "text/markdown",
  mjs: "text/javascript",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  ts: "text/typescript",
  tsx: "text/typescript",
  txt: "text/plain",
  wasm: "application/wasm",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
};

function mimeForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function isWorkspaceFsError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: string }).code === code
  );
}

function dirName(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "/";
}

/**
 * Workspace-shaped read/write view over the computer VFS.
 *
 * @cloudflare/think's workspace tools (and Think's `_host*` bridge) call
 * shell-Workspace semantics: null on missing files, FileInfo-shaped
 * `readDir`/`glob` results, `deleteFile`, `_getAllPaths`. The raw computer
 * fs throws ENOENT and returns string[]/dirents instead. This view adapts
 * one to the other so every Dodo consumer keeps its contract while all
 * reads and writes land in the single computer-backed store.
 *
 * Note: this deliberately does NOT use @cloudflare/computer's built-in
 * `useThink` compatibility layer — its `glob()` prepends a `/workspace`
 * prefix (sandbox mount convention) that doesn't exist on the DO-side fs,
 * and its directory entries carry size 0.
 */
export class WorkspaceFsView {
  constructor(private readonly computerFs: ComputerFileSystem) {}

  /** The underlying FileSystem — for createGit() and other FileSystem consumers. */
  get fs(): ComputerFileSystem {
    return this.computerFs;
  }

  async readFile(path: string): Promise<string | null> {
    try {
      return await this.computerFs.readFile(path);
    } catch (error) {
      if (isWorkspaceFsError(error, "ENOENT")) return null;
      throw error;
    }
  }

  async readFileBytes(path: string): Promise<Uint8Array | null> {
    try {
      return await this.computerFs.readFileBytes(path);
    } catch (error) {
      if (isWorkspaceFsError(error, "ENOENT")) return null;
      throw error;
    }
  }

  /**
   * mimeType is accepted for shell-Workspace API compatibility. The
   * computer VFS has no mime storage — the view derives a mime type
   * from the extension on stat/readDir/glob instead.
   */
  async writeFile(path: string, content: string, _mimeType?: string): Promise<void> {
    await this.mkdir(dirName(path), { recursive: true });
    await this.computerFs.writeFile(path, content);
  }

  async writeFileBytes(path: string, data: Uint8Array, _mimeType?: string): Promise<void> {
    await this.mkdir(dirName(path), { recursive: true });
    await this.computerFs.writeFileBytes(path, data);
  }

  async appendFile(path: string, content: string, _mimeType?: string): Promise<void> {
    await this.mkdir(dirName(path), { recursive: true });
    await this.computerFs.appendFile(path, content);
  }

  async stat(path: string): Promise<WorkspaceFileInfo | null> {
    try {
      return await this.toInfo(path, await this.computerFs.stat(path));
    } catch (error) {
      if (isWorkspaceFsError(error, "ENOENT")) return null;
      throw error;
    }
  }

  /** Computer VFS has no symlinks, so lstat === stat. */
  async lstat(path: string): Promise<WorkspaceFileInfo | null> {
    return this.stat(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.computerFs.exists(path);
  }

  async fileExists(path: string): Promise<boolean> {
    const info = await this.stat(path);
    return info?.type === "file";
  }

  async deleteFile(path: string): Promise<boolean> {
    if (!(await this.exists(path))) return false;
    await this.computerFs.rm(path, { force: true });
    return true;
  }

  async readDir(
    dir?: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<WorkspaceFileInfo[]> {
    const root = dir ?? "/";
    const entries = await this.computerFs.readdirWithFileTypes(root);
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? entries.length;
    const sliced = entries.slice(offset, offset + limit);
    const out: WorkspaceFileInfo[] = [];
    for (const entry of sliced) {
      const path = root.endsWith("/") ? `${root}${entry.name}` : `${root}/${entry.name}`;
      const info = await this.stat(path);
      if (info) out.push(info);
    }
    return out;
  }

  async glob(pattern: string): Promise<WorkspaceFileInfo[]> {
    const paths = await this.computerFs.glob(pattern);
    const out: WorkspaceFileInfo[] = [];
    for (const path of paths) {
      const info = await this.stat(path);
      if (info) out.push(info);
    }
    return out;
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    // computer's VFS throws EEXIST for the root (it always exists) —
    // shell Workspace tolerated mkdir("/"). Swallow it here.
    if (path === "/" || path === "") return;
    await this.computerFs.mkdir(path, opts);
  }

  async rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
    await this.computerFs.rm(path, opts);
  }

  /** Computer VFS has no symlinks. */
  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw new Error("ENOSYS: symlink not supported by the computer VFS");
  }

  async readlink(_path: string): Promise<string> {
    throw new Error("ENOSYS: readlink not supported by the computer VFS");
  }

  /**
   * Every absolute path in the store (files + directories), root-first,
   * depth-first, sorted within each directory. Replaces shell Workspace's
   * `_getAllPaths()` for snapshot export and the legacy compat copy.
   */
  async getAllPaths(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await this.computerFs.readdirWithFileTypes(dir);
      for (const entry of entries) {
        const path = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;
        out.push(path);
        if (entry.type === "directory") await walk(path);
      }
    };
    await walk("/");
    return out;
  }

  private async toInfo(path: string, stat: {
    type: "file" | "directory" | "symlink";
    size: number;
    mtime: Date;
  }): Promise<WorkspaceFileInfo> {
    return {
      path,
      name: baseName(path),
      type: stat.type,
      mimeType: stat.type === "directory" ? "inode/directory" : mimeForPath(path),
      size: stat.size,
      createdAt: stat.mtime.getTime(),
      updatedAt: stat.mtime.getTime(),
    };
  }
}
