---
name: cross-review
description: "Review a plan, commit, or work unit through 4 lenses — Correctness, Design, Risk, Test — before merge. Trigger on every non-trivial change (more than two files or any new logic path) as the cross-review gate in the coordinator loop."
triggers:
  - cross-review
  - code review
  - review plan
  - review commit
  - pre-merge
capabilities:
  - correctness-review
  - design-review
  - risk-review
  - test-review
---

# Cross-Review

Cross-review is the pre-merge gate. Use a different engine than the implementer.
Review the current HEAD and current diff, not a stale summary.

## When to use

- change touches more than 2 files
- new logic path, branch, handler, or contract
- implementer claims the task is done
- any merge-ready non-trivial unit

Skip typo fixes, one-line config edits, and flaky-test reruns.

## When not to use

Do not run the full gate for a read-only status check or an unchanged artifact.
Do not use review to settle a product-direction dispute; route that to `plan-debate`.

## Steps

1. Summarize the change in 2-4 sentences, including the riskiest area.
2. For every `BLOCKER` or `HIGH`, fact-check on current HEAD:
   - re-read the actual file
   - rerun the exact command or repro if relevant
   - confirm the issue still exists now
3. Run the four lenses.
4. Grade must-have coverage as `PASS`, `FAIL`, or `UNKNOWN`.
5. Check that confirmed findings do not contradict questions or the final verdict,
   and that stated totals match listed items.
6. Report only the top findings in the compact schema below.

## Four lenses

### Correctness

- claimed behavior matches code
- edge cases, error paths, and return values hold
- every branch return matches its declared output type
- spec-vs-code claims are checked against real files
- if a claimed symbol or behavior cannot be found, first verify exact path,
  name, version, rename history, or generated location
- until that mapping is verified, missing hits are `UNKNOWN`, not an automatic lie
- search semantic predecessors and callers, not only the proposed new symbol

### Design

- responsibility and abstraction level are coherent
- coupling or interface bloat is justified
- naming matches intent

### Risk

- security, authz, logging, data loss, rollback, blast radius, concurrency
- for multi-tenant paths, identify which layer owns isolation

### Test

- tests assert behavior, not trivia
- failure paths and edge cases are covered
- branch coverage claims are spot-checked
- test isolation holds

## Must-have coverage

Use the task contract, brief, or plan:

- `PASS` if all must-haves are present and no non-goal was violated
- `FAIL` if a must-have is missing or contradicted, or a non-goal was broken
- `UNKNOWN` if the artifact does not prove the answer

## Finding rules

Each finding should have:

- severity: `BLOCKER`, `HIGH`, `MEDIUM`, `LOW`
- label: `issue`, `suggestion`, `question`, `nitpick`, `praise`, or `note`
- classification: `plan-blocker`, `introduced-defect`, `implementation-detail`, or `adjacent-issue`
- one-line evidence anchor such as `file:line`, command output, or repro

Use `question(...)` when unsure. Do not turn uncertainty into a blocking claim.
For unsupported counts, thresholds, or matrices, do not invent an exact replacement.
State the gap and ask the question.

If the real disagreement is about direction rather than a provable defect,
escalate to `plan-debate`.

## Output schema

Keep the report to the top 7 findings.

```md
## Cross-Review — <artifact>
Engine: <reviewer> reviewing <implementer>
Lenses: Correctness, Design, Risk, Test
Must-have coverage: <PASS | FAIL | UNKNOWN>

### Understanding
<2-4 sentence summary + riskiest area>

### Findings
[HIGH] issue(blocking): path:line — summary
CLASS: introduced-defect
EVIDENCE: <file:line | command | repro>
FIX: <one line>

### Verdict
APPROVE | CHANGES REQUESTED | RE-PLAN
```

Prefer one-line `FIX:` items. Put out-of-scope pre-existing problems in
`adjacent-issue`; do not block the merge on them unless the current change makes
them worse or depends on them being solved.

## Verification

Approve only when must-have coverage is `PASS`, every blocking claim is confirmed
on current HEAD, and the repository's deterministic confidence gate passes.
