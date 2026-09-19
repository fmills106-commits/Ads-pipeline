#!/usr/bin/env bash
#
# End-to-end smoke test for the Phase 1 surface.
#
# Exercises the real HTTP stack — cookies, route handlers, tenant guards — in a
# way unit and database tests cannot: it proves the wiring, not just the logic.
# The decisive check is the last one: tenant A must not be able to read or write
# tenant B's data over HTTP, and the refusal must look like a 404.
#
# Usage:  ./scripts/smoke.sh [base-url]        (default http://127.0.0.1:3000)
# Expects a running dev server and a migrated database.

set -euo pipefail

BASE="${1:-http://127.0.0.1:3000}"
JAR_A="$(mktemp)"
JAR_B="$(mktemp)"
BODY="$(mktemp)"
STAMP="$(date +%s)-$RANDOM"
PASSWORD='correct-horse-battery-staple'
trap 'rm -f "$JAR_A" "$JAR_B" "$BODY"' EXIT

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }

post() { # jar path json -> prints status code
  curl -sS -o "$BODY" -w '%{http_code}' \
    -b "$1" -c "$1" -X POST "$BASE$2" \
    -H 'content-type: application/json' -d "$3"
}
get() { # jar path -> prints status code
  curl -sS -o "$BODY" -w '%{http_code}' -b "$1" -c "$1" "$BASE$2"
}
# Minimal JSON field reader — avoids a jq dependency for a handful of lookups.
field() { node -e '
  const data = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const path = process.argv[2].split(".");
  let value = data;
  for (const key of path) value = Array.isArray(value) ? value[Number(key)] : value?.[key];
  process.stdout.write(String(value ?? ""));
' "$BODY" "$1"; }

echo "Smoke test against $BASE"

# --- health -------------------------------------------------------------------
[ "$(get "$JAR_A" /api/health)" = 200 ] || fail 'health endpoint unreachable'
grep -q '"database":"up"' "$BODY" || fail 'database not reachable'
pass 'health reports database up'

# --- registration ---------------------------------------------------------------
code=$(post "$JAR_A" /api/auth/register \
  "{\"email\":\"a-$STAMP@example.test\",\"password\":\"$PASSWORD\",\"name\":\"Tenant A\"}")
[ "$code" = 200 ] || fail "register tenant A returned $code: $(cat "$BODY")"
pass 'registered tenant A'

code=$(post "$JAR_B" /api/auth/register \
  "{\"email\":\"b-$STAMP@example.test\",\"password\":\"$PASSWORD\",\"name\":\"Tenant B\"}")
[ "$code" = 200 ] || fail "register tenant B returned $code"
pass 'registered tenant B'

# --- input validation -----------------------------------------------------------
code=$(post "$JAR_A" /api/auth/register \
  "{\"email\":\"a-$STAMP@example.test\",\"password\":\"$PASSWORD\",\"name\":\"Dupe\"}")
[ "$code" = 409 ] || fail "duplicate email should be 409, got $code"
pass 'duplicate email rejected (409)'

code=$(post "$JAR_A" /api/auth/register \
  "{\"email\":\"weak-$STAMP@example.test\",\"password\":\"short\",\"name\":\"Weak\"}")
[ "$code" = 400 ] || fail "weak password should be 400, got $code"
pass 'weak password rejected (400)'

# --- authentication is enforced ---------------------------------------------------
code=$(curl -sS -o "$BODY" -w '%{http_code}' "$BASE/api/workspaces")
[ "$code" = 401 ] || fail "anonymous request should be 401, got $code"
pass 'anonymous request refused (401)'

# --- workspaces --------------------------------------------------------------------
[ "$(get "$JAR_A" /api/workspaces)" = 200 ] || fail 'listing workspaces for A'
WS_A=$(field 'data.0.id'); ROLE_A=$(field 'data.0.role')
[ -n "$WS_A" ] || fail 'tenant A has no workspace'
[ "$ROLE_A" = 'OWNER' ] || fail "expected OWNER, got $ROLE_A"
pass "tenant A owns workspace $WS_A"

[ "$(get "$JAR_B" /api/workspaces)" = 200 ] || fail 'listing workspaces for B'
WS_B=$(field 'data.0.id')
[ -n "$WS_B" ] || fail 'tenant B has no workspace'
[ "$WS_A" != "$WS_B" ] || fail 'both tenants resolved to the same workspace'
pass "tenant B owns workspace $WS_B"

# --- businesses ---------------------------------------------------------------------
# Two deliberately unrelated businesses: the engine must not care what either sells.
code=$(post "$JAR_A" /api/businesses \
  "{\"workspaceId\":\"$WS_A\",\"name\":\"Alpine Coffee $STAMP\",\"industry\":\"Specialty food\",\"websiteUrl\":\"https://alpine.example.com\"}")
[ "$code" = 200 ] || fail "creating business A returned $code: $(cat "$BODY")"
BIZ_A=$(field 'data.id')
[ "$(field 'data.automationLevel')" = 'MANUAL' ] || fail 'business should default to automation Level 1'
pass 'created business A at automation Level 1'

code=$(post "$JAR_B" /api/businesses \
  "{\"workspaceId\":\"$WS_B\",\"name\":\"Harbour Marine $STAMP\",\"industry\":\"Industrial equipment\"}")
[ "$code" = 200 ] || fail "creating business B returned $code"
pass 'created business B in an unrelated industry'

# --- SSRF guard -----------------------------------------------------------------------
code=$(post "$JAR_A" /api/businesses \
  "{\"workspaceId\":\"$WS_A\",\"name\":\"Metadata probe $STAMP\",\"websiteUrl\":\"http://169.254.169.254/latest/meta-data/\"}")
[ "$code" = 400 ] || fail "cloud metadata URL should be 400, got $code"
pass 'cloud metadata URL rejected (400)'

# --- tenant isolation over HTTP ---------------------------------------------------------
[ "$(get "$JAR_A" "/api/businesses?workspaceId=$WS_A")" = 200 ] || fail 'listing A'
grep -q "$BIZ_A" "$BODY" || fail 'A cannot see its own business'
grep -q 'Harbour Marine' "$BODY" && fail 'LEAK: tenant A can see tenant B data'
pass 'tenant A sees only its own businesses'

code=$(get "$JAR_A" "/api/businesses?workspaceId=$WS_B")
[ "$code" = 404 ] || fail "reading B's workspace as A should be 404, got $code"
pass "cross-tenant read refused as 404 (not 403 — existence is not confirmed)"

code=$(post "$JAR_A" /api/businesses "{\"workspaceId\":\"$WS_B\",\"name\":\"Injected $STAMP\"}")
[ "$code" = 404 ] || fail "writing into B's workspace as A should be 404, got $code"
pass 'cross-tenant write refused as 404'

[ "$(get "$JAR_B" "/api/businesses?workspaceId=$WS_B")" = 200 ] || fail 'listing B'
grep -q 'Injected' "$BODY" && fail 'LEAK: cross-tenant write actually landed'
pass "tenant B's data was not modified"

# --- sign out revokes immediately ----------------------------------------------------------
[ "$(post "$JAR_A" /api/auth/logout '{}')" = 200 ] || fail 'logout'
code=$(get "$JAR_A" /api/workspaces)
[ "$code" = 401 ] || fail "session should be dead after logout, got $code"
pass 'session revoked immediately on sign-out'

echo
printf '\033[32mSmoke test passed.\033[0m\n'
