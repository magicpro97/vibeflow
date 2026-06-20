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
  /Active account: true/ { print name; exit }
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
echo "Running: bash $SPIKE"
tmp_out="$(mktemp)"
tmp_err="$(mktemp)"
trap 'rm -f "$tmp_out" "$tmp_err"' EXIT

set +e
bash "$SPIKE" >"$tmp_out" 2>"$tmp_err"
spike_rc=$?
set -e

stdout="$(cat "$tmp_out")"
stderr="$(cat "$tmp_err")"

if [ $spike_rc -ne 0 ]; then
  red "spike exited $spike_rc"
  printf '--- stdout ---\n%s\n' "$stdout"
  printf '--- stderr ---\n%s\n' "$stderr"
  exit 1
fi

# --- Assert all 7 step lines present --------------------------------------
missing=0
for n in 1 2 3 4 5 6 7; do
  if ! printf '%s\n' "$stdout" | grep -qE "^✓ step $n:"; then
    red "missing step $n line"
    missing=1
  fi
done

if [ $missing -ne 0 ]; then
  printf '--- stdout ---\n%s\n' "$stdout"
  exit 1
fi

# --- Assert the final summary line ---------------------------------------
if ! printf '%s\n' "$stdout" | grep -qE "magicpro97/vibeflow: account=$REQUIRED_ACCOUNT, project#6="; then
  red "missing final summary line"
  printf '--- stdout ---\n%s\n' "$stdout"
  exit 1
fi

# --- SKIP_NETWORK path assertion ------------------------------------------
if [ "${SKIP_NETWORK:-0}" = "1" ]; then
  if ! printf '%s\n' "$stdout" | grep -q "SKIP_NETWORK=1: skipping round-trip"; then
    red "SKIP_NETWORK=1 set but spike did not report skipping round-trip"
    printf '--- stdout ---\n%s\n' "$stdout"
    exit 1
  fi
  green "OK (SKIP_NETWORK=1 mode, round-trip reported as skipped)"
  exit 0
fi

green "OK (7 steps + final summary present)"
exit 0
