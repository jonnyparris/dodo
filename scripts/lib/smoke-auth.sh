# shellcheck shell=bash
# Shared auth for the smoke scripts. Source it, then call `smoke_curl URL ARGS...`.
#
# AUTH_MODE:
#   auto          (default) service-token if credentials are found, else none
#   service-token CF-Access-Client-Id/Secret headers. Unattended, never expires
#                 mid-run, works from any network. The Access app needs a
#                 non_identity policy that includes the token; the Worker maps
#                 service tokens to ADMIN_EMAIL (src/auth.ts).
#   none          plain curl. Only passes Access if the device's WARP session
#                 is enrolled in the SAME Zero Trust org as the Dodo app. A WARP
#                 client enrolled in a different org gets a 302 with
#                 "Please authenticate via the warp client".
#   access        `cloudflared access curl` (browser login when the cache lapses).
#
# Service-token credentials, first match wins:
#   1. DODO_ACCESS_CLIENT_ID + DODO_ACCESS_CLIENT_SECRET env vars
#   2. macOS keychain, service "dodo-smoke-access", accounts "client_id" and
#      "client_secret":
#        security add-generic-password -U -s dodo-smoke-access -a client_id -w <id>
#        security add-generic-password -U -s dodo-smoke-access -a client_secret -w <secret>

AUTH_MODE="${AUTH_MODE:-auto}"

_smoke_keychain() {
  command -v security >/dev/null 2>&1 || return 1
  security find-generic-password -s dodo-smoke-access -a "$1" -w 2>/dev/null
}

if [[ "$AUTH_MODE" == "auto" || "$AUTH_MODE" == "service-token" ]]; then
  DODO_ACCESS_CLIENT_ID="${DODO_ACCESS_CLIENT_ID:-$(_smoke_keychain client_id || true)}"
  DODO_ACCESS_CLIENT_SECRET="${DODO_ACCESS_CLIENT_SECRET:-$(_smoke_keychain client_secret || true)}"
  if [[ -n "$DODO_ACCESS_CLIENT_ID" && -n "$DODO_ACCESS_CLIENT_SECRET" ]]; then
    AUTH_MODE="service-token"
  elif [[ "$AUTH_MODE" == "service-token" ]]; then
    echo "AUTH_MODE=service-token but no credentials found (env or keychain)" >&2
    exit 1
  else
    AUTH_MODE="none"
  fi
fi

# smoke_curl URL [curl args...]
smoke_curl() {
  local url="$1"; shift
  case "$AUTH_MODE" in
    access)
      # cloudflared access curl: URL first, then curl args (no -- separator).
      cloudflared access curl "$url" "$@"
      ;;
    service-token)
      curl -H "CF-Access-Client-Id: $DODO_ACCESS_CLIENT_ID" \
           -H "CF-Access-Client-Secret: $DODO_ACCESS_CLIENT_SECRET" "$@" "$url"
      ;;
    *)
      curl "$@" "$url"
      ;;
  esac
}
