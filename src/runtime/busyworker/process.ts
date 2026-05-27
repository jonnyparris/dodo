// @ts-nocheck — vendored from busyworker. Refresh procedure in VENDORED.md.
// Process: per-process wasm instance, memory, fd table, kernel state.
//
// Two ABIs are supported (chosen per-program by src/programs.js):
//
//   - "linux"  → busybox.wasm. Imports a shared memory + indirect-table,
//                custom __wasm_syscall_N suspending imports, sets up a Linux
//                argv/envp/auxv stack frame at _start.
//   - "wasi"   → vanilla WASI preview1 binaries. Module exports its own
//                memory; we provide wasi_snapshot_preview1.* imports via
//                src/wasi.js. argv/envp are surfaced via WASI imports, not
//                via stack layout.
//
// Both kinds share the parent Machine's vfs + tty + pid namespace + fd table
// semantics — that's the whole point of putting the "kernel" in syscalls.js
// (and the WASI shim) instead of inside the binaries.

import { FdTable } from "./fd.js";
import { Kernel, ExitTrap } from "./syscalls.js";
import { Wasi, WasiExit } from "./wasi.js";
import type { MachineRef, Proc } from "./types.js";



// Linux-ABI memory layout (only used for busybox).
const MEM_BASE     = 0x00010000;
const STACK_BOTTOM = 0x00050000;
const ARGC_ADDR    = 0x00100000;
const STRINGS_TOP  = 0x00150000;
const HEAP_START   = 0x00150000;
const HEAP_MAX     = 0x04000000;
const INITIAL_PAGES = HEAP_START >> 16;
const MAX_PAGES = HEAP_MAX >> 16;

export const MEMLAYOUT = { MEM_BASE, ARGC_ADDR, HEAP_START, HEAP_MAX, STRINGS_TOP };

function setupStack(memory: WebAssembly.Memory, argv: string[], envp: string[]): number {
  const dv = new DataView(memory.buffer);
  const u8 = new Uint8Array(memory.buffer);
  const auxvEntries = [[6, 4096]]; // AT_PAGESZ
  const vecLen = 1 + (argv.length + 1) + (envp.length + 1) + (auxvEntries.length + 1 + 1) * 2;
  const vecBytes = vecLen * 4;
  const stringsBase = ARGC_ADDR + vecBytes;
  let strPtr = stringsBase;
  const enc = new TextEncoder();
  const writeStr = (s) => { const b = enc.encode(s + "\0"); u8.set(b, strPtr); const r = strPtr; strPtr += b.length; return r; };
  const argvPtrs = argv.map(writeStr);
  const envPtrs = envp.map(writeStr);
  const rndPtr = strPtr;
  crypto.getRandomValues(u8.subarray(rndPtr, rndPtr + 16));
  strPtr += 16;
  if (strPtr > STRINGS_TOP) throw new Error("argv strings overflowed string region");
  let p = ARGC_ADDR;
  dv.setUint32(p, argv.length, true); p += 4;
  for (const v of argvPtrs) { dv.setUint32(p, v, true); p += 4; }
  dv.setUint32(p, 0, true); p += 4;
  for (const v of envPtrs) { dv.setUint32(p, v, true); p += 4; }
  dv.setUint32(p, 0, true); p += 4;
  for (const [t, v] of auxvEntries) { dv.setUint32(p, t, true); p += 4; dv.setUint32(p, v, true); p += 4; }
  dv.setUint32(p, 25, true); p += 4; dv.setUint32(p, rndPtr, true); p += 4; // AT_RANDOM
  dv.setUint32(p, 0, true); p += 4; dv.setUint32(p, 0, true); p += 4;       // AT_NULL
  return ARGC_ADDR;
}

// Spawn a new process inside `machine`. Returns the Process object (with
// .exitedPromise resolving to the exit code).
//
// fdEntries: Map<fd, entry> to clone into the new process's fd table.
//   Each entry is shallow-copied; underlying nodes (regular files, pipes, tty)
//   remain shared.
export interface SpawnOpts {
  argv: string[];
  envp: string[];
  fdEntries: Map<number, any>;
  cwd?: string;
  parentPid?: number;
  traceSyscalls?: boolean;
  exePath?: string | null;
}

