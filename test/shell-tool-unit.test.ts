/**
 * Unit tests for the `shell` tool — computer workspace runtime adapter.
 *
 * These tests exercise `runShellBatch()` with a mock shell runtime that
 * simulates the computer workspace's `runtime.exec()` against an `InMemoryFs`.
 * The behavioural assertions are unchanged from the busyworker era; only
 * the executor mechanics differ (stderr is now separable).
 */
import { InMemoryFs } from "@cloudflare/shell";
import { describe, expect, it } from "vitest";
import { runShellBatch } from "../src/tools/shell";

function freshFs(): InMemoryFs {
  const fs = new InMemoryFs();
  fs.mkdirSync("/", { recursive: true });
  fs.writeFileSync("/README.md", "# hello world\n");
  fs.mkdirSync("/src", { recursive: true });
  fs.writeFileSync("/src/app.ts", "export const x = 1;\n");
  return fs;
}

/** Simple shell tokenizer that respects single quotes. */
function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/** Resolve a shell path relative to cwd, translating /workspace → / for the InMemoryFs. */
function resolvePath(cwd: string, path: string): string {
  let resolved: string;
  if (path.startsWith("/")) {
    resolved = path;
  } else {
    resolved = cwd.endsWith("/") ? cwd + path : `${cwd}/${path}`;
  }
  // The InMemoryFs is mounted at /workspace in the shell; strip the prefix.
  if (resolved.startsWith("/workspace/")) {
    return resolved.slice("/workspace".length) || "/";
  }
  if (resolved === "/workspace") return "/";
  return resolved;
}

/** Convert an InMemoryFs path back to a shell path under /workspace. */
function toShellPath(fsPath: string): string {
  if (fsPath === "/") return "/workspace";
  return "/workspace" + fsPath;
}

/** Minimal mock of the computer workspace runtime for unit tests. */
function createMockRuntime(fs: InMemoryFs) {
  return {
    async exec(source: string, options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; encoding?: "utf8" }) {
      const cwd = options?.cwd ?? "/workspace";
      const { stdout, stderr, exitCode } = await executePipeline(fs, source, cwd);
      return {
        result: async () => ({ stdout, stderr, exitCode }),
        stream: () => new ReadableStream<Uint8Array>(),
        kill: async () => {},
      };
    },
    async getExec() {
      throw new Error("not implemented in mock");
    },
    async killExec() {
      // no-op
    },
    async disposeExec() {
      // no-op
    },
  };
}

async function executePipeline(
  fs: InMemoryFs,
  source: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Split by pipe, but not by quoted pipes
  const commands: string[] = [];
  let current = "";
  let inSingle = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "'" && (i === 0 || source[i - 1] !== "\\")) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === "|" && !inSingle) {
      commands.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) commands.push(current.trim());

  let input = "";
  for (const cmd of commands) {
    const result = await executeOne(fs, cmd, cwd, input);
    if (result.exitCode !== 0) {
      return result;
    }
    input = result.stdout;
  }
  return { stdout: input, stderr: "", exitCode: 0 };
}

