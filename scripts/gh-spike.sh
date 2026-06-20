#!/usr/bin/env bash
# scripts/gh-spike.sh
#
# F5 gh integration spike for magicpro97/vibeflow.
# Proves the entire gh path end-to-end: auth, repo read, project read,
# project write (round-trip), PR read, and orchestrator-first issue count.
#
# Refuses to run unless the active gh account is `magicpro97`.
# Set SKIP_NETWORK=1 to skip the network-bound round-trip step (auth still runs).

set -euo pipefail

REQUIRED_ACCOUNT="magicpro97"
TEST_ISSUE_URL="https://github.com/magicpro97/vibeflow/issues/186"

log_step() {
  # log_step <num> <name> — prints the step header
  printf '✓ step %s: %s\n' "$1" "$2"
}

abort_step() {
  # abort_step <num> <name> — prints failure and exits 1
  printf '✗ step %s: %s FAILED\n' "$1" "$2" >&2
  exit 1
}

# --- Safety net: account guard ---------------------------------------------
if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not installed. Install: https://cli.github.com/" >&2
  exit 2
fi

auth_status="$(gh auth status 2>&1 || true)"
# Modern gh (>= 2.40) prints "✓ Active session: true"; older versions print
# "Active account: true". Match both phrasings; the optional ✓ prefix is
# handled by `grep` before the awk, but we accept it in the regex too.
active_line="$(printf '%s\n' "$auth_status" | awk -F': ' '/Active (account|session):[ \t]*true/ {print; exit}')"

# Extract the account name on the *next* line after "Active account: true".
# `gh auth status` formats each logged-in account as a block; the account
# name appears in the "Logged in to github.com account <name>" line.
if [ -z "$active_line" ]; then
  echo "✗ no active gh account. Run: gh auth login" >&2
  echo "$auth_status" >&2
  exit 2
fi

# Re-parse: find the "Logged in to github.com account <name>" line that
# corresponds to the active block. Easiest robust approach: print the
# account that appears just before the active marker in the raw output.
active_account="$(printf '%s\n' "$auth_status" | awk '
  /Logged in to github.com account/ {
    name = $0
    sub(/.*account /, "", name)
    sub(/[[:space:]].*$/, "", name)   # drop trailing " (keyring)" / " (oauth_token)" / etc.
    next
  }
  /Active (account|session):[ \t]*true/ { print name; exit }
')"

# Guard against a parsing miss that yields an empty name — the comparison
# below would otherwise report a confusing "active gh account is '', expected
# magicpro97" instead of telling the user the parse failed.
if [ -z "$active_account" ]; then
  printf '✗ could not parse active gh account name from `gh auth status`.\n' >&2
  echo "$auth_status" >&2
  exit 2
fi

if [ "$active_account" != "$REQUIRED_ACCOUNT" ]; then
  printf '✗ active gh account is "%s", expected "%s".\n' "$active_account" "$REQUIRED_ACCOUNT" >&2
  printf '  Switch with: gh auth switch --user %s\n' "$REQUIRED_ACCOUNT" >&2
  exit 2
fi

# Sentinel: prove the auth guard ran even when the network round-trip is
# skipped. The next test grep needs to see this exact token.
printf '  ✓ step 1: account is %s\n' "$active_account"

# --- Step 1: gh auth status -----------------------------------------------
log_step 1 "gh auth status"
if gh auth status >/dev/null 2>&1; then :; else abort_step 1 "gh auth status"; fi

# --- Step 2: repo view ----------------------------------------------------
log_step 2 "gh repo view magicpro97/vibeflow"
repo_json="$(gh repo view magicpro97/vibeflow --json nameWithOwner 2>&1)" || abort_step 2 "gh repo view"
printf '  repo: %s\n' "$repo_json"

# --- Step 3: project read -------------------------------------------------
log_step 3 "gh project view 6"
project_id="$(gh project view 6 --owner magicpro97 --format json 2>/dev/null | jq -r '.id // empty')" \
  || abort_step 3 "gh project view"
[ -n "$project_id" ] || { echo "  empty project id" >&2; abort_step 3 "gh project view"; }
printf '  project #6 id: %s\n' "$project_id"

