// `shell` tool — sandboxed busybox shell against the session Workspace.
//
// Built on top of the vendored `@busyworker/core` runtime (see
// `src/runtime/busyworker/`). Each call spins up a fresh Machine inside
// the host worker, mounts the workspace at `/workspace`, runs the
// requested commands via `sh -c`, and returns the captured stdout +
// stderr + exit code as JSON. The Machine lifetime is the tool call; no
// persistent process or fd state between calls.
//
// Why this exists alongside `codemode`:
//   - codemode = JS in a fresh dynamic Worker, great for API-shaped work.
//   - shell    = pipelines, redirection, busybox applets. A single
//     `rg TODO | head` is one tool call, one LLM turn, ~10 tokens of
//     command + bounded stdout — vs three codemode round-trips.
//
// Scope of WS1:
//   - busybox only (sh + coreutils applets baked into busybox.wasm).
//   - Workspace mounted read+write at /workspace (writes flush on file
//     close via the WorkspaceFs adapter).
//   - No network outbound, no R2 artifact mount, no WASI extras (rg /
//     jq / ffmpeg arrive in later workstreams).
//   - One isolate per call. No sticky state between calls.

import { tool, zodSchema } from "ai";
import type { Workspace } from "@cloudflare/shell";
import { WorkspaceFileSystem } from "@cloudflare/shell";
import { z } from "zod";

import BUSYBOX_MODULE from "../../vendor/wasm/busybox/busybox.wasm";
import INITRAMFS_MODULE from "../../vendor/wasm/busybox/initramfs.wasm";
import { Machine, ProgramRegistry } from "../runtime/busyworker/index.js";
import { mountWorkspaceFs, type WorkspaceFsLike } from "../runtime/shell/workspace-fs.js";

/** Module-scope ProgramRegistry — one per isolate, shared across calls. */
let programsCache: ProgramRegistry | null = null;
function getPrograms(): ProgramRegistry {
  if (!programsCache) {
    programsCache = new ProgramRegistry({
      defaultProgram: { module: BUSYBOX_MODULE as WebAssembly.Module, abi: "linux" },
      programs: [],
    });
  }
  return programsCache;
}

/** Hard ceiling on combined stdout+stderr returned to the LLM per call. */
const DEFAULT_MAX_OUTPUT_BYTES = 32_000;
/** Hard wall-clock budget per shell tool call. Workers' CPU ceiling sits
 *  above this for paid plans; we keep the tool's own gate well below the
 *  full request budget so a runaway loop doesn't burn the whole request. */
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_COMMANDS = 16;

interface CommandResult {
  cmd: string;
  exit: number | string;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated?: boolean;
}

interface ShellResult {
  results: CommandResult[];
  totalMs: number;
  truncated?: boolean;
}

interface RunOneOpts {
  cmd: string;
  cwd: string;
  envp: string[];
  timeoutMs: number;
  fs: WorkspaceFsLike;
  maxOutputBytes: number;
}

/**
 * Run a single shell command in a freshly-instantiated Machine. Returns
 * the captured stdout + stderr + exit code. Each call gets a clean
 * Machine — no shared state across commands.
 *
 * This is the building block; the `shell` tool wraps multiple commands
 * into one tool call so the LLM amortises the per-Machine setup cost
 * across a small batch.
 */
