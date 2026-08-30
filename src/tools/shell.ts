// `shell` tool — sandboxed shell against the session workspace via
// @cloudflare/computer's WorkerShellBackend.
//
// Each call routes to `ws.runtime.exec()` which runs the command in a
// fresh dynamic Worker with the workspace mounted at `/workspace`.
// The shell state (cwd, env exports) does not persist between calls —
// each command is independent.
//
// Why this exists alongside `codemode`:
//   - codemode = JS in a fresh dynamic Worker, great for API-shaped work.
//   - shell    = pipelines, redirection, coreutils. A single
//     `rg TODO | head` is one tool call, one LLM turn, ~10 tokens of
//     command + bounded stdout.

import type { WorkspaceRuntimeClient } from "@cloudflare/computer";
import { tool, zodSchema } from "ai";
import { z } from "zod";

/** Hard ceiling on combined stdout+stderr returned to the LLM per call. */
const DEFAULT_MAX_OUTPUT_BYTES = 32_000;
/** Hard wall-clock budget per shell tool call. */
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
 * Run a single shell command via the computer workspace runtime.
 */
async function runOne(
  runtime: WorkspaceRuntimeClient,
  cmd: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<CommandResult> {
  const t0 = Date.now();

  const handle = await runtime.exec(cmd, {
    cwd,
    timeoutMs,
    env,
    encoding: "utf8",
  });

  const result = await handle.result();

  // Apply output budget
  let stdout = result.stdout;
  let stderr = result.stderr;
  let truncated = false;

  const totalLen = stdout.length + stderr.length;
  if (totalLen > maxOutputBytes) {
    if (stdout.length >= maxOutputBytes) {
      stdout = stdout.slice(0, maxOutputBytes);
      stderr = "";
    } else {
      stderr = stderr.slice(0, maxOutputBytes - stdout.length);
    }
    truncated = true;
  }

  return {
    cmd,
    exit: result.exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - t0,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * Execute a batch of shell commands against the computer workspace runtime.
 * Used by the AI-SDK tool wrapper and by tests directly.
 */
export async function runShellBatch(
  runtime: WorkspaceRuntimeClient,
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

  const t0 = Date.now();
  const results: CommandResult[] = [];
  let remainingBudget = DEFAULT_MAX_OUTPUT_BYTES;
  let anyTruncated = false;

  for (const cmd of input.commands) {
    const res = await runOne(runtime, cmd, cwd, envObj, timeoutMs, Math.max(0, remainingBudget));
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
 *   - shell    → POSIX pipelines + coreutils against /workspace
 *   - codemode → JS in a sandboxed dynamic Worker for API-shaped work
 *
 * The tool description is the agent-facing surface. Keep it dense — every
 * line costs context on every session that has shell enabled.
 */
export function createShellTool(runtime: WorkspaceRuntimeClient) {
  return tool({
    description: [
      "Run shell commands against the session workspace.",
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
      "- `sh` (hush), all standard coreutils applets: `cat`, `ls`, `cp`, `mv`, `rm`, `mkdir`, `find`, `grep`, `sed`, `awk`, `head`, `tail`, `wc`, `sort`, `uniq`, `tr`, `cut`, `xargs`, `tar`, `gzip`. Run `busybox --list` from the shell to see the full set.",
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
      "Output is capped at 32 KB combined across all commands. stdout and stderr are returned separately. If you hit `truncated: true`, narrow — `grep -m 20`, `head`, `find … -maxdepth 2`.",
      "",
      "Typical use:",
      "",
      "```",
      "shell({ commands: [\"ls -la /workspace\", \"grep -rn 'TODO' /workspace/src | head -20\"] })",
      "```",
    ].join("\n"),
    inputSchema: zodSchema(SHELL_INPUT),
    execute: (input: z.infer<typeof SHELL_INPUT>): Promise<ShellResult> =>
      runShellBatch(runtime, input),
  });
}
