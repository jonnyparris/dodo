# Deploying

**Deploys are manual.** Run `npm run deploy:safe` locally after merging to `main` — it builds, deploys, then runs `scripts/post-deploy-smoke.sh` against the deployed Worker. The probe asserts:

- `/health` and `/version.json` (deployed commit equals HEAD)
- codemode `execute` round-trips through `globalOutbound`
- a real `git clone` lands in the workspace

Use plain `npm run deploy` only when you intentionally want to skip the probe (e.g. you're about to run it manually with extra args).

## Why CI deploys are disabled

Workers Builds CI is off because the `"experimental"` compat flag (required by `@cloudflare/think` and the Agents SDK `subAgent()` facet API) blocks non-local deploys by design — see [issue #46](https://github.com/jonnyparris/dodo/issues/46). When Think graduates out of experimental, this can be re-enabled.

PR validation runs via `.github/workflows/dodo-verify.yml` (typecheck + test) instead of a deploy.
