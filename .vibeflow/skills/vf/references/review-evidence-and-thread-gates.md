# Review evidence & review-thread gates (VibeFlow)

Nguyên văn tách từ SKILL.md 2026-10-07.

## Review evidence is a separate gate

- Code gates can pass while `vf verify` fails
  `review-evidence: record missing`; classify this as missing review evidence,
  not a code failure.
- `vf review evidence --base <full-SHA> --result <file>` binds evidence to the
  exact base SHA, current HEAD, sorted changed manifest, and clean worktree.
  Do not hand-write, fabricate, bypass, or reuse stale evidence.
- **The record attests a CLEAN PASS, not a log of the findings you fixed.** The
  recorder rejects any result whose `findings` array is non-empty
  (`result.findings.length → return 1`), so evidence means "an independent
  review of the exact head returned zero findings" — writing
  `status: "passed"` with `findings: []` for a head no review has cleared is
  fabricating evidence, however many real findings the round produced.
  The loop is therefore review → fix → commit → review AGAIN, repeating until a
  review of the EXACT HEAD comes back clean, and only then record. Re-reviewing
  after a fix round is mandatory, not diligence: fixes change the head, and a
  review of the previous head says nothing about the current one.
- **Every guard in the producer fails the SAME way: exit 1 with no output.** Do
  not guess which one fired — read the `return 1` sites in
  `src/commands/review-evidence.ts` and match the condition: non-ancestor base,
  dirty worktree, manifest/digest disagreement with what the recorder observes,
  non-empty `findings`, or stale review authority. Silence is the signature of
  all of them, so the message never tells you which.
- If worktree is dirty, preserve it and ask before commit, stash, or WIP
  snapshot. After evidence is recorded, run `vf review check --base <full-SHA>`
  and then rerun `vf verify`.
- **In a FRESH WORKTREE `vf verify` fails on two artifacts that are not code**
  (verified 2026-09): (a) `no-workflow-state` → run `vf init --no-ai` inside
  the worktree (writes `.vibeflow/WORKFLOW_STATE.json`); it also regenerates
  tracked files (AGENTS.md, `.github/copilot-instructions.md`, `.githooks/*`,
  `.vibeflow/SETTINGS.json`) — restore those to HEAD with `git checkout --`
  so the branch stays feature-pure; (b) `review-evidence: record missing` →
  the record lives at `.vibeflow/review-evidence/v1/<FULL-HEAD-SHA>.json`,
  written by `vf review evidence --base <base> --result <json>`. Generate the
  reviewer JSON with a tiny bun script that IMPORTS the repo's own
  `src/hooks/review-evidence.ts` (`changedFiles`, `changedManifestDigest`,
  `REVIEWER_RESULT_AUTHORITY`) — never hand-roll the digest. The written
  record self-validates on plain `vf verify` (no `--review-base` needed); it
  requires a clean tree, an ancestor base, and non-empty required IDs
  (docs-only changesets can pass via the #748 fallback).

## Unresolved review threads fail review-thread-gate

CI's `review-thread-gate` job fails while ANY review thread is unresolved —
including threads a review bot (Copilot) opened by itself. It is not a code
signal; triage every thread and either fix it or adjudicate it, then resolve
ALL of them before the gate can pass. Flow:

1. List: `gh api graphql -f query='{repository(owner:"<o>",name:"<r>"){pullRequest(number:<n>){reviewThreads(first:50){nodes{id isResolved path line comments(first:1){nodes{author{login} body}}}}}}}'`
2. Classify: cheap REAL findings → fix them as ONE batch commit (never one
   commit per thread); accepted-by-design / already-fixed → reply with the
   rationale and evidence (file:line, test name, or the fixing commit).
3. Reply in-thread: `mutation { addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:"<id>", body:"…"}) }` —
   `addPullRequestReviewComment` does NOT accept `pullRequestReviewThreadId`
   (it wants reviewId + inReplyTo) and errors; the thread-reply mutation is the one that works.
4. Resolve: `mutation { resolveReviewThread(input:{threadId:"<id>"}) }` —
   the mutation is `resolveReviewThread`; `resolvePullRequestReviewThread`
   does not exist. The gate re-evaluates per push — resolve and push together.
5. The push-time gate run stays FAILED in the rollup even after every thread is
   resolved (its check ran before the threads closed). Re-run THAT run's failed
   job — `gh run rerun <run-id> --failed` — then re-check with
   `gh pr checks --json name,state,bucket` (filter `bucket=="pending"`;
   `conclusion` is NOT a valid field for `gh pr checks`, and `state` casing
   varies — `bucket` is the reliable filter).

A bot thread naming a real defect is still a finding: fix it or document why
not; never resolve silently with no reply.
