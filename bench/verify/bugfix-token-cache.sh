#!/bin/bash
# Verify the "tokenInput ignores cache reads/writes" bug fix (upstream 4c3f131).
# Needs DODO_CHECKOUT: a clean, throwaway Dodo checkout with node_modules. This
# script swaps files in it and restores them. Run by bench/model-ab.ts.
# Pass = the agent's engine passes the hidden upstream test AND the agent's own
# test passes on its fix and fails on the buggy engine.
# BENCH_FIXED_REF / BENCH_BUGGY_REF: where the hidden test and the buggy engine
# come from. Defaults fit a session forked from a 4c3f131-era checkout; the
# auto spec points them at the bench/base and bench/bugfix-base fixture branches.
set -u
FIXED="${BENCH_FIXED_REF:-4c3f131}"
BUGGY="${BENCH_BUGGY_REF:-4c3f131^}"
: "${DODO_CHECKOUT:?set DODO_CHECKOUT to a throwaway Dodo checkout}" "${BENCH_OUT:?}"
cd "$DODO_CHECKOUT" || exit 2
F="$BENCH_OUT/files/dodo"
# The checkout may already hold the fixed engine + hidden test (bench/base), so
# a missing collected file must fail, not silently grade the reference code.
[ -s "$F/src/pi/engine.ts" ] && [ -s "$F/test/pi-engine.test.ts" ] || { echo "collected files missing in $F"; exit 1; }
# Killed (rc >= 124: timeout or signal) is an infra failure, not a verdict: retry once.
run() {
  local rc
  for _ in 1 2; do
    npx vitest run test/pi-engine.test.ts > /tmp/model-ab-verify.$$ 2>&1; rc=$?
    [ $rc -lt 124 ] && break
    echo "vitest killed (rc=$rc), retrying"
  done
  grep -E "Tests |FAIL" /tmp/model-ab-verify.$$ | head -5; return $rc
}
restore() { git checkout -q -- src/pi/engine.ts test/pi-engine.test.ts; }
trap restore EXIT
git show "$BUGGY:src/pi/engine.ts" > /tmp/model-ab-buggy.$$ || { echo "cannot read $BUGGY:src/pi/engine.ts"; exit 2; }

echo "## agent engine + hidden upstream test"; cp "$F/src/pi/engine.ts" src/pi/engine.ts; git show "$FIXED:test/pi-engine.test.ts" > test/pi-engine.test.ts || { echo "cannot read $FIXED:test/pi-engine.test.ts"; exit 2; }
run; hidden=$?
echo "## agent engine + agent test"; cp "$F/test/pi-engine.test.ts" test/pi-engine.test.ts
run; own=$?
echo "## buggy engine + agent test (should fail)"; cp /tmp/model-ab-buggy.$$ src/pi/engine.ts
run; buggy=$?
rm -f /tmp/model-ab-buggy.$$ /tmp/model-ab-verify.$$
echo "hidden=$hidden own=$own buggy=$buggy"
[ $hidden -eq 0 ] && [ $own -eq 0 ] && [ $buggy -ne 0 ]
