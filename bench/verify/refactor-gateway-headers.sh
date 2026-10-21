#!/bin/bash
# Verify the "dedupe x-dodo-* gateway headers in src/index.ts" refactor.
# Needs DODO_CHECKOUT: a clean, throwaway Dodo checkout with node_modules.
# Pass = typecheck + route tests pass with the agent's src/index.ts, and the
# header block appears at most once.
set -u
: "${DODO_CHECKOUT:?set DODO_CHECKOUT to a throwaway Dodo checkout}" "${BENCH_OUT:?}"
cd "$DODO_CHECKOUT" || exit 2
trap 'git checkout -q -- src/index.ts' EXIT
cp "$BENCH_OUT/files/dodo/src/index.ts" src/index.ts
echo "## typecheck"; npm run -s typecheck > /tmp/model-ab-tc.$$ 2>&1; tc=$?; tail -3 /tmp/model-ab-tc.$$
echo "## route tests"
# Killed (rc >= 124) is an infra failure, not a verdict: retry once.
for _ in 1 2; do
  npx vitest run test/dodo.test.ts test/permission-enforcement.test.ts test/pi-default-e2e.test.ts > /tmp/model-ab-rt.$$ 2>&1; rt=$?
  [ $rt -lt 124 ] && break
  echo "vitest killed (rc=$rt), retrying"
done
grep -E "Test Files|Tests " /tmp/model-ab-rt.$$
blocks=$(grep -c '"x-dodo-opencode-base-url"' src/index.ts)
echo "remaining header blocks: $blocks"
rm -f /tmp/model-ab-tc.$$ /tmp/model-ab-rt.$$
[ $tc -eq 0 ] && [ $rt -eq 0 ] && [ "$blocks" -le 1 ]