async function runOne(opts: RunOneOpts): Promise<CommandResult> {
  const { cmd, cwd, envp, timeoutMs, fs, maxOutputBytes } = opts;
  const stdout: number[] = [];
  const stderr: number[] = [];
  const t0 = Date.now();

  // The Machine drives a TTY by default. We override `tty.write` post-
  // setupFs so stdout from the spawned process lands in our byte
  // buffers instead of a WebSocket. stderr inside busybox is wired to
  // the same TTY by default — we split via a second fd swap below.
  //
  // Note: capturing stderr separately requires a second char device
  // because the default fd 2 -> /dev/console. The simplest approach is
  // to spawn `sh -c "(<cmd>) 2>/dev/stderr"` … but `/dev/stderr` in
  // this VFS is just the console too. For WS1 we accept that stderr
  // appears in `stdout` and leave `stderr` empty unless we hit a
  // pre-spawn error. A future iteration can wire a Pipe to fd 2 the
  // same way handleTestPipe wires the pipe between two processes.
  const machine = new Machine({
    wsSend: () => {
      /* unused — we override tty.write before spawning */
    },
    log: () => {
      /* drop host-side diagnostics; surface via the result on error */
    },
    programs: getPrograms(),
    initramfs: INITRAMFS_MODULE as WebAssembly.Module,
  });

  machine.setupFs();

  // Cap captured output. Once we exceed `maxOutputBytes`, drop further
  // writes silently — the process keeps running, but we won't ship the
  // overflow back to the LLM. The `truncated` flag in the result flags
  // this so the model knows to narrow its query.
  let truncated = false;
  machine.tty.write = (u8mem, buf, count) => {
    if (truncated) return count; // consume but drop
    const remaining = maxOutputBytes - stdout.length;
    if (remaining <= 0) {
      truncated = true;
      return count;
    }
    const n = Math.min(count, remaining);
    for (let i = 0; i < n; i++) stdout.push(u8mem[buf + i]);
    if (count > n) truncated = true;
    return count;
  };

  // Mount the workspace under `/workspace` (writable). The adapter
  // splices a dynamic directory node into the VFS root; the kernel will
  // await `preload()` before any path-resolving syscall touches it.
  try {
    mountWorkspaceFs(machine.vfs, "/workspace", fs, {
      writable: true,
      log: () => {
        /* mount errors are non-fatal here — surface via the command's
         * own exit / stderr if anything actually fails on use. */
      },
    });
  } catch (e: unknown) {
    return {
      cmd,
      exit: "MOUNT_ERROR",
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - t0,
    };
  }

  const proc = machine.spawn({
    argv: ["sh", "-c", cmd],
    envp,
    fdEntries: machine.initialFdEntries,
    cwd,
    parentPid: 0,
  });

  const code = await Promise.race<number | string>([
    proc.exitedPromise,
    new Promise<string>((r) => setTimeout(() => r("TIMEOUT"), timeoutMs)),
  ]);

  return {
    cmd,
    exit: code,
    stdout: new TextDecoder().decode(new Uint8Array(stdout)),
    stderr: new TextDecoder().decode(new Uint8Array(stderr)),
    durationMs: Date.now() - t0,
    ...(truncated ? { truncated: true } : {}),
  };
}

const SHELL_INPUT = z.object({
  commands: z
    .array(z.string().min(1).max(8_000))
    .min(1)
    .max(MAX_COMMANDS)
    .describe(
      "Shell commands to run. Each runs via `sh -c <cmd>` in a fresh isolate. Pipes (`|`), redirection (`>`, `>>`), `&&`/`||`, subshells (`$(…)`), heredocs all work. Each command runs in a separate isolate — no shared shell state between commands.",
    ),
  cwd: z
    .string()
    .optional()
    .describe(
      "Working directory for the shell. Defaults to `/workspace`. Must start with `/`.",
    ),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Extra environment variables. Merged on top of the defaults (PATH, HOME, TERM=dumb).",
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(60_000)
    .optional()
    .describe(
      "Per-command wall-clock timeout. Defaults to 25 000 ms. If the timeout fires, that command's exit is reported as the string `\"TIMEOUT\"` and remaining commands still run.",
    ),
});

/**
 * Execute a batch of shell commands against `fs` mounted at `/workspace`.
 * Used by the AI-SDK tool wrapper and by tests directly (with InMemoryFs).
 */
