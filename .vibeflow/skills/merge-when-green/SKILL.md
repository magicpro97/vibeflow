---
name: merge-when-green
description: Watch a VibeFlow PR through exact-head review and CI, fix root causes from failing logs, and merge once every required gate for the current SHA is truly green.
scope: project
project.id: magicpro97/vibeflow
status: verified
capabilities:
  - land an authorized pull request
  - repair failing current-sha checks
  - confirm green merge head
  - restore borrowed github authority
  - cross-engine approval before merge
triggers:
  - authorized pull request
  - authorized this pull request
  - windows job is red
  - prior merge permission
  - finish it using the permission i already gave you
  - shepherd pull request to merge
requires:
  filesystem: write
  network: true
  shell: true
---

# Merge When Green

Use this skill after a PR exists and the remaining work is to shepherd it
through review, CI, and merge without drifting away from the exact head under
test.

## When to use

- a PR is open and CI or required evidence is still running
- the coordinator is responsible for merging once all gates pass
- the user has already pre-authorized unattended merge for this run
- a red or stale gate needs root-cause repair before the branch can merge

## When not to use

- there is no PR yet
- the branch still needs implementation or product-direction debate
- the task is a release or publish operation on `main` rather than ordinary PR
  validation

## Steps

1. Record the authority you are borrowing before touching the PR flow: GitHub
   account, temporary git config, stash state, or any other state that must be
   restored at the absolute end.
2. Determine whether unattended merge is already authorized. If the user
   explicitly pre-authorized merge for this run, proceed without asking again.
   Otherwise pause before the final merge action.
3. Inspect the exact head SHA. Start with `gh pr checks <pr> --required`, then
   inspect any additional current gates the repo treats as mandatory for that
   SHA, such as same-SHA native Windows evidence, custom review artifacts, or
   non-required jobs called out by repo policy.
4. Do not assume a `publish` job belongs to ordinary PR validation. Require it
   only when the repo's current workflow or branch protection says publish is a
   gate for this PR; many repos separate publish until merge or tag time.
5. Confirm `mergeable`, cross-review approval from a different engine, and
   fresh exact-head review and `vf verify` evidence. Regenerate review and
   verify evidence whenever an edit, rebase, or other operation changes HEAD or
   the reviewed artifact. A no-op push of the same SHA does not make evidence
   stale or justify another audit loop.
6. If any check fails, read the failing log or artifact first, repair the root
   cause in the worktree, rerun the smallest relevant gate, then rerun the
   exact-head review and final verify steps on the new SHA.
7. Merge intentionally with the chosen conventional-commit subject, then clean
   temporary worktrees and restore borrowed auth or stash state after the final
   push or merge outcome is known.

## Verification

- every required gate for the merge SHA is green on the same SHA
- review evidence and `vf verify` were generated after the latest edit or rebase
- mergeability is clean and review came from a different engine
- borrowed auth, git config, and stash state were restored at the absolute end
