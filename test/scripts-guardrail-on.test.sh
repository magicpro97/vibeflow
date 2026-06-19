#!/usr/bin/env bash
# test/scripts-guardrail-on.test.sh
#
# F1 sentinel: the script exists, is executable, and documents what
# it does. We do NOT exec the script in this test (it requires vf on
# PATH + gh auth + a built dist) — CI runs it via the README's
# guardrail-on.sh invocation.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SCRIPT="$REPO_ROOT/scripts/guardrail-on.sh"

[ -f "$SCRIPT" ] || { echo "FAIL: $SCRIPT missing"; exit 1; }
[ -x "$SCRIPT" ] || { echo "FAIL: $SCRIPT not executable"; exit 1; }
grep -q "vf hooks emit --yes" "$SCRIPT" || { echo "FAIL: script doesn't arm the guardrail"; exit 1; }
grep -q "magicpro97" "$SCRIPT" || { echo "FAIL: script doesn't gate on the active gh account"; exit 1; }

echo "OK: guardrail-on.sh is shipped and looks right"
