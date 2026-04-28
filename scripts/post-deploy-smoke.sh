#!/usr/bin/env bash
# Post-deploy smoke probe — exercises the critical end-to-end paths through
# the deployed Dodo Worker over real HTTP. Designed to catch regressions
# that types and unit tests can't surface (workerd validators, missing DO
# bindings, broken auth, migration drift, asset-bundle mismatches, etc.).
#
# Each step is one assertion. First failure exits non-zero.
#
# What this catches that unit tests don't:
#   - Worker fails to boot (missing binding, bad migration, panic on import)
#   - Service binding mismatches (env.OUTBOUND, env.LOADER, env.ARTIFACTS, etc.)
#   - workerd's `globalOutbound` Fetcher validator (the bug from PR #52/54/55)
#   - Hono router regressions
#   - Durable Object schema drift (storage migrations failing silently)
#   - Cloudflare Access JWT validation breakage
#   - Assets binding serving stale bundles
#
# What this does NOT cover (intentionally):
#   - LLM behaviour or prompt quality (slow + flaky + LLM-cost; covered by
#     test/dodo.test.ts e2e-style tests against mocked agentic)
#   - Multi-tenancy / permission enforcement (covered by integration tests)
#   - SSE streaming robustness (covered by smoke-scheduled-sessions.sh)
#
# Usage:
#   scripts/post-deploy-smoke.sh                                  # against prod
#   DODO_URL=https://staging.dodo.example.com scripts/post-deploy-smoke.sh
#   AUTH_MODE=none DODO_URL=http://127.0.0.1:8787 scripts/post-deploy-smoke.sh
#
# Auth:
#   - Default AUTH_MODE=access uses `cloudflared access curl` for CF Access.
#   - AUTH_MODE=none uses plain curl (for local dev with ALLOW_UNAUTHENTICATED_DEV).

set -euo pipefail

DODO_URL="${DODO_URL:-https://dodo.jonnyparris.workers.dev}"
AUTH_MODE="${AUTH_MODE:-access}" # "access" | "none"
EXPECTED_COMMIT="${EXPECTED_COMMIT:-}"  # if set, fail unless /version.json matches

# ANSI colour
red()    { printf '\033[31m%s\033[0m' "$1"; }
green()  { printf '\033[32m%s\033[0m' "$1"; }
yellow() { printf '\033[33m%s\033[0m' "$1"; }
blue()   { printf '\033[34m%s\033[0m' "$1"; }

step()   { echo; echo "$(blue '▶')" "$@"; }
ok()     { echo "  $(green '✓')" "$@"; }
warn()   { echo "  $(yellow '!')" "$@"; }
fail()   { echo "  $(red '✗')" "$@"; exit 1; }

call() {
  local method="$1" path="$2" body="${3:-}"
  local url="${DODO_URL}${path}"
  local curl_args=(-sS -X "$method" -w '\n%{http_code}')
  if [[ -n "$body" ]]; then
    curl_args+=(-H "content-type: application/json" --data "$body")
  fi
  if [[ "$AUTH_MODE" == "access" ]]; then
    cloudflared access curl "$url" "${curl_args[@]}"
  else
    curl "${curl_args[@]}" "$url"
  fi
}

# Split "body\nHTTPCODE" → RESP_BODY + RESP_CODE
split_resp() {
  local resp="$1"
  RESP_CODE="${resp##*$'\n'}"
  RESP_BODY="${resp%$'\n'*}"
}

# JSON field extraction without jq dependency (CI runners may not have it).
json_field() {
  python3 -c "import sys, json
try:
    print(json.loads(sys.stdin.read()).get('$1', ''))
except Exception as e:
    print(f'__JSON_PARSE_ERROR__: {e}', file=sys.stderr)
    sys.exit(1)"
}

created_session=""
cleanup() {
  if [[ -n "$created_session" ]]; then
    echo
    step "cleanup"
    call DELETE "/session/$created_session" >/dev/null 2>&1 || true
    ok "deleted probe session $created_session"
  fi
}
trap cleanup EXIT

# ─── Preflight ────────────────────────────────────────────────────────────

step "preflight"
echo "  target: $DODO_URL"
echo "  auth:   $AUTH_MODE"

# 1. Worker is alive (assets binding + Hono router + JSON encoder)
split_resp "$(call GET /health)"
[[ "$RESP_CODE" == "200" ]] || fail "GET /health returned $RESP_CODE: $RESP_BODY"
ok "Worker is alive"

