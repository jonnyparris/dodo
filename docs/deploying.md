# Deploying

**Deploys are manual.** Run `npm run deploy:safe` locally after merging to `main` — it builds, deploys, then runs `scripts/post-deploy-smoke.sh` against the deployed Worker. The probe asserts:

- `/health` and `/version.json` (deployed commit equals HEAD)
- codemode `execute` round-trips through `globalOutbound`
- a real `git clone` lands in the workspace

The probe authenticates to Access with a service token (env `DODO_ACCESS_CLIENT_ID`/`DODO_ACCESS_CLIENT_SECRET`, or the macOS keychain item `dodo-smoke-access`). The token must be in a `non_identity` policy on the Dodo Access apps. Without one it falls back to plain curl, which only works if WARP is enrolled in the same Zero Trust org as Dodo. Details: `scripts/lib/smoke-auth.sh`.

Use plain `npm run deploy` only when you intentionally want to skip the probe (e.g. you're about to run it manually with extra args).

## Why CI deploys are disabled

Workers Builds CI is off because the `"experimental"` compat flag (required by the Agents SDK facet API that `explore` / `task` subagents use) blocks non-local deploys by design — see [issue #46](https://github.com/jonnyparris/dodo/issues/46). When facets graduate out of experimental, this can be re-enabled.

PR validation runs via `.github/workflows/dodo-verify.yml` (typecheck + test) instead of a deploy.
