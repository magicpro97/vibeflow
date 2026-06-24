---
name: cross-review
description: "Review a plan, commit, or work unit through 4 lenses — Correctness, Design, Risk, Test — before merge. Trigger on every non-trivial change (> 2 files or any new logic path) as the cross-review gate in the coordinator loop."
---

# Cross-Review

A cross-review is the gate before merge. It uses a DIFFERENT engine than the
implementer (codex reviews claude, claude reviews codex) and reads the diff
through 4 lenses. A green CI gate is not a substitute — tests don't catch
design bugs, security regressions, or scope creep.

## 1. When to trigger

- Any change touching > 2 files.
- Any new logic path (new function, new branch, new error handler).
- Any plan/commit that the implementer self-reports as "done."
- Before merge, always. The review is in the loop, not after it.

Skip for: typo fixes, one-line config changes, re-running a flaky test.

## 1b. Step 0 — prove you understand the change first

Before applying any lens, the reviewer states in 3–6 sentences: what the change
does, how the main changed pieces fit together, and the single riskiest area.
A reviewer who cannot summarize the change cannot review it.

Why this is step zero, not a formality: empirical study of modern code review
(Bacchelli & Bird, *Expectations, Outcomes, and Challenges of Modern Code Review*,
ICSE 2013) found that **code and change understanding is the key aspect of
review**, and that review's durable value is as much knowledge transfer and
alternative solutions as defect-finding. A review that only lists bugs throws
away most of its value. So the report also ends with an "Alternatives & what's
good" note (see §3).

## 2. The 4 lenses

### Lens 1 — Correctness
Does the code do what it claims?

Checklist:
- [ ] The claimed behavior matches the diff (read the commit message + plan).
- [ ] **Spec-vs-code**: for every behavior the plan/commit/PR body claims, find it
  in the diff function-by-function. A claimed change that is missing, partial, or
  contradicted by the code is a BLOCKER. `grep`/`rg` any claimed new symbol — **0
  hits = the claim is a lie = BLOCKER** (the single highest-value finding in a
  strict review; PR descriptions often describe an intended-but-unmerged change).
- [ ] Edge cases: empty input, null/undefined, concurrent access, timeout.
- [ ] Off-by-one: boundaries, array indices, loop conditions.
- [ ] Error paths: do failures propagate or silently swallow?
- [ ] Return values: does every branch return what the caller expects?

### Lens 2 — Design
Is the shape right?

Checklist:
- [ ] Single responsibility: one function, one job. No "and" in the name.
- [ ] Coupling: does this change add a new import dependency that isn't needed?
- [ ] Naming: do names describe the intent or the implementation? (e.g. `save()` not `writeToFile()`).
- [ ] Abstraction level: are high-level and low-level operations mixed in one
  function?
- [ ] Interface bloat: exported things that nothing imports = dead code.

### Lens 3 — Risk
What breaks if this is wrong?

Checklist:
- [ ] Security: user input, auth bypass, secret exposure, injection surface.
- [ ] **Authz on new paths**: every new read/write endpoint checks permission;
  for a cross-tenant/multi-tenant change, name WHICH LAYER owns isolation (app
  vs gateway/mTLS) before rating — if there's no network backstop, app-layer
  validation is the ONLY control and a gap is a BLOCKER, not defense-in-depth.
