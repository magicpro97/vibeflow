#!/usr/bin/env bash
# scripts/guardrail-on.sh
#
# Arm the VibeFlow guardrail for this repo so destructive commands are
# intercepted by Claude's PreToolUse gate (audit B5) when the human (or a
# non-claude engine) is editing without `vf coord` explicitly.
#
# Issue: orchestrator-first plan, F1.
# Idempotent. Safe to re-run.

set -euo pipefail

REPO_ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$REPO_ROOT"

# Resolve the vf binary. Prefer the on-PATH `vf`; fall back to the in-tree dist.
VF_BIN="$(command -v vf || true)"
if [ -z "$VF_BIN" ] && [ -x "./dist/cli.js" ]; then
  VF_BIN="node ./dist/cli.js"
fi
if [ -z "$VF_BIN" ] || ! { [ -x "$VF_BIN" ] || command -v "$VF_BIN" >/dev/null 2>&1; }; then
  echo "FATAL: vf not found on PATH and ./dist/cli.js missing" >&2
  echo "  install: brew install vf (or run \`bun run build\` to produce dist/cli.js)" >&2
  exit 2
fi

# Sanity: must be inside a git repo (VibeFlow reads .vibeflow/*).
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "FATAL: not inside a git working tree" >&2
  exit 2
fi

# Sanity: active gh account must be magicpro97. We will not arm the
# guardrail under a company account — it would route state into a private
# org without the architect's consent.
ACTIVE_ACCOUNT="$(gh auth status 2>&1 | awk -F'account ' '/Active account: true/{print $2}' | awk '{print $1}' | head -1)"
if [ -n "$ACTIVE_ACCOUNT" ] && [ "$ACTIVE_ACCOUNT" != "magicpro97" ]; then
  echo "FATAL: active gh account is '$ACTIVE_ACCOUNT', expected 'magicpro97'" >&2
  echo "  run: gh auth switch --user magicpro97" >&2
  exit 2
fi

echo "== arming guardrail =="

# 1. Write per-engine hook config blocks (re-uses vf hooks emit's pipeline,
#    but is non-interactive because the architect's normal onboarding flow
#    should not require a manual --yes).
if $VF_BIN hooks emit --yes >/dev/null 2>&1; then
  echo "  + per-engine hook configs written (vf hooks emit --yes)"
else
  echo "  ! vf hooks emit --yes did not return 0; rerun manually to diagnose" >&2
  exit 1
fi

# 2. Install the logbus (idempotent — installLogbus replaces the active bus).
if $VF_BIN doctor >/dev/null 2>&1; then
  STATE="$($VF_BIN doctor 2>/dev/null | grep -E 'live guardrail' | awk -F': ' '{print $2}' | awk '{print $1}' | head -1)"
  if [ "$STATE" = "ON" ]; then
    echo "  + live guardrail: ON"
  else
    echo "  ! live guardrail is OFF after emit — check the engine's PreToolUse deny list" >&2
    exit 1
  fi
else
  echo "  ! vf doctor failed; rerun manually" >&2
  exit 1
fi

# 3. Sanity sentinel: try to detect a Write that the guardrail should block.
#    We probe with a known-bad payload (a destructive shell). The result is
#    informational, not gating — the binary's response is logged so the
#    operator can see the live state.
PROBE='{"event":"pre-command","command":"rm -rf /"}'
RESPONSE="$(echo "$PROBE" | $VF_BIN hook 2>&1 || true)"
if echo "$RESPONSE" | grep -qE '"decision":"(block|deny|ask)"'; then
  echo "  + guardrail probe: deny/block/ask as expected"
else
  echo "  ! guardrail probe returned: $RESPONSE" >&2
  echo "    expected decision:block|deny|ask — the guardrail may not be enforcing" >&2
  exit 1
fi

echo "== guardrail armed =="
echo "human-edit fallback is now safe (Claude's PreToolUse will intercept destructive commands)"
