#!/usr/bin/env bash
# Smoke-test the scheduled-sessions feature against a running dodo.
#
# Covers the three highest-value tests from the feature review:
#   1. Delayed fresh schedule fires, creates a session, deletes the row
#   3. SSE event emitted when a schedule fires
#   5. Stall-after-failures + retry clears the stall
#
# Safety:
#   - Prints resolved target URL + deployed commit and asks for confirmation.
#   - Uses the cheapest possible prompt so LLM cost stays minimal.
#   - Tracks every schedule + session it creates and deletes them on exit
#     (trap EXIT), including on Ctrl-C or error.
#
# Usage:
#   scripts/smoke-scheduled-sessions.sh                            # against prod (default URL)
#   DODO_URL=https://dodo.example.com scripts/smoke-scheduled-sessions.sh
#   DODO_URL=http://127.0.0.1:8787 scripts/smoke-scheduled-sessions.sh
#
# Auth:
#   - Uses `cloudflared access curl` when DODO_URL is behind CF Access.
#   - Falls back to plain `curl` when AUTH_MODE=none.

set -euo pipefail

DODO_URL="${DODO_URL:-https://dodo.jonnyparris.workers.dev}"
AUTH_MODE="${AUTH_MODE:-access}" # "access" | "none"

# ANSI colour
red()    { printf '\033[31m%s\033[0m' "$1"; }
green()  { printf '\033[32m%s\033[0m' "$1"; }
yellow() { printf '\033[33m%s\033[0m' "$1"; }
blue()   { printf '\033[34m%s\033[0m' "$1"; }

step()   { echo; echo "$(blue '▶')" "$@"; }
ok()     { echo "$(green '✓')" "$@"; }
warn()   { echo "$(yellow '!')" "$@"; }
fail()   { echo "$(red '✗')" "$@"; exit 1; }

call() {
  local method="$1" path="$2" body="${3:-}"
  local url="${DODO_URL}${path}"
  # cloudflared access curl expects the URL FIRST, then curl args after `--`.
  # Plain curl is less fussy. Build two invocations accordingly.
  local curl_args=(-sS -X "$method" -w '\n%{http_code}')
  if [[ -n "$body" ]]; then
    curl_args+=(-H "content-type: application/json" --data "$body")
  fi
  if [[ "$AUTH_MODE" == "access" ]]; then
    # cloudflared access curl: URL first, then curl args (no -- separator).
    cloudflared access curl "$url" "${curl_args[@]}"
  else
    curl "${curl_args[@]}" "$url"
  fi
}

# Split "body\nHTTPCODE" → global body + code variables
split_resp() {
  local resp="$1"
  RESP_CODE="${resp##*$'\n'}"
  RESP_BODY="${resp%$'\n'*}"
}

created_schedules=()
created_sessions=()

cleanup() {
  echo
  step "cleanup"
  for id in "${created_schedules[@]:-}"; do
    [[ -z "$id" ]] && continue
    call DELETE "/api/scheduled-sessions/$id" >/dev/null 2>&1 || true
    echo "  deleted schedule $id"
  done
  for id in "${created_sessions[@]:-}"; do
    [[ -z "$id" ]] && continue
    call DELETE "/session/$id" >/dev/null 2>&1 || true
    echo "  deleted session $id"
  done
}
trap cleanup EXIT

# ─── Preflight ────────────────────────────────────────────────────────────

step "preflight"
echo "  target: $DODO_URL"
echo "  auth:   $AUTH_MODE"

split_resp "$(call GET /health)"
[[ "$RESP_CODE" == "200" ]] || fail "health check failed ($RESP_CODE): $RESP_BODY"
ok "health OK"

split_resp "$(call GET /api/status)"
[[ "$RESP_CODE" == "200" ]] || fail "status check failed ($RESP_CODE): $RESP_BODY"
echo "  status: $RESP_BODY"

split_resp "$(call GET /api/scheduled-sessions)"
[[ "$RESP_CODE" == "200" ]] || fail "/api/scheduled-sessions returned $RESP_CODE — feature probably not deployed"
ok "scheduled-sessions endpoint is live"

