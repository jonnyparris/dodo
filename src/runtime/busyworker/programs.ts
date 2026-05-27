// @ts-nocheck — vendored from busyworker. Refresh procedure in VENDORED.md.
// Per-Machine program registry.
//
// A program is { path, module, abi } where:
//   path:   absolute VFS path the binary lives at (e.g. "/usr/bin/hello")
//   module: a statically-imported WebAssembly.Module (Workers blocks runtime
//           compilation, so the host worker must import the .wasm directly
//           and hand the Module in here)
//   abi:    "linux" | "wasi"
//
// The Machine takes one defaultProgram (used when execve can't find an
// explicit hit — typically busybox, which is a multi-call binary) plus any
// number of extra programs registered by path.

import type { Program } from "./types.js";

export interface ProgramSpec extends Program {
  path: string;
}

export interface ProgramRegistryOpts {
  defaultProgram: Program;
  programs?: ProgramSpec[];
}

export class ProgramRegistry {
  default: Program;
  byPath: Map<string, Program>;

  constructor({ defaultProgram, programs = [] }: ProgramRegistryOpts) {
    if (!defaultProgram) throw new Error("ProgramRegistry: defaultProgram is required");
    this.default = defaultProgram;
    this.byPath = new Map();
    for (const p of programs) this.register(p);
  }

  register({ path, module, abi, main }: ProgramSpec): void {
    if (!path || !path.startsWith("/")) throw new Error(`ProgramRegistry: bad path ${path}`);
    if (abi === "js") {
      if (typeof main !== "function") throw new Error(`ProgramRegistry: js program ${path} needs main()`);
      this.byPath.set(path, { abi, main });
      return;
    }
    if (!module) throw new Error(`ProgramRegistry: missing module for ${path}`);
    if (abi !== "linux" && abi !== "wasi") throw new Error(`ProgramRegistry: bad abi ${abi} for ${path}`);
    this.byPath.set(path, { module, abi });
  }

  lookup(exePath: string): Program {
    return this.byPath.get(exePath) || this.default;
  }

  paths(): IterableIterator<string> {
    return this.byPath.keys();
  }
}