# 2. Build artifact present (covers: build script ran, public/ assets binding)
split_resp "$(call GET /version.json)"
[[ "$RESP_CODE" == "200" ]] || fail "GET /version.json returned $RESP_CODE — assets binding misconfigured?"
DEPLOYED_COMMIT=$(echo "$RESP_BODY" | json_field commit)
DEPLOYED_BUILT_AT=$(echo "$RESP_BODY" | json_field builtAt)
[[ -n "$DEPLOYED_COMMIT" ]] || fail "version.json missing commit field: $RESP_BODY"
ok "version.json: commit=$DEPLOYED_COMMIT builtAt=$DEPLOYED_BUILT_AT"

if [[ -n "$EXPECTED_COMMIT" && "$DEPLOYED_COMMIT" != "$EXPECTED_COMMIT" ]]; then
  fail "expected commit $EXPECTED_COMMIT but deployed is $DEPLOYED_COMMIT — deploy may not have applied"
fi

# 3. Status endpoint (covers: SharedIndex DO read path)
split_resp "$(call GET /api/status)"
[[ "$RESP_CODE" == "200" ]] || fail "GET /api/status returned $RESP_CODE — SharedIndex DO unreachable?"
ok "SharedIndex DO is responding"

# ─── Critical path canaries ───────────────────────────────────────────────

# 4. Session create (covers: auth → Hono → UserControl DO write → SharedIndex stats)
step "session lifecycle"
split_resp "$(call POST /session)"
[[ "$RESP_CODE" == "201" ]] || fail "POST /session returned $RESP_CODE: $RESP_BODY"
created_session=$(echo "$RESP_BODY" | json_field id)
[[ -n "$created_session" ]] || fail "session POST returned no id: $RESP_BODY"
ok "created probe session $created_session"

# 5. Session read (covers: auth → UserControl DO read)
split_resp "$(call GET /session/$created_session)"
[[ "$RESP_CODE" == "200" ]] || fail "GET /session/$created_session returned $RESP_CODE: $RESP_BODY"
ok "session is readable"

# 6. THE GLOBALOUTBOUND CANARY — codemode sandbox boot via /execute.
#    This is the path that broke 4 times in 2 days (PRs #52/54/55).
#    A trivial code expression exercises:
#      - LOADER binding (DynamicWorkerExecutor needs it to spawn a worker)
#      - OUTBOUND service binding (passed as globalOutbound; must be a real
#        ServiceStub Fetcher — workerd rejects wrappers at WorkerCode boot)
#      - CodingAgent DO routing + storage init
#      - workspace + state tools wiring
#    If this returns 400 with a globalOutbound error, the sandbox is broken
#    and codemode is unusable in production.
step "codemode sandbox (globalOutbound canary)"
split_resp "$(call POST /session/$created_session/execute '{"code":"async () => 42"}')"
[[ "$RESP_CODE" == "200" ]] || fail "POST /execute returned $RESP_CODE: $RESP_BODY"
EXEC_RESULT=$(echo "$RESP_BODY" | json_field result)
[[ "$EXEC_RESULT" == "42" ]] || fail "expected result=42, got: $RESP_BODY"
ok "codemode sandbox executes trivial code (globalOutbound is wired)"

# 7. THE GIT-OVER-SANDBOX CANARY — clone a real public repo via /git/clone.
#    Exercises:
#      - resolveRemoteToken (parent DO auth resolution)
#      - createWorkspaceGit (isomorphic-git over our FS adapter)
#      - workspace bucket binding (R2 writes for git pack files)
#    Uses depth=1 against this repo for minimal bandwidth.
step "git clone over workspace"
split_resp "$(call POST /session/$created_session/git/clone \
  '{"url":"https://github.com/jonnyparris/dodo","branch":"main","depth":1,"singleBranch":true,"dir":"/probe-clone"}')"
[[ "$RESP_CODE" == "200" ]] || fail "POST /git/clone returned $RESP_CODE: $RESP_BODY"
ok "git clone succeeded into workspace"

# 8. Verify cloned files appear in /files (covers: workspace SQL index, R2 reads)
split_resp "$(call GET '/session/'"$created_session"'/files?path=/probe-clone')"
[[ "$RESP_CODE" == "200" ]] || fail "GET /files returned $RESP_CODE: $RESP_BODY"
echo "$RESP_BODY" | grep -q "package.json" || fail "cloned dir doesn't contain package.json — clone may have failed silently"
ok "cloned tree is readable from workspace"

# ─── Done ─────────────────────────────────────────────────────────────────

echo
step "done"
ok "all post-deploy smoke checks passed against $DODO_URL"
echo "  commit: $DEPLOYED_COMMIT (built $DEPLOYED_BUILT_AT)"