export function spawnProcess(
  machine: MachineRef,
  { argv, envp, fdEntries, cwd = "/", parentPid = 0, traceSyscalls = false, exePath = null }: SpawnOpts,
): Proc {
  const pid = machine.nextPid++;

  // Resolve which program to run.
  const explicitPath = exePath
    || (argv[0]?.startsWith("/") ? argv[0] : null)
    || "/bin/" + (argv[0] || "busybox");
  const program = machine.programs.lookup(explicitPath);

  const fdt = new FdTable();
  for (const [fd, entry] of fdEntries) {
    fdt.alloc({ ...entry }, fd);
  }

  // Memory: Linux ABI imports a shared memory; WASI binaries export their own.
  let memory = null;
  let indirectTable = null;
  if (program.abi === "linux") {
    memory = new WebAssembly.Memory({ initial: INITIAL_PAGES, maximum: MAX_PAGES, shared: true });
    indirectTable = new WebAssembly.Table({ initial: 772, element: "anyfunc" });
  }

  const proc: Proc = {
    pid, ppid: parentPid,
    memory, indirectTable, fdt,
    instance: null,
    cwd,
    argv: argv.slice(),
    envp: envp.slice(),
    exePath: explicitPath,
    abi: program.abi,
    exitCode: 0,
    exited: false,
    exitedResolve: null,
    exitedPromise: null,
  };
  proc.exitedPromise = new Promise((r) => { proc.exitedResolve = r; });

  // Kernel: still constructed even for WASI processes — the WASI shim
  // delegates many calls (sys_write, sys_read, sys_llseek, …) into it.
  const kernel = new Kernel({
    vfs: machine.vfs,
    fdt,
    tty: machine.tty,
    memory,                       // patched below for WASI after instantiate
    log: machine.log,
    process: proc,
    machine,
    traceSyscalls,
  });
  kernel.cwd = cwd;
  kernel.pid = pid;
  kernel.ppid = parentPid;
  if (program.abi === "linux") {
    kernel.brkStart = HEAP_START;
    kernel.brkEnd = HEAP_START;
    kernel.brkLimit = HEAP_START + 32 * 1024 * 1024;
    kernel.mmapNext = kernel.brkLimit;
    kernel.mmapLimit = HEAP_MAX;
  }
  proc.kernel = kernel;

  machine.processes.set(pid, proc);

  proc.runPromise = (program.abi === "wasi")
    ? runWasiProcess(proc, kernel, machine, program)
    : (program.abi === "js")
      ? runJsProcess(proc, machine, program)
      : runLinuxProcess(proc, kernel, machine, program);

  return proc;
}

// ============================================================
//  JS ABI runner — for built-in "applets" implemented in JS,
//  with no wasm module to instantiate. The main(ctx) function
//  reads/writes via machine.tty + machine.vfs and returns an
//  exit code.
// ============================================================
async function runJsProcess(proc: Proc, machine: MachineRef, program: { main?: (ctx: any) => number | Promise<number> }): Promise<void> {
  try {
    const code = await program.main!({
      proc, machine, argv: proc.argv, envp: proc.envp,
    });
    proc.exitCode = (code | 0) || 0;
  } catch (e: any) {
    machine.log(`pid ${proc.pid} (js) crashed: ${e?.message ?? e}`);
    proc.exitCode = 1;
  }
  finalizeProcess(proc);
}

// ============================================================
//  Linux ABI runner (busybox)
// ============================================================
async function runLinuxProcess(proc: Proc, kernel: Kernel, machine: MachineRef, program: { module?: WebAssembly.Module; abi: string }): Promise<void> {
  const { memory, indirectTable, envp } = proc;
  // Busybox is a multi-call binary: it dispatches on argv[0]. When exec'd
  // via a path like "/bin/ls" or "/usr/bin/cowsay", set argv[0] to the
  // basename so the right applet is selected. (WASI binaries get argv as-is.)
  let argv = proc.argv;
  if (proc.exePath) {
    let base = proc.exePath.split("/").pop();
    // `/proc/self/exe` is hush's self-re-exec path (used for subshells).
    // Its basename "exe" isn't a busybox applet — trust the caller's argv[0]
    // (typically "sh") instead.
    if (base === "exe") base = argv[0];
    if (base && argv[0] !== base) argv = [base, ...argv.slice(1)];
  }
  const stackPointer = new WebAssembly.Global({ value: "i32", mutable: true }, ARGC_ADDR);
  proc.stackPointerGlobal = stackPointer;

  let syscallCount = 0;
  const dispatchAsync = async (nr, ...args) => {
    if ((++syscallCount & 0xFFF) === 0) await new Promise((r) => setTimeout(r, 0));
    return kernel.dispatchAsync(nr, ...args);
  };
  const Suspending = WebAssembly.Suspending;
  const env = {
    memory,
    __indirect_function_table: indirectTable,
    __stack_pointer: stackPointer,
    __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, MEM_BASE),
    __table_base:  new WebAssembly.Global({ value: "i32", mutable: false }, 0),
    __wasm_abort: () => { machine.log(`pid ${proc.pid}: __wasm_abort`); throw new ExitTrap(134); },
    // NOTE: the patched musl in patches/musl/ declares each syscall stub with
    // two extra leading iLONG params, e.g.
    //   .functype __wasm_syscall_0(iLONG, iLONG, iLONG) -> (iLONG)
    // The assembly stubs pass (0, 0, nr, ...args). So _s, _t here are real
    // wasm args (always 0), NOT a JSPI suspender prefix. Removing them
    // shifts every syscall argument by two and hangs/crashes busybox.
    // (WASI imports in src/wasi.js do not have this — they use normal
    // preview1 signatures.)
    __wasm_syscall_0: new Suspending((_s, _t, nr)                   => dispatchAsync(nr)),
    __wasm_syscall_1: new Suspending((_s, _t, nr, a)                => dispatchAsync(nr, a)),
    __wasm_syscall_2: new Suspending((_s, _t, nr, a, b)             => dispatchAsync(nr, a, b)),
    __wasm_syscall_3: new Suspending((_s, _t, nr, a, b, c)          => dispatchAsync(nr, a, b, c)),
    __wasm_syscall_4: new Suspending((_s, _t, nr, a, b, c, d)       => dispatchAsync(nr, a, b, c, d)),
    __wasm_syscall_5: new Suspending((_s, _t, nr, a, b, c, d, e)    => dispatchAsync(nr, a, b, c, d, e)),
    __wasm_syscall_6: new Suspending((_s, _t, nr, a, b, c, d, e, f) => dispatchAsync(nr, a, b, c, d, e, f)),
  };

  const instance = new WebAssembly.Instance(program.module, { env } as any);
  proc.instance = instance;
  proc.kernel!.instance = instance;
  const exp = instance.exports as any;
  if (exp.__libc_clone_callback) {
    proc.kernel!.cloneCallbackPromising = WebAssembly.promising(exp.__libc_clone_callback);
  }

  if (exp.__wasm_call_ctors) exp.__wasm_call_ctors();
  if (exp.__wasm_apply_data_relocs) exp.__wasm_apply_data_relocs();

  setupStack(memory!, argv, envp);
  stackPointer.value = ARGC_ADDR;

  const startPromising = WebAssembly.promising(exp._start);
  try {
    await startPromising();
  } catch (e: any) {
    if (e instanceof ExitTrap) {
      proc.exitCode = e.code;
    } else {
      machine.log(`pid ${proc.pid} crashed: ${e.message}`);
      proc.exitCode = 139;
    }
  }
  finalizeProcess(proc);
}