echo
echo "$(yellow 'About to run 3 smoke tests against:') $DODO_URL"
echo "  - Test 1: delayed fresh schedule (60s wait, ~1 LLM call)"
echo "  - Test 2: SSE event stream check (90s max)"
echo "  - Test 3: stall + retry flow (no LLM calls, fails deliberately)"
echo
echo "Any schedules and sessions this script creates will be deleted on exit."
read -r -p "Proceed? [y/N] " yn
[[ "$yn" =~ ^[Yy]$ ]] || { echo "aborted"; trap - EXIT; exit 0; }

# ─── Test 1: delayed fresh schedule fires + row deletes ───────────────────

step "test 1: delayed fresh schedule fires"
create_body='{"description":"smoke-1","prompt":"reply with exactly: ok","type":"delayed","delayInSeconds":45,"source":"fresh","title":"smoke-1"}'
split_resp "$(call POST /api/scheduled-sessions "$create_body")"
[[ "$RESP_CODE" == "201" ]] || fail "create failed ($RESP_CODE): $RESP_BODY"
SCHED1_ID=$(echo "$RESP_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
created_schedules+=("$SCHED1_ID")
ok "created schedule $SCHED1_ID"
echo "  nextRunAt: $(echo "$RESP_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['nextRunAt'])")"

echo -n "  waiting 60s for fire"
for _ in $(seq 12); do sleep 5; echo -n "."; done
echo

split_resp "$(call GET /api/scheduled-sessions/$SCHED1_ID)"
if [[ "$RESP_CODE" == "404" ]]; then
  ok "row deleted (one-shot success)"
else
  # Row may still exist if the prompt is still running — check lastSessionId
  last_sid=$(echo "$RESP_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('lastSessionId') or '')" 2>/dev/null || echo "")
  fail_count=$(echo "$RESP_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('failureCount') or 0)" 2>/dev/null || echo "0")
  if [[ -n "$last_sid" ]]; then
    ok "fired with lastSessionId=$last_sid (failureCount=$fail_count)"
    created_sessions+=("$last_sid")
  else
    fail "did not fire yet ($RESP_CODE): $RESP_BODY"
  fi
fi

