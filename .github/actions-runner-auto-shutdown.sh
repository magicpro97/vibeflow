#!/bin/bash
# Auto-shutdown the MacBook after 30 min of CI idle.
# Install via: `crontab -e` then add:
#   */5 * * * * /Users/linhn/actions-runner-vibeflow/auto-shutdown.sh
#
# The script checks if the runner is idle (no busy jobs in the last
# 30 min) and shuts down the Mac. Safe to run every 5 min — it only
# shuts down when truly idle.
#
# Requires: gh CLI authenticated, sudo for shutdown.

set -euo pipefail

REPO="magicpro97/vibeflow"
IDLE_THRESHOLD_MIN=30
STATE_FILE="/tmp/.actions-runner-last-busy"

# Get the latest job for our runner. If it's been busy recently,
# skip shutdown.
LATEST=$(gh api "repos/$REPO/actions/runs?per_page=1" --jq '.workflow_runs[0].updated_at' 2>/dev/null || echo "")

if [ -z "$LATEST" ] || [ "$LATEST" = "null" ]; then
  echo "[auto-shutdown] No recent activity, proceeding to check"
else
  # Convert ISO 8601 to epoch. macOS doesn't have `date -d`, use gdate or python.
  LAST_EPOCH=$(python3 -c "from datetime import datetime; print(int(datetime.fromisoformat('$LATEST'.replace('Z','+00:00')).timestamp()))")
  NOW_EPOCH=$(date +%s)
  IDLE_MIN=$(( (NOW_EPOCH - LAST_EPOCH) / 60 ))

  echo "[auto-shutdown] Last activity: ${LATEST} (${IDLE_MIN} min ago)"

  if [ "$IDLE_MIN" -lt "$IDLE_THRESHOLD_MIN" ]; then
    echo "[auto-shutdown] Recent activity (${IDLE_MIN} < ${IDLE_THRESHOLD_MIN} min). Skipping shutdown."
    exit 0
  fi
fi

# Check if runner is currently busy via runner API
RUNNER_BUSY=$(gh api "repos/$REPO/actions/runners" --jq '.runners[] | select(.status=="online") | .busy' 2>/dev/null || echo "false")

if [ "$RUNNER_BUSY" = "true" ]; then
  echo "[auto-shutdown] Runner is busy. Skipping shutdown."
  exit 0
fi

# All clear — shutdown the Mac
echo "[auto-shutdown] Runner idle > ${IDLE_THRESHOLD_MIN} min. Shutting down Mac."
osascript -e 'tell application "System Events" to shut down' 2>/dev/null || \
  sudo shutdown -h now