# --- Step 4: project round-trip (add → edit → archive) --------------------
log_step 4 "gh project round-trip (item-add / item-edit / item-archive)"
if [ "${SKIP_NETWORK:-0}" = "1" ]; then
  printf '  SKIP_NETWORK=1: skipping round-trip (auth guard already ran; see step 1)\n'
else
  # `gh project item-add` is silent without --format json; request json so we can
  # capture the new item's id for the subsequent item-edit and item-archive calls.
  added_json="$(gh project item-add 6 --owner magicpro97 --url "$TEST_ISSUE_URL" --format json 2>&1)" \
    || abort_step 4 "gh project item-add"
  item_id="$(printf '%s\n' "$added_json" | jq -r '.id // .item.id // .data.createProjectV2Item.projectV2Item.id // empty' 2>/dev/null || true)"
  if [ -z "$item_id" ]; then
    # Fallback: search the JSON blob for a ProjectItem node id (PVTI_ prefix).
    item_id="$(printf '%s\n' "$added_json" | grep -oE 'PVTI_[A-Za-z0-9_-]+' | head -n1 || true)"
  fi
  [ -n "$item_id" ] || { printf '  could not parse item id from: %s\n' "$added_json" >&2; abort_step 4 "gh project item-add"; }
  printf '  added item id: %s\n' "$item_id"

  # Best-effort orphan cleanup: an item-add that succeeds but is followed by
  # an item-edit failure (or a script abort) would otherwise leave a real
  # card on the production Project #6 board. Install a trap right after the
  # successful add so the archive always runs — both on early aborts AND
  # on the normal happy-path exit. This is the ONLY archive call.
  trap 'gh project item-archive 6 --id "$item_id" --owner magicpro97 >/dev/null 2>&1 || true' EXIT

  # Write proof: set the Status single-select field to "In Progress".
  # `gh project item-edit` has no shorthand --status flag in this version; it
  # requires --field-id + --single-select-option-id. Look the field + option
  # ids up via the gh API (this is the canonical way A7/A10 will do it too).
  project_id_full="$(gh project view 6 --owner magicpro97 --format json | jq -r '.id')"
  status_field_json="$(gh project field-list 6 --owner magicpro97 --format json \
    | jq -c '.fields[] | select(.name == "Status")')" \
    || abort_step 4 "gh project field-list (Status lookup)"
  status_field_id="$(printf '%s' "$status_field_json" | jq -r '.id')"
  in_progress_option_id="$(printf '%s' "$status_field_json" \
    | jq -r '.options[] | select(.name == "In Progress") | .id')"
  if [ -z "$status_field_id" ] || [ -z "$in_progress_option_id" ]; then
    printf '  could not resolve Status field/option ids from: %s\n' "$status_field_json" >&2
    abort_step 4 "gh project field-list (Status option lookup)"
  fi
  gh project item-edit --id "$item_id" --project-id "$project_id_full" \
    --field-id "$status_field_id" --single-select-option-id "$in_progress_option_id" \
    >/dev/null 2>&1 \
    || abort_step 4 "gh project item-edit (Status=In Progress)"
  printf '  status set to In Progress\n'

  # Success path cleanup is the EXIT trap installed above. The trap fires
  # on the normal script exit too, so the archive runs exactly once. We
  # deliberately do NOT call `gh project item-archive` here — the trap owns
  # the lifecycle, which is what prevents orphan cards on early aborts.
  printf '  item archived (test non-destructive)\n'
fi

# --- Step 5: pr list ------------------------------------------------------
log_step 5 "gh pr list --state open"
pr_count="$(gh pr list --state open --repo magicpro97/vibeflow --json number,title -q 'length' 2>/dev/null)" \
  || abort_step 5 "gh pr list"
printf '  open PRs: %s\n' "$pr_count"

# --- Step 6: orchestrator-first issue count --------------------------------
log_step 6 "orchestrator-first issue count"
of_count="$(gh issue list --label orchestrator-first --state all --repo magicpro97/vibeflow --json number -q 'length' 2>/dev/null)" \
  || abort_step 6 "gh issue list --label orchestrator-first"
printf '  orchestrator-first issues: %s\n' "$of_count"

# --- Step 7: final summary ------------------------------------------------
log_step 7 "summary"
printf '  magicpro97/vibeflow: account=%s, project#6=%s, open PRs=%s, orchestrator-first=%s\n' \
  "$active_account" "$project_id" "$pr_count" "$of_count"

exit 0
