# Linting

Two layers:

1. **In-isolate** — the `typecheck` tool with `extraStrict: true`. Catches unused locals/parameters, missing returns, and switch fall-through via TypeScript's own diagnostics. No extra bundle cost, sub-second feedback inside a session.
2. **External (CI)** — Biome runs in `.github/workflows/dodo-verify.yml` for every PR and dispatched verify run. Catches the wider set: unused imports, suspicious patterns, double-equals, etc. Configured in `biome.jsonc` (correctness + suspicious rules only — formatting and style are intentionally off).

**Why two layers:** Biome's wasm bundle is ~8 MB gzipped, which would push Dodo past the Workers 10 MB compressed script limit if loaded in-isolate. The in-isolate check is the agent's fast feedback loop; the CI check is the thorough gate before merge.

Run `npm run lint` locally before pushing if you want the same signal CI will give you. `npm run lint:fix` applies safe auto-fixes.