- [ ] **PII/EUII in logs**: is any personal/identifying data written to logs or
  error messages? (Microsoft Eng Playbook reviewer-guidance: "Are we logging any
  PII information?") Mask it.
- [ ] Data loss: does this delete, overwrite, or migrate data? Is the migration
  reversible?
- [ ] Irreversibility: can this be rolled back? If not, flag as HIGH severity.
- [ ] Blast radius: how many callers/consumers does this change affect?
- [ ] Concurrency: shared state, race windows, lock ordering.

### Lens 4 — Test
Are the tests real?

Checklist:
- [ ] Assert behavior, not trivia: `expect(result).toBe(expected)` not
  `expect(true).toBe(true)`.
- [ ] Cover failure paths: error handler tested, not just happy path.
- [ ] Edge-case coverage: the specific edge cases from Lens 1 have test cases.
- [ ] Branch coverage trap: "100% line coverage" ≠ "all branches tested."
  Spot-check the new code's branches.
- [ ] Test isolation: no shared mutable state between tests.

## 3. How to report findings

Every finding combines a **severity** with a **Conventional Comments label** so the
author can tell a real problem from a suggestion from a nitpick at a glance
(grammar from conventionalcomments.org; Google eng-practices "label comment
severity"):

```
[SEVERITY] <label>(<decoration>): <file:line> — <one-line description>
FIX: <concrete fix suggestion, one sentence>
```

- **label** ∈ `issue` (a real problem) · `suggestion` (a concrete improvement) ·
  `nitpick` (trivial, always non-blocking) · `question` (you're unsure — ask,
  don't assert) · `praise` (call out good work) · `thought`/`note` (observation).
- **decoration** ∈ `(blocking)` must-fix before merge · `(non-blocking)` may defer ·
  `(if-minor)`. Pair every `issue` with a `FIX:`. Use `question` when unsure rather
  than asserting a false `issue`.

Severity levels:
| Level | Meaning | Action |
|-------|---------|--------|
| **BLOCKER** | Data loss, security, irreversibility, a lied-about claim | Must fix before merge |
| **HIGH** | Wrong behavior, broken edge case | Fix before merge |
| **MEDIUM** | Design smell, naming, coupling | Fix in follow-up PR |
| **LOW** | Style nit, dead import | Optional |

A `(blocking)` decoration ⇔ BLOCKER/HIGH; `nitpick`/LOW ⇒ `(non-blocking)`. Never
block merge on what the formatter/linter already enforces.

Report format:
```
## Cross-Review — <artifact name>
Engine: <reviewing engine> reviewing <implementer engine>
Lenses checked: [x] Correctness [x] Design [x] Risk [x] Test

### Understanding
<3–6 sentence summary of what the change does + its riskiest area — proves you read it>

### Findings
[BLOCKER] issue(blocking): src/workflow/dispatch.ts:42 — dispatchAll runs promises sequentially
FIX: Use Promise.all or a proper work-queue with bounded concurrency.

[HIGH] issue(blocking): src/state/ledger.ts:88 — addEvidence overwrites existing evidence array
FIX: Spread the existing array: evidence: [...prev, newEntry].

[MEDIUM] suggestion(non-blocking): src/cli/orchestrate.ts:15 — function name `run` is too generic
FIX: Rename to `orchestrateWorkUnits`.

[LOW] nitpick(non-blocking): src/util/x.ts:3 — unused import
FIX: Remove it.

### Alternatives & what's good
<at least one alternative-solution thought AND one genuine praise — review value is
knowledge transfer, not just defect lists (Bacchelli & Bird, ICSE 2013)>

### Verdict
[ ] APPROVE — merge when CI is green
[x] CHANGES REQUESTED — fix BLOCKER + HIGH before re-review
[ ] REJECT — fundamental design issue, re-plan
```

## 4. Pitfalls

- **Approving on a green CI gate without reading the diff.** CI proves the
  code compiles and existing tests pass. It does not prove the new code is
  correct, well-designed, or safe. Read the diff.
- **Same-engine review.** An engine reviewing its own work is blind to its
  own patterns. Always cross-engine.
- **Nitpicking without severity.** "I would have named it differently" is
  LOW, not HIGH. Don't block merge on style preferences unless they violate
  a documented convention.
- **Missing the blast-radius check.** A 3-line change to a shared utility
  can break 40 callers. Check `rg <function-name>` before approving.
- **Accepting "100% coverage" at face value.** Branch coverage lies. Look
  at the new code's branches and verify each has a test that exercises it.
- **Review fatigue on large diffs.** If the diff is > 500 lines, ask the
  implementer to split it. Review quality drops hard beyond 200-300 lines.
  (SmartBear/Cisco study: defect detection falls off past ~400 LOC; keep each
  focused pass under 200-400 LOC and under 60 minutes.)
- **Treating a finding as fact before reproducing it on HEAD.** A finding is a
  hypothesis until it reproduces against the CURRENT source. Before blocking on
  "this serialize is lossy" or "this is a 2×N read," run a 3-line repro (a
  throwaway `node -e` that calls the actual function on the actual input) or
  re-read HEAD-of-branch — diffs and self-reports go stale. Several "confirmed"
  bugs evaporate this way. Convergence (2+ engines independently flag it) raises
  the prior, but YOU confirm before it goes on the must-fix list.
- **Blocking on out-of-scope adjacent issues.** If the problem isn't introduced
  by this change, file it as a separate task; don't hold the merge hostage.
- **Letting "I'll clean it up later" slide.** Cleanup deferred past the current
  change usually never happens (Google eng-practices pushback). Either fix in
  this change or require a filed ticket + `TODO(#id)` in code — never a bare TODO.

For the full industry basis (Google eng-practices, SmartBear/Cisco numbers,
Microsoft Eng Playbook, Bacchelli & Bird ICSE2013, Conventional Comments, OWASP),
see `references/world-class-standard.md`.