async function executeOne(
  fs: InMemoryFs,
  cmd: string,
  cwd: string,
  stdin: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Parse redirections
  let redirectOut: string | null = null;
  let redirectAppend = false;
  let source = cmd;

  const gtIdx = cmd.indexOf(">>");
  if (gtIdx !== -1) {
    redirectOut = cmd.slice(gtIdx + 2).trim();
    redirectAppend = true;
    source = cmd.slice(0, gtIdx).trim();
  } else {
    const singleGt = cmd.indexOf(">");
    if (singleGt !== -1) {
      redirectOut = cmd.slice(singleGt + 1).trim();
      source = cmd.slice(0, singleGt).trim();
    }
  }

  const parts = tokenize(source);
  if (parts.length === 0) return { stdout: "", stderr: "", exitCode: 0 };

  const program = parts[0];
  const args = parts.slice(1);

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  switch (program) {
    case "echo": {
      stdout = args.join(" ") + "\n";
      break;
    }
    case "cat": {
      const inputs: string[] = [];
      if (args.length === 0) {
        inputs.push(stdin);
      } else {
        for (const arg of args) {
          const path = resolvePath(cwd, arg);
          try {
            inputs.push(await fs.readFile(path));
          } catch {
            stderr = `cat: ${arg}: No such file or directory\n`;
            exitCode = 1;
          }
        }
      }
      if (exitCode === 0) stdout = inputs.join("");
      break;
    }
    case "ls": {
      const targets = args.length === 0 ? [cwd] : args.map((a) => resolvePath(cwd, a));
      const lines: string[] = [];
      for (const target of targets) {
        try {
          const st = await fs.stat(target);
          if (st.type === "directory") {
            const entries = await fs.readdir(target);
            lines.push(...entries.map(toShellPath));
          } else {
            lines.push(toShellPath(target));
          }
        } catch {
          stderr = `ls: ${target}: No such file or directory\n`;
          exitCode = 1;
        }
      }
      if (exitCode === 0) stdout = lines.join("\n") + (lines.length > 0 ? "\n" : "");
      break;
    }
    case "find": {
      const dir = args[0] ? resolvePath(cwd, args[0]) : cwd;
      let maxdepth = Infinity;
      let mindepth = 0;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "-maxdepth" && i + 1 < args.length) {
          maxdepth = Number(args[i + 1]);
          i++;
        } else if (args[i] === "-mindepth" && i + 1 < args.length) {
          mindepth = Number(args[i + 1]);
          i++;
        }
      }
      const results: string[] = [];
      async function walk(current: string, depth: number) {
        if (depth > maxdepth) return;
        let entries: Array<{ name: string; type: "file" | "directory" | "symlink" }>;
        try {
          entries = await fs.readdirWithFileTypes(current);
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = current.endsWith("/") ? current + entry.name : `${current}/${entry.name}`;
          if (depth >= mindepth) {
            results.push(toShellPath(full));
          }
          if (entry.type === "directory") {
            await walk(full, depth + 1);
          }
        }
      }
      await walk(dir, 1);
      stdout = results.join("\n") + (results.length > 0 ? "\n" : "");
      break;
    }
    case "sort": {
      const lines = stdin.split("\n").filter((l) => l.length > 0);
      stdout = lines.sort().join("\n") + (lines.length > 0 ? "\n" : "");
      break;
    }
    case "head": {
      let n = 10;
      if (args[0] === "-n" && args[1]) n = Number(args[1]);
      const lines = stdin.split("\n");
      stdout = lines.slice(0, n).join("\n") + (lines.slice(0, n).length > 0 ? "\n" : "");
      break;
    }
    case "grep": {
      // Very basic grep: grep pattern file
      const pattern = args[0] ?? "";
      const file = args[1] ? resolvePath(cwd, args[1]) : null;
      let text = file ? await fs.readFile(file).catch(() => "") : stdin;
      const lines = text.split("\n");
      const matches = lines.filter((l) => l.includes(pattern));
      stdout = matches.join("\n") + (matches.length > 0 ? "\n" : "");
      break;
    }
    case "mkdir": {
      const recursive = args.includes("-p");
      const dirs = args.filter((a) => a !== "-p");
      for (const d of dirs) {
        await fs.mkdir(resolvePath(cwd, d), { recursive });
      }
      break;
    }
    case "rm": {
      const recursive = args.includes("-r");
      const force = args.includes("-f");
      const targets = args.filter((a) => a !== "-r" && a !== "-f");
      for (const t of targets) {
        try {
          await fs.rm(resolvePath(cwd, t), { recursive, force });
        } catch {
          if (!force) {
            stderr = `rm: ${t}: No such file or directory\n`;
            exitCode = 1;
          }
        }
      }
      break;
    }
    case "cp": {
      const recursive = args.includes("-r");
      const targets = args.filter((a) => a !== "-r");
      if (targets.length < 2) {
        stderr = "cp: missing destination\n";
        exitCode = 1;
        break;
      }
      const dest = resolvePath(cwd, targets[targets.length - 1]);
      for (let i = 0; i < targets.length - 1; i++) {
        const src = resolvePath(cwd, targets[i]);
        const st = await fs.stat(src);
        if (st.type === "directory" && !recursive) {
          stderr = `cp: ${targets[i]}: is a directory\n`;
          exitCode = 1;
          break;
        }
        await fs.cp(src, dest, { recursive });
      }
      break;
    }
    case "mv": {
      if (args.length < 2) {
        stderr = "mv: missing destination\n";
        exitCode = 1;
        break;
      }
      const dest = resolvePath(cwd, args[args.length - 1]);
      for (let i = 0; i < args.length - 1; i++) {
        await fs.mv(resolvePath(cwd, args[i]), dest);
      }
      break;
    }
    case "touch": {
      for (const arg of args) {
        const path = resolvePath(cwd, arg);
        if (!(await fs.exists(path))) {
          await fs.writeFile(path, "");
        }
      }
      break;
    }
    case "pwd": {
      stdout = cwd + "\n";
      break;
    }
    case "wc": {
      const text = args.length > 0 ? await fs.readFile(resolvePath(cwd, args[0])).catch(() => "") : stdin;
      const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      const words = text.trim().split(/\s+/).filter((w) => w.length > 0).length;
      const bytes = new TextEncoder().encode(text).length;
      stdout = `  ${lines}  ${words} ${bytes}\n`;
      break;
    }
    default: {
      stderr = `${program}: command not found\n`;
      exitCode = 127;
    }
  }

  if (redirectOut && exitCode === 0) {
    const path = resolvePath(cwd, redirectOut);
    if (redirectAppend) {
      let existing = "";
      try {
        existing = await fs.readFile(path);
      } catch {
        // file doesn't exist yet
      }
      await fs.writeFile(path, existing + stdout);
    } else {
      await fs.writeFile(path, stdout);
    }
    stdout = "";
  }

  return { stdout, stderr, exitCode };
}

