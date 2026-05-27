# Vendored: @busyworker/core

Source: https://gitlab.cfdata.org/rfigueira/busyworker (`packages/core/src/`)

This is a vendored snapshot, not a published package — busyworker's
`@busyworker/core` is marked `private: true` and isn't on npm. The files
here are an unmodified copy of the upstream source.

## What it is

A "kernel" runtime that emulates the Linux syscall ABI in ~5000 lines of
TypeScript so `busybox.wasm` (and other Linux/WASI binaries built against
the matching patched musl) can run inside a single Workers isolate. See
the upstream README for the design write-up.

## Why we vendor it

- Not published to npm.
- We only need the `core` package — not the terminal example, build
  scripts, or tests.
- Lets us iterate on the `WorkspaceFs` adapter without coordinating
  upstream changes.

## How to refresh

```sh
# 1. Clone (or pull) busyworker upstream
glab repo clone rfigueira/busyworker /tmp/busyworker
# 2. Rebuild artifacts (Docker; ~5–10 min first run, cached after)
cd /tmp/busyworker && npm run build:busybox
# 3. Sync source
rsync -a --delete /tmp/busyworker/packages/core/src/ \
  ~/dev/dodo/src/runtime/busyworker/
# 4. Sync wasm artifacts
cp /tmp/busyworker/packages/core/artifacts/{busybox,initramfs}.wasm \
  ~/dev/dodo/vendor/wasm/busybox/
# 5. Restore the dodo-specific files (just this notice)
git checkout -- src/runtime/busyworker/VENDORED.md
```

## What we add on top (not part of the upstream snapshot)

- `src/runtime/shell/workspace-fs.ts` — adapter that mounts a
  `@cloudflare/shell` `WorkspaceFileSystem` as a busyworker dynamic-dir
  VFS subtree. Modelled on `r2fs.ts`. Lives in a sibling dir so tsc and
  biome cover it (this directory is excluded from both).

## Lint + typecheck exclusion

`biome.jsonc` excludes `src/runtime/busyworker/**` from the lint set and
`tsconfig.json` excludes the same path from `tsc`. Vendored upstream code
ships with looser type settings than Dodo (notably `WebAssembly.Suspending`
isn't in `@cloudflare/workers-types`) and isn't ours to police. Our
adapter lives in `src/runtime/shell/` precisely so it stays covered.