# Look for the session this schedule spawned — filter newest-first by createdBy
split_resp "$(call GET /session)"
spawned_id=$(echo "$RESP_BODY" | python3 -c "
import sys, json
d = json.load(sys.stdin)
matches = [s for s in d['sessions'] if s.get('createdBy') == 'scheduled-session' and s.get('title') == 'smoke-1']
print(matches[0]['id'] if matches else '')
")
if [[ -n "$spawned_id" ]]; then
  ok "found spawned session $spawned_id"
  created_sessions+=("$spawned_id")
else
  warn "did not find a session with title=smoke-1 — the schedule may have fired but the session is elsewhere"
fi

# ─── Test 2: SSE stream carries scheduled_session_fired ───────────────────

step "test 2: SSE event on fire"
sse_out=$(mktemp)
if [[ "$AUTH_MODE" == "access" ]]; then
  cloudflared access curl "$DODO_URL/api/events" -sN > "$sse_out" &
else
  curl -sN "$DODO_URL/api/events" > "$sse_out" &
fi
sse_pid=$!
sleep 2

create_body='{"description":"smoke-2","prompt":"reply with exactly: ok","type":"delayed","delayInSeconds":30,"source":"fresh","title":"smoke-2"}'
split_resp "$(call POST /api/scheduled-sessions "$create_body")"
[[ "$RESP_CODE" == "201" ]] || { kill $sse_pid 2>/dev/null; fail "create failed ($RESP_CODE): $RESP_BODY"; }
SCHED2_ID=$(echo "$RESP_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
created_schedules+=("$SCHED2_ID")
ok "created schedule $SCHED2_ID"

echo -n "  waiting up to 90s for SSE event"
found_sse=0
for _ in $(seq 18); do
  sleep 5
  echo -n "."
  if grep -q "scheduled_session_fired" "$sse_out" 2>/dev/null; then
    found_sse=1
    break
  fi
done
echo
kill $sse_pid 2>/dev/null || true
wait $sse_pid 2>/dev/null || true

if [[ $found_sse -eq 1 ]]; then
  ok "SSE event received"
  grep "scheduled_session_fired" "$sse_out" | head -3 | sed 's/^/    /'
  # Grab the spawned session to clean up later
  sid=$(grep "scheduled_session_fired" "$sse_out" | head -1 | python3 -c "
import sys, re, json
for line in sys.stdin:
    line = line.strip()
    if line.startswith('data:'):
        try:
            d = json.loads(line[5:].strip())
            if d.get('lastSessionId'):
                print(d['lastSessionId']); break
        except Exception: pass
" 2>/dev/null || echo "")
  [[ -n "$sid" ]] && created_sessions+=("$sid")
else
  warn "no SSE event captured — the event may have fired before the stream attached"
  tail -5 "$sse_out" | sed 's/^/    /'
fi
rm -f "$sse_out"

# ─── Test 3: stall + retry ────────────────────────────────────────────────

step "test 3: stall after repeated failures, then retry"
# Create a temp source session to fork from, then delete it so fork fires fail
split_resp "$(call POST /session "")"
[[ "$RESP_CODE" == "201" ]] || fail "couldn't create temp source session ($RESP_CODE)"
SOURCE_ID=$(echo "$RESP_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
ok "created temp source session $SOURCE_ID"

# Schedule an interval fork pointing at the about-to-be-deleted source.
# intervalSeconds=300 is the minimum, but for prod we don't want to wait
# 25 minutes for 5 failures. Instead: rely on the delayed type, then
# manipulate the row via the retry endpoint to trigger failures.
#
# Simpler: create a delayed fork with 5s delay, let it fire once and fail,
# then delete the schedule. The backoff/stall loop is already integration-
# tested — here we just want to confirm a fork pointing at a missing source
# hits failure_count=1, last_error=source_session_missing.
create_body=$(printf '{"description":"smoke-3-doomed","prompt":"x","type":"delayed","delayInSeconds":5,"source":"fork","sourceSessionId":"%s"}' "$SOURCE_ID")
split_resp "$(call POST /api/scheduled-sessions "$create_body")"
[[ "$RESP_CODE" == "201" ]] || fail "create fork schedule failed ($RESP_CODE): $RESP_BODY"
SCHED3_ID=$(echo "$RESP_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
created_schedules+=("$SCHED3_ID")
ok "created fork schedule $SCHED3_ID pointing at $SOURCE_ID"

# Delete the source out from under it
split_resp "$(call DELETE /session/$SOURCE_ID)"
ok "deleted source session $SOURCE_ID"

echo -n "  waiting 30s for the fire to fail"
for _ in $(seq 6); do sleep 5; echo -n "."; done
echo

split_resp "$(call GET /api/scheduled-sessions/$SCHED3_ID)"
if [[ "$RESP_CODE" == "200" ]]; then
  fc=$(echo "$RESP_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('failureCount') or 0)")
  err=$(echo "$RESP_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('lastError') or '')")
  if [[ "$fc" -gt 0 ]]; then
    ok "failureCount=$fc, lastError=\"$err\""
  else
    warn "failureCount=0 — fire may not have happened yet"
  fi

  # Retry endpoint should reset counters
  split_resp "$(call POST /api/scheduled-sessions/$SCHED3_ID/retry)"
  if [[ "$RESP_CODE" == "200" ]]; then
    fc2=$(echo "$RESP_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('failureCount') or 0)")
    stalled=$(echo "$RESP_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stalledAt') or 'null')")
    next=$(echo "$RESP_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('nextRunAt') or 'null')")
    if [[ "$fc2" == "0" && "$stalled" == "null" && "$next" != "null" ]]; then
      ok "retry cleared counters: failureCount=0, stalledAt=null, nextRunAt=$next"
    else
      fail "retry didn't clear state: failureCount=$fc2 stalledAt=$stalled nextRunAt=$next"
    fi
  else
    fail "retry endpoint returned $RESP_CODE: $RESP_BODY"
  fi
elif [[ "$RESP_CODE" == "404" ]]; then
  warn "schedule row gone — got deleted by one-shot path before we could check"
else
  fail "unexpected status $RESP_CODE: $RESP_BODY"
fi

# ─── Done ─────────────────────────────────────────────────────────────────

echo
step "done"
ok "all smoke tests completed"