export async function runShellBatch(
  fs: WorkspaceFsLike,
  input: z.infer<typeof SHELL_INPUT>,
): Promise<ShellResult> {
  const cwd = input.cwd ?? "/workspace";
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const envObj: Record<string, string> = {
    HOME: "/",
    PATH: "/bin:/sbin:/usr/bin:/usr/sbin",
    TERM: "dumb",
    ...(input.env ?? {}),
  };
  const envp = Object.entries(envObj).map(([k, v]) => `${k}=${v}`);

  const t0 = Date.now();
  const results: CommandResult[] = [];
  let remainingBudget = DEFAULT_MAX_OUTPUT_BYTES;
  let anyTruncated = false;
  for (const cmd of input.commands) {
    const res = await runOne({
      cmd,
      cwd,
      envp,
      timeoutMs,
      fs,
      maxOutputBytes: Math.max(0, remainingBudget),
    });
    results.push(res);
    remainingBudget -= res.stdout.length + res.stderr.length;
    if (res.truncated) anyTruncated = true;
  }
  return {
    results,
    totalMs: Date.now() - t0,
    ...(anyTruncated ? { truncated: true } : {}),
  };
}

/**
 * Build the `shell` tool. Lives alongside (not instead of) `codemode`:
 *
 *   - shell    → POSIX pipelines + busybox applets against /workspace
 *   - codemode → JS in a sandboxed dynamic Worker for API-shaped work
 *
 * The tool description is the agent-facing surface. Keep it dense — every
 * line costs context on every session that has shell enabled.
 */
export function createShellTool(workspace: Workspace) {
  return tool({
    description: [
      "Run busybox shell commands against the session workspace.",
      "",
      "Each call boots a fresh sandbox with the workspace mounted at `/workspace` (read+write). File changes flush back to the Workspace on close. Use for file-shaped work that's awkward in `codemode`:",
      "",
      "- pipelines: `cat /workspace/foo | wc -l`, `find /workspace -name '*.ts' | head`, `grep -r TODO /workspace/src | head -20`",
      "- redirection: `echo bar > /workspace/notes.txt`, `cmd 2>&1 | tee /workspace/log`",
      "- archive ops: `tar tzf /workspace/release.tgz | head`",
      "",
      "**Path translation — read carefully.** The `write`/`read`/`edit` tools use workspace paths starting with `/`. `shell` mounts the workspace at `/workspace`. So a file created by `write({ path: \"/foo.txt\" })` is visible to shell as `/workspace/foo.txt`. **Do NOT pass `/workspace/foo` to `write` — that creates a nested file.** Just `/foo`.",
      "",
      "What's available inside the shell:",
      "",
      "- `sh` (busybox's `hush`), all standard coreutils applets: `cat`, `ls`, `cp`, `mv`, `rm`, `mkdir`, `find`, `grep`, `sed`, `awk`, `head`, `tail`, `wc`, `sort`, `uniq`, `tr`, `cut`, `xargs`, `tar`, `gzip`. Run `busybox --list` from the shell to see the full set.",
      "- `/workspace` — your session workspace, read+write. Default cwd. Use absolute paths under it (`/workspace/...`).",
      "- `/tmp` — in-memory scratch space, wiped when the call returns.",
      "- `/dev/null`, `/dev/zero`, `/dev/urandom`.",
      "",
      "What's NOT available (yet):",
      "",
      "- `npm`, `node`, `python`, `git`, `tsc`, real test runners. Use the `typecheck` tool for tsc; use `codemode` + `git.*` for git ops.",
      "- network (no `wget`, no `curl` over TLS). Use `codemode` if you need a `fetch()`.",
      "- persistent state between calls. Each call gets a fresh isolate. File changes under `/workspace` persist (they hit the real Workspace); everything else is gone.",
      "",
      "Output is capped at 32 KB combined across all commands. stdout and stderr currently merge into `stdout` (a future iteration will split them). If you hit `truncated: true`, narrow — `grep -m 20`, `head`, `find … -maxdepth 2`.",
      "",
      "Typical use:",
      "",
      "```",
      "shell({ commands: [\"ls -la /workspace\", \"grep -rn 'TODO' /workspace/src | head -20\"] })",
      "```",
    ].join("\n"),
    inputSchema: zodSchema(SHELL_INPUT),
    execute: (input: z.infer<typeof SHELL_INPUT>): Promise<ShellResult> =>
      runShellBatch(new WorkspaceFileSystem(workspace), input),
  });
}
