#!/bin/bash
# Plant the fixture branches that bench/model-ab.auto.json clones:
#   bench/base         = <base ref>, unchanged. Explore and refactor tasks start here.
#   bench/bugfix-base  = bench/base with 4c3f131 ("pi tokenInput includes cache
#                        reads/writes") reverted, fix and its test both. The
#                        bugfix task starts here.
# Pinned branches keep runs comparable over time: main moving on (or someone
# doing the refactor for real) does not change the tasks. Dodo clones with
# depth 1, so the agent sees one commit and cannot read the revert from history.
#
# Usage: scripts/bench-seed.sh [base-ref=origin/main] [--push]
# Re-seed only when you want a new baseline; old results stop being comparable.
set -euo pipefail
BASE="${1:-origin/main}"
PUSH="${2:-}"
FIX=4c3f131
cd "$(git rev-parse --show-toplevel)"
git fetch -q origin
base_sha=$(git rev-parse --verify "$BASE^{commit}")
tmp=$(mktemp -d)
trap 'git worktree remove --force "$tmp" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
git worktree add -q --detach "$tmp" "$base_sha"
(
  cd "$tmp"
  git diff "$FIX^" "$FIX" -- src/pi/engine.ts test/pi-engine.test.ts | git apply -R
  git -c user.name=jonnyparris -c user.email=6400000+jonnyparris@users.noreply.github.com \
    commit -q -am "chore: bench fixture"
)
bug_sha=$(git -C "$tmp" rev-parse HEAD)
git branch -f bench/base "$base_sha"
git branch -f bench/bugfix-base "$bug_sha"
echo "bench/base        $base_sha"
echo "bench/bugfix-base $bug_sha"
if [[ "$PUSH" == "--push" ]]; then
  git push -f origin bench/base bench/bugfix-base
fi