// ============================================================
//  WASI ABI runner
// ============================================================
async function runWasiProcess(proc: Proc, _kernel: Kernel, machine: MachineRef, program: { module?: WebAssembly.Module; abi: string }): Promise<void> {
  const wasi = new Wasi({ proc, argv: proc.argv, envp: proc.envp, log: machine.log });
  const imports = wasi.buildImports();

  let instance;
  try {
    instance = new WebAssembly.Instance(program.module, imports);
  } catch (e: any) {
    machine.log(`pid ${proc.pid}: WASI instantiate failed: ${e.message}`);
    try {
      const imps = WebAssembly.Module.imports(program.module);
      machine.log(`  module imports: ${JSON.stringify(imps)}`);
    } catch {}
    proc.exitCode = 127;
    finalizeProcess(proc);
    return;
  }
  proc.instance = instance;
  // WASI binaries export their own memory; wire it into the kernel & wasi shim.
  if (instance.exports.memory) {
    proc.memory = instance.exports.memory;
    proc.kernel.memory = instance.exports.memory;
  }
  proc.kernel.instance = instance;

  if (instance.exports._initialize) instance.exports._initialize();

  const startFn = instance.exports._start;
  if (typeof startFn !== "function") {
    machine.log(`pid ${proc.pid}: WASI binary has no _start export`);
    proc.exitCode = 126;
    finalizeProcess(proc);
    return;
  }
  const startPromising = WebAssembly.promising(startFn);
  try {
    await startPromising();
    proc.exitCode = 0;
  } catch (e: any) {
    if (e instanceof WasiExit) {
      proc.exitCode = e.code;
    } else if (e instanceof ExitTrap) {
      proc.exitCode = e.code;
    } else {
      machine.log(`pid ${proc.pid} (wasi) crashed: ${e.message}`);
      proc.exitCode = 139;
    }
  }
  finalizeProcess(proc);
}

function finalizeProcess(proc: Proc): void {
  // Track async-close promises so the process's exitedPromise doesn't
  // resolve until every backend flush (e.g. r2fs PUT-on-close) has landed.
  const pending: Array<Promise<void>> = [];
  for (const [, entry] of proc.fdt.map) {
    const sp = entry.node?.special;
    try { sp?.close?.(entry); } catch {}
    if (sp?.closeAsync) {
      try {
        const p = sp.closeAsync(entry);
        if (p && typeof p.then === "function") pending.push(p.catch(() => {}));
      } catch {}
    }
  }
  proc.fdt.map.clear();
  proc.exited = true;
  if (pending.length === 0) {
    proc.exitedResolve(proc.exitCode);
  } else {
    Promise.all(pending).then(() => proc.exitedResolve(proc.exitCode));
  }
}
