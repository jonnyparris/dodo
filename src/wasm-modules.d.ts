// Ambient module declarations for `.wasm` imports.
//
// At deploy time wrangler's CompiledWasm rule (see `wrangler.jsonc`)
// rewrites `import X from "./foo.wasm"` to a static `WebAssembly.Module`.
// TypeScript needs to be told the shape of that import — without this
// shim, `tsc --noEmit` fails with `Cannot find module './foo.wasm'`.

declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