describe("shell tool — tracer bullet", () => {
  it("runs `echo hello | cat` through mock shell", async () => {
    const fs = freshFs();
    const runtime = createMockRuntime(fs);
    const result = await runShellBatch(runtime as any, {
      commands: ["echo hello | cat"],
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].exit).toBe(0);
    expect(result.results[0].stdout).toBe("hello\n");
  });

  it("lists /workspace contents via `ls`", async () => {
    const fs = freshFs();
    const runtime = createMockRuntime(fs);
    const result = await runShellBatch(runtime as any, {
      commands: ["ls /workspace"],
    });
    expect(result.results[0].exit).toBe(0);
    expect(result.results[0].stdout).toContain("README.md");
    expect(result.results[0].stdout).toContain("src");
  });

  it("reads file contents via `cat /workspace/<path>`", async () => {
    const fs = freshFs();
    const runtime = createMockRuntime(fs);
    const result = await runShellBatch(runtime as any, {
      commands: ["cat /workspace/README.md"],
    });
    expect(result.results[0].exit).toBe(0);
    expect(result.results[0].stdout).toBe("# hello world\n");
  });

  it("descends into subdirectories", async () => {
    const fs = freshFs();
    const runtime = createMockRuntime(fs);
    const result = await runShellBatch(runtime as any, {
      commands: ["cat /workspace/src/app.ts"],
    });
    expect(result.results[0].exit).toBe(0);
    expect(result.results[0].stdout).toBe("export const x = 1;\n");
  });

  it("writes new files back through the adapter", async () => {
    const fs = freshFs();
    const runtime = createMockRuntime(fs);
    const result = await runShellBatch(runtime as any, {
      commands: ["echo 'a note' > /workspace/note.txt"],
    });
    expect(result.results[0].exit).toBe(0);
    const written = await fs.readFile("/note.txt");
    expect(written).toBe("a note\n");
  });

  it("runs multiple commands in one tool call, sharing the output budget", async () => {
    const fs = freshFs();
    const runtime = createMockRuntime(fs);
    const result = await runShellBatch(runtime as any, {
      commands: ["echo first", "echo second", "cat /workspace/README.md"],
    });
    expect(result.results).toHaveLength(3);
    expect(result.results.map((r) => r.exit)).toEqual([0, 0, 0]);
    expect(result.results[0].stdout).toBe("first\n");
    expect(result.results[1].stdout).toBe("second\n");
    expect(result.results[2].stdout).toBe("# hello world\n");
  });

  it("reports a non-zero exit code for failed commands without aborting the batch", async () => {
    const fs = freshFs();
    const runtime = createMockRuntime(fs);
    const result = await runShellBatch(runtime as any, {
      commands: ["ls /workspace/this-does-not-exist", "echo still-here"],
    });
    expect(result.results[0].exit).not.toBe(0);
    expect(result.results[1].exit).toBe(0);
    expect(result.results[1].stdout).toBe("still-here\n");
  });

  it("path translation: fs `/foo` is shell `/workspace/foo` (no double prefix)", async () => {
    const fs = freshFs();
    fs.writeFileSync("/at-root.txt", "i live at /\n");
    fs.mkdirSync("/workspace", { recursive: true });
    fs.writeFileSync("/workspace/nested.txt", "i live at /workspace\n");

    const runtime = createMockRuntime(fs);
    const result = await runShellBatch(runtime as any, {
      commands: ["cat /workspace/at-root.txt", "cat /workspace/workspace/nested.txt"],
    });
    expect(result.results[0].exit).toBe(0);
    expect(result.results[0].stdout).toBe("i live at /\n");
    expect(result.results[1].exit).toBe(0);
    expect(result.results[1].stdout).toBe("i live at /workspace\n");
  });

  it("composes pipelines that use multiple commands", async () => {
    const fs = freshFs();
    const runtime = createMockRuntime(fs);
    const result = await runShellBatch(runtime as any, {
      commands: ["find /workspace -maxdepth 1 -mindepth 1 | sort"],
    });
    expect(result.results[0].exit).toBe(0);
    const lines = result.results[0].stdout.trim().split("\n");
    expect(lines).toEqual(["/workspace/README.md", "/workspace/src"]);
  });
});
