/**
 * Unit tests for the `shell` tool — busybox.wasm + WorkspaceFs adapter.
 *
 * These tests boot a real Machine per command via `runShellBatch()` with an
 * `InMemoryFs` mounted at `/workspace`. No DO, no R2 — just the in-isolate
 * pipeline. If these pass, the adapter shape is right and the agent will
 * see what the tests see.
 *
 * Coverage of the WS1 tracer bullet:
 *   - `echo hello | cat` — pipelines + shell builtins
 *   - `ls -la /workspace` — read-path against the mounted fs
 *   - `cat /workspace/README.md` — file body fetch through the adapter
 *   - `echo new > /workspace/note.txt && cat /workspace/note.txt` — writes
 *     flush back through writeFileBytes on close
 *
 * The tests are deliberately slow-ish (each command spins up a fresh
 * Machine, ~50–200 ms cold path) — they live in their own file so a
 * developer iterating on unrelated code isn't paying the cost.
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

describe("shell tool — tracer bullet", () => {
  it("runs `echo hello | cat` through busybox sh", async () => {
    const fs = freshFs();
    const result = await runShellBatch(fs, {
      commands: ["echo hello | cat"],
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].exit).toBe(0);
    expect(result.results[0].stdout).toBe("hello\n");
  });

  it("lists /workspace contents via `ls -la`", async () => {
    const fs = freshFs();
    const result = await runShellBatch(fs, {
      commands: ["ls /workspace"],
    });
    expect(result.results[0].exit).toBe(0);
    // `ls` without -l on busybox prints names one per line (or columnar
    // depending on the build). Either way both entries must appear.
    expect(result.results[0].stdout).toContain("README.md");
    expect(result.results[0].stdout).toContain("src");
  });

  it("reads file contents via `cat /workspace/<path>`", async () => {
    const fs = freshFs();
    const result = await runShellBatch(fs, {
      commands: ["cat /workspace/README.md"],
    });
    expect(result.results[0].exit).toBe(0);
    expect(result.results[0].stdout).toBe("# hello world\n");
  });

  it("descends into subdirectories", async () => {
    const fs = freshFs();
    const result = await runShellBatch(fs, {
      commands: ["cat /workspace/src/app.ts"],
    });
    expect(result.results[0].exit).toBe(0);
    expect(result.results[0].stdout).toBe("export const x = 1;\n");
  });

  it("writes new files back through the adapter", async () => {
    const fs = freshFs();
    const result = await runShellBatch(fs, {
      commands: ["echo 'a note' > /workspace/note.txt"],
    });
    expect(result.results[0].exit).toBe(0);
    // After the command, the InMemoryFs should hold the new file —
    // proves writes flushed via writeFileBytes() on close.
    const written = await fs.readFile("/note.txt");
    expect(written).toBe("a note\n");
  });

  it("runs multiple commands in one tool call, sharing the output budget", async () => {
    const fs = freshFs();
    const result = await runShellBatch(fs, {
      commands: [
        "echo first",
        "echo second",
        "cat /workspace/README.md",
      ],
    });
    expect(result.results).toHaveLength(3);
    expect(result.results.map((r) => r.exit)).toEqual([0, 0, 0]);
    expect(result.results[0].stdout).toBe("first\n");
    expect(result.results[1].stdout).toBe("second\n");
    expect(result.results[2].stdout).toBe("# hello world\n");
  });

  it("reports a non-zero exit code for failed commands without aborting the batch", async () => {
    const fs = freshFs();
    const result = await runShellBatch(fs, {
      commands: [
        "ls /workspace/this-does-not-exist",
        "echo still-here",
      ],
    });
    expect(result.results[0].exit).not.toBe(0);
    expect(result.results[1].exit).toBe(0);
    expect(result.results[1].stdout).toBe("still-here\n");
  });

  it("path translation: fs `/foo` is shell `/workspace/foo` (no double prefix)", async () => {
    // This test documents the path-translation contract that bit a real
    // session: the agent wrote to `/workspace/probe.txt` thinking that
    // would match shell's `/workspace/probe.txt`. Result: file ended up
    // at workspace path `/workspace/probe.txt`, visible to shell as
    // `/workspace/workspace/probe.txt`. Confusing.
    //
    // The contract: write-tool paths and shell-tool paths sit on opposite
    // sides of the mount. The shell mount prepends `/workspace` to every
    // workspace path. So:
    //
    //   write({ path: "/foo" })            → workspace path /foo
    //                                       → shell sees /workspace/foo  ✓
    //   write({ path: "/workspace/foo" }) → workspace path /workspace/foo
    //                                       → shell sees /workspace/workspace/foo  ✗ surprise!
    //
    // The system prompt + tool description must spell this out. This test
    // pins the underlying behaviour so a future refactor doesn't silently
    // change it.
    const fs = freshFs();
    fs.writeFileSync("/at-root.txt", "i live at /\n");
    fs.mkdirSync("/workspace", { recursive: true });
    fs.writeFileSync("/workspace/nested.txt", "i live at /workspace\n");

    const result = await runShellBatch(fs, {
      commands: [
        "cat /workspace/at-root.txt",
        "cat /workspace/workspace/nested.txt",
      ],
    });
    expect(result.results[0].exit).toBe(0);
    expect(result.results[0].stdout).toBe("i live at /\n");
    expect(result.results[1].exit).toBe(0);
    expect(result.results[1].stdout).toBe("i live at /workspace\n");
  });

  it("composes pipelines that use multiple busybox applets", async () => {
    const fs = freshFs();
    // Use `find` so each entry lands on its own line — busybox `ls`
    // without `-1` packs entries into columns depending on TTY width.
    const result = await runShellBatch(fs, {
      commands: ["find /workspace -maxdepth 1 -mindepth 1 | sort"],
    });
    expect(result.results[0].exit).toBe(0);
    const lines = result.results[0].stdout.trim().split("\n");
    expect(lines).toEqual([
      "/workspace/README.md",
      "/workspace/src",
    ]);
  });
});
