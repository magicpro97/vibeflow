#!/usr/bin/env bash
# test/scripts-gh-spike.test.sh
#
# Sentinel test for the F5 gh integration spike.
# Refuses to fail in environments without `gh` or with the wrong active
# account — it `skip`s so it can be wired into local-dev tooling without
# breaking unrelated CI.

set -euo pipefail

REQUIRED_ACCOUNT="magicpro97"
SPIKE="scripts/gh-spike.sh"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
skip_() { printf '\033[33mSKIP\033[0m: %s\n' "$*"; }

# --- Pre-flight: gh + account ---------------------------------------------
if ! command -v gh >/dev/null 2>&1; then
  skip_ "gh not installed"
  exit 0
fi

auth_status="$(gh auth status 2>&1 || true)"
active_account="$(printf '%s\n' "$auth_status" | awk '
  /Logged in to github.com account/ {
    name = $0
    sub(/.*account /, "", name)
    sub(/[[:space:]].*$/, "", name)
    next
  }
  /Active (account|session):[ \t]*true/ { print name; exit }
')"

if [ -z "$active_account" ]; then
  skip_ "no active gh account"
  exit 0
fi

if [ "$active_account" != "$REQUIRED_ACCOUNT" ]; then
  skip_ "active gh account is '$active_account', expected '$REQUIRED_ACCOUNT'"
  exit 0
fi

# --- Run the spike --------------------------------------------------------
# We run the spike TWICE: once with SKIP_NETWORK=1 and once without. Both
# runs must execute the auth guard (the `✓ step 1: account is magicpro97`
# line is present in both). This guards against a regression that moves
# the SKIP_NETWORK check above the auth guard.
tmp_out="$(mktemp)"
tmp_err="$(mktemp)"
trap 'rm -f "$tmp_out" "$tmp_err"' EXIT

run_spike() {
  # run_spike <label> [env-overrides...]
  local label="$1"
  shift
  echo "Running: $@ bash $SPIKE"
  set +e
  "$@" bash "$SPIKE" >"$tmp_out" 2>"$tmp_err"
  local rc=$?
  set -e
  local stdout stderr
  stdout="$(cat "$tmp_out")"
  stderr="$(cat "$tmp_err")"
  if [ $rc -ne 0 ]; then
    red "[$label] spike exited $rc"
    printf '--- stdout ---\n%s\n' "$stdout"
    printf '--- stderr ---\n%s\n' "$stderr"
    exit 1
  fi
  # Auth guard must run regardless of SKIP_NETWORK — assert the literal
  # `✓ step 1: account is magicpro97` line is in stdout.
  if ! printf '%s\n' "$stdout" | grep -qE "^  ✓ step 1: account is $REQUIRED_ACCOUNT$"; then
    red "[$label] auth guard did not run (no `✓ step 1: account is $REQUIRED_ACCOUNT` line)"
    printf '--- stdout ---\n%s\n' "$stdout"
    exit 1
  fi
  # All 7 step headers must be present.
  local missing=0 n
  for n in 1 2 3 4 5 6 7; do
    if ! printf '%s\n' "$stdout" | grep -qE "^✓ step $n:"; then
      red "[$label] missing step $n line"
      missing=1
    fi
  done
  if [ $missing -ne 0 ]; then
    printf '--- stdout ---\n%s\n' "$stdout"
    exit 1
  fi
  # Final summary line.
  if ! printf '%s\n' "$stdout" | grep -qE "magicpro97/vibeflow: account=$REQUIRED_ACCOUNT, project#6="; then
    red "[$label] missing final summary line"
    printf '--- stdout ---\n%s\n' "$stdout"
    exit 1
  fi
  # Mode-specific banner.
  case "$label" in
    skip)
      if ! printf '%s\n' "$stdout" | grep -q "SKIP_NETWORK=1: skipping round-trip"; then
        red "[$label] SKIP_NETWORK banner not found"
        printf '--- stdout ---\n%s\n' "$stdout"
        exit 1
      fi
      ;;
    live) : ;;
    *) red "[$label] unknown run label"; exit 1 ;;
  esac
}

run_spike live env
run_spike skip env SKIP_NETWORK=1

green "OK (7 steps + final summary present in both live and SKIP_NETWORK runs; auth guard ran in both)"
exit 0
