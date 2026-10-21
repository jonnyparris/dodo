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
run() { npx vitest run test/pi-engine.test.ts > /tmp/model-ab-verify.$$ 2>&1; local rc=$?; grep -E "Tests |FAIL" /tmp/model-ab-verify.$$ | head -5; return $rc; }
restore() { git checkout -q -- src/pi/engine.ts test/pi-engine.test.ts; }
trap restore EXIT
git show "$BUGGY:src/pi/engine.ts" > /tmp/model-ab-buggy.$$

echo "## agent engine + hidden upstream test"; cp "$F/src/pi/engine.ts" src/pi/engine.ts; git show "$FIXED:test/pi-engine.test.ts" > test/pi-engine.test.ts
run; hidden=$?
echo "## agent engine + agent test"; cp "$F/test/pi-engine.test.ts" test/pi-engine.test.ts
run; own=$?
echo "## buggy engine + agent test (should fail)"; cp /tmp/model-ab-buggy.$$ src/pi/engine.ts
run; buggy=$?
rm -f /tmp/model-ab-buggy.$$ /tmp/model-ab-verify.$$
echo "hidden=$hidden own=$own buggy=$buggy"
[ $hidden -eq 0 ] && [ $own -eq 0 ] && [ $buggy -ne 0 ]
