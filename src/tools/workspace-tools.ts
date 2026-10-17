/**
 * File tools over the session workspace: read, write, edit, list, find,
 * grep, delete. Ported from @cloudflare/think's workspace tools (MIT) with
 * the same names, descriptions and input schemas, so models see no change.
 * Typed against small ops interfaces instead of shell's Workspace class.
 */
import { tool } from "ai";
import { z } from "zod";

export interface FileStat {
  type: "file" | "directory" | "symlink" | string;
  size?: number;
}
export interface DirEntry {
  name: string;
  type: "file" | "directory" | "symlink" | string;
  size: number;
}
export interface GlobEntry {
  path: string;
  type: "file" | "directory" | "symlink" | string;
  size: number;
}

export interface ReadOperations {
  readFile(path: string): Promise<string | null>;
  stat(path: string): Promise<FileStat | null>;
}
export interface WriteOperations {
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
}
export interface EditOperations {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
}
export interface ListOperations {
  readDir(dir: string, opts?: { limit?: number; offset?: number }): Promise<DirEntry[]>;
}
export interface FindOperations {
  glob(pattern: string): Promise<GlobEntry[]>;
}
export interface GrepOperations {
  glob(pattern: string): Promise<GlobEntry[]>;
  readFile(path: string): Promise<string | null>;
}
export interface DeleteOperations {
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

/** Everything the full tool set needs from a workspace. */
export type WorkspaceOperations = ReadOperations & WriteOperations & ListOperations & FindOperations & DeleteOperations;

export function createWorkspaceTools(ws: WorkspaceOperations) {
  return {
    read: createReadTool({ ops: ws }),
    write: createWriteTool({ ops: ws }),
    edit: createEditTool({ ops: ws }),
    list: createListTool({ ops: ws }),
    find: createFindTool({ ops: ws }),
    grep: createGrepTool({ ops: ws }),
    delete: createDeleteTool({ ops: ws }),
  };
}

const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 2000;

export function createReadTool({ ops }: { ops: ReadOperations }) {
  return tool({
    description:
      "Read the contents of a file. Returns the file content with line numbers. Use offset and limit for large files. Returns null if the file does not exist.",
    inputSchema: z.object({
      path: z.string().describe("Absolute path to the file"),
      offset: z.number().int().min(1).optional().describe("1-indexed line number to start reading from"),
      limit: z.number().int().min(1).optional().describe("Number of lines to read"),
    }),
    execute: async ({ path, offset, limit }) => {
      const stat = await ops.stat(path);
      if (!stat) return { error: `File not found: ${path}` };
      if (stat.type === "directory") return { error: `${path} is a directory, not a file` };
      const content = await ops.readFile(path);
      if (content === null) return { error: `Could not read file: ${path}` };
      const allLines = content.split("\n");
      const totalLines = allLines.length;
      const startLine = offset ? offset - 1 : 0;
      const endLine = limit ? startLine + limit : allLines.length;
      const numbered = allLines
        .slice(startLine, endLine)
        .map((line, i) => `${startLine + i + 1}\t${line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}... (truncated)` : line}`);
      const output =
        numbered.length > MAX_LINES
          ? `${numbered.slice(0, MAX_LINES).join("\n")}\n... (${numbered.length - MAX_LINES} more lines truncated)`
          : numbered.join("\n");
      const result: { path: string; content: string; totalLines: number; fromLine?: number; toLine?: number } = { path, content: output, totalLines };
      if (offset || limit) {
        result.fromLine = startLine + 1;
        result.toLine = Math.min(endLine, totalLines);
      }
      return result;
    },
  });
}

export function createWriteTool({ ops }: { ops: WriteOperations }) {
  return tool({
    description:
      "Write content to a file. Creates the file if it does not exist, overwrites if it does. Parent directories are created automatically.",
    inputSchema: z.object({
      path: z.string().describe("Absolute path to the file"),
      content: z.string().describe("Content to write to the file"),
    }),
    execute: async ({ path, content }) => {
      const parent = path.replace(/\/[^/]+$/, "");
      if (parent && parent !== "/") await ops.mkdir(parent, { recursive: true });
      await ops.writeFile(path, content);
      return { path, bytesWritten: new TextEncoder().encode(content).byteLength, lines: content.split("\n").length };
    },
  });
}

export function createEditTool({ ops }: { ops: EditOperations }) {
  return tool({
    description:
      "Make a targeted edit to a file by replacing an exact string match. Provide the old_string to find and new_string to replace it with. The old_string must match exactly (including whitespace and indentation). Use an empty old_string with new_string to create a new file.",
    inputSchema: z.object({
      path: z.string().describe("Absolute path to the file"),
      old_string: z.string().describe("Exact text to find and replace. Empty string to create a new file."),
      new_string: z.string().describe("Replacement text"),
    }),
    execute: async ({ path, old_string, new_string }) => {
      if (old_string === "") {
        if ((await ops.readFile(path)) !== null) {
          return { error: "File already exists. Provide old_string to edit, or use the write tool to overwrite." };
        }
        await ops.writeFile(path, new_string);
        return { path, created: true, lines: new_string.split("\n").length };
      }
      const content = await ops.readFile(path);
      if (content === null) return { error: `File not found: ${path}` };
      const occurrences = countOccurrences(content, old_string);
      if (occurrences === 0) {
        const fuzzy = fuzzyReplace(content, old_string, new_string);
        if (fuzzy === "ambiguous") {
          return { error: "old_string matches multiple locations after whitespace normalization. Include more surrounding context to make the match unique." };
        }
        if (fuzzy !== null) {
          await ops.writeFile(path, fuzzy);
          return { path, replaced: true, fuzzyMatch: true, lines: fuzzy.split("\n").length };
        }
        return { error: "old_string not found in file. Make sure it matches exactly, including whitespace and indentation. Read the file first to verify." };
      }
      if (occurrences > 1) {
        return { error: `old_string appears ${occurrences} times in the file. Include more surrounding context to make the match unique.` };
      }
      // Function replacement: `$&` etc. in new_string must stay literal.
      const next = content.replace(old_string, () => new_string);
      await ops.writeFile(path, next);
      return { path, replaced: true, lines: next.split("\n").length };
    },
  });
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  for (let pos = text.indexOf(search); pos !== -1; pos = text.indexOf(search, pos + 1)) count++;
  return count;
}

/** Match with runs of spaces/tabs collapsed and CRLF as LF; replace the matching original region. */
export function fuzzyReplace(content: string, oldStr: string, newStr: string): string | null | "ambiguous" {
  const normContent = normalizeWhitespace(content);
  const normSearch = normalizeWhitespace(oldStr);
  if (!normSearch) return null;
  const idx = normContent.indexOf(normSearch);
  if (idx === -1) return null;
  if (normContent.indexOf(normSearch, idx + normSearch.length) !== -1) return "ambiguous";
  const start = mapToOriginal(content, idx);
  const end = mapToOriginal(content, idx + normSearch.length);
  return content.slice(0, start) + newStr + content.slice(end);
}

function normalizeWhitespace(s: string): string {
  return s.replace(/[ \t]+/g, " ").replace(/\r\n/g, "\n");
}

function mapToOriginal(original: string, normalizedPos: number): number {
  let ni = 0;
  let oi = 0;
  while (ni < normalizedPos && oi < original.length) {
    const oc = original[oi];
    if (oc === "\r" && original[oi + 1] === "\n") {
      oi += 2;
      ni += 1;
    } else if (oc === " " || oc === "\t") {
      oi++;
      while (oi < original.length && (original[oi] === " " || original[oi] === "\t")) oi++;
      ni++;
    } else {
      oi++;
      ni++;
    }
  }
  return oi;
}

export function createListTool({ ops }: { ops: ListOperations }) {
  return tool({
    description: "List files and directories in a given path. Returns names, types, and sizes for each entry.",
    inputSchema: z.object({
      path: z.string().default("/").describe("Absolute path to the directory to list"),
      limit: z.number().int().min(1).max(1000).optional().describe("Maximum number of entries to return (default: 200)"),
      offset: z.number().int().min(0).optional().describe("Number of entries to skip (for pagination)"),
    }),
    execute: async ({ path, limit, offset }) => {
      const entries = await ops.readDir(path, { limit: limit ?? 200, offset: offset ?? 0 });
      const formatted = entries.map((e) => `${e.name}${e.type === "directory" ? "/" : ""}${e.type === "file" ? ` (${formatSize(e.size)})` : ""}`);
      return { path, count: entries.length, entries: formatted };
    },
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MAX_FIND_RESULTS = 200;

export function createFindTool({ ops }: { ops: FindOperations }) {
  return tool({
    description:
      "Find files matching a glob pattern. Supports standard glob syntax: * matches any file, ** matches directories recursively, ? matches a single character. Returns matching file paths with types and sizes.",
    inputSchema: z.object({
      pattern: z.string().describe('Glob pattern to match (e.g. "**/*.ts", "src/**/*.test.ts", "*.md")'),
    }),
    execute: async ({ pattern }) => {
      const matches = await ops.glob(pattern);
      const result: { pattern: string; count: number; files: string[]; truncated?: boolean; showing?: number } = {
        pattern,
        count: matches.length,
        files: matches.slice(0, MAX_FIND_RESULTS).map((e) => `${e.path}${e.type === "directory" ? "/" : ""}`),
      };
      if (matches.length > MAX_FIND_RESULTS) {
        result.truncated = true;
        result.showing = MAX_FIND_RESULTS;
      }
      return result;
    },
  });
}

const MAX_MATCHES = 200;
const MAX_GREP_FILE_SIZE = 1024 * 1024;

export function createGrepTool({ ops }: { ops: GrepOperations }) {
  return tool({
    description:
      "Search file contents using a regular expression or fixed string. Returns matching lines with file paths and line numbers. Searches all files matching the include glob, or all files if not specified.",
    inputSchema: z.object({
      query: z.string().describe("Search pattern (regex or fixed string)"),
      include: z.string().optional().describe('Glob pattern to filter files (e.g. "**/*.ts"). Defaults to "**/*"'),
      fixedString: z.boolean().optional().describe("If true, treat query as a literal string instead of regex"),
      caseSensitive: z.boolean().optional().describe("If true, search is case-sensitive (default: false)"),
      contextLines: z.number().int().min(0).max(10).optional().describe("Number of context lines around each match (default: 0)"),
    }),
    execute: async ({ query, include, fixedString, caseSensitive, contextLines }) => {
      const files = (await ops.glob(include ?? "**/*")).filter((f) => f.type === "file");
      let regex: RegExp;
      try {
        regex = new RegExp(fixedString ? escapeRegex(query) : query, caseSensitive ? "g" : "gi");
      } catch {
        return { error: `Invalid regex: ${query}` };
      }
      const ctx = contextLines ?? 0;
      const matches: Array<{ file: string; line: number; text: string; context?: string[] }> = [];
      let totalMatches = 0;
      let filesSearched = 0;
      let filesWithMatches = 0;
      let filesSkipped = 0;
      for (const file of files) {
        if (totalMatches >= MAX_MATCHES) break;
        if (file.size > MAX_GREP_FILE_SIZE) {
          filesSkipped++;
          continue;
        }
        const content = await ops.readFile(file.path);
        if (content === null) continue;
        filesSearched++;
        const lines = content.split("\n");
        let fileHasMatch = false;
        for (let i = 0; i < lines.length && totalMatches < MAX_MATCHES; i++) {
          regex.lastIndex = 0;
          if (!regex.test(lines[i]!)) continue;
          if (!fileHasMatch) {
            fileHasMatch = true;
            filesWithMatches++;
          }
          totalMatches++;
          const match: (typeof matches)[number] = { file: file.path, line: i + 1, text: lines[i]! };
          if (ctx > 0) {
            const start = Math.max(0, i - ctx);
            const end = Math.min(lines.length, i + ctx + 1);
            match.context = lines.slice(start, end).map((l, j) => {
              const n = start + j + 1;
              return `${n === i + 1 ? ">" : " "} ${n}\t${l}`;
            });
          }
          matches.push(match);
        }
      }
      const result: {
        query: string;
        filesSearched: number;
        filesWithMatches: number;
        totalMatches: number;
        matches: Array<string | { file: string; line: number; context: string }>;
        truncated?: boolean;
        filesSkipped?: number;
        note?: string;
      } = {
        query,
        filesSearched,
        filesWithMatches,
        totalMatches,
        matches: matches.map((m) => (m.context ? { file: m.file, line: m.line, context: m.context.join("\n") } : `${m.file}:${m.line}: ${m.text}`)),
      };
      if (totalMatches >= MAX_MATCHES) result.truncated = true;
      if (filesSkipped > 0) {
        result.filesSkipped = filesSkipped;
        result.note = `${filesSkipped} file(s) skipped (larger than 1 MB)`;
      }
      return result;
    },
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createDeleteTool({ ops }: { ops: DeleteOperations }) {
  return tool({
    description: "Delete a file or directory. Set recursive to true to remove non-empty directories.",
    inputSchema: z.object({
      path: z.string().describe("Absolute path to the file or directory"),
      recursive: z.boolean().optional().describe("If true, remove directories and their contents recursively"),
    }),
    execute: async ({ path, recursive }) => {
      await ops.rm(path, { recursive, force: true });
      return { deleted: path };
    },
  });
}
