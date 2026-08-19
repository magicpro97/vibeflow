# Coordinator Operations

Load this file only for recovery and publish details.

## Brief corruption

Treat the brief as corrupted if it is empty, truncated, has broken section
markers, an impossible `last-consult`, or leftover temporary files.

Recovery:

1. Check for a clean backup such as `.vibeflow/knowledge/coordinator-brief.md.*`.
2. Restore the clean backup if one exists.
3. Otherwise run `vf state brief write` and tell the user the prior brief was
   lost or incomplete.
4. Never guess missing brief content.

## Failed-dispatch salvage

If a dispatched unit hangs, crashes, exits non-zero, or returns an untrusted
summary:

1. Inspect the worktree directly.
2. Check `git -C <worktree> status` and `git -C <worktree> diff --stat`.
3. Salvage correct partial edits when possible.
4. Re-dispatch once with narrower scope if needed.
5. Do not treat missing telemetry or missing `DONE` text as proof of failure or success.

## Commit and DCO

Use a conventional commit subject. Include DCO when the workflow requires it.
Do not use `--no-verify` or force-push except `--force-with-lease` when truly necessary.
