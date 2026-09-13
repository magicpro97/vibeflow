---
name: tdd-bun-regression
description: Use when repairing or preventing VibeFlow TypeScript/Bun regressions with behavior-first tests, real runtime seams, and fresh exact-head verification.
metadata:
  scope: project
  project.id: magicpro97/vibeflow
  status: verified
  capabilities:
    - regression-driven Bun tests
    - real behavior assertions
    - injectable native test seams
    - normative proof refresh
    - exact-head verification
  triggers:
    - regression test
    - test-first bug fix
    - red green refactor
    - Bun test failure
    - behavior regression
  requires:
    filesystem: write
    network: false
    shell: true
---

# TDD Bun Regression

Use this skill for VibeFlow behavior regressions where a focused `bun:test` case should
pin the failure before the smallest production fix. Keep test evidence tied to real public
behavior and current repository state.

## When to use

- a bug changes observable CLI, runtime, API, UI, filesystem, process, or protocol behavior
- a fix needs a regression test before production code changes
- a test needs a narrow seam for a clock, native process, filesystem, or other nondeterministic boundary
- a prior green test no longer proves the behavior after a refactor

## When not to use

- documentation, formatting, or copy-only changes with no behavior change
- exploratory spikes where behavior and acceptance criteria are not yet known
- a pure test-fixture cleanup with no regression risk

## Steps

1. Reproduce failure on current HEAD. Read nearest implementation and tests, identify public behavior, and choose the smallest affected `bun:test` file. Record the real input, output/state transition, error, and cleanup expectation.
2. **RED-GREEN-REFACTOR:** Follow this cycle; each phase keeps behavior evidence tied to real runtime seams.
   **RED:** Add one descriptive behavior test that fails for the reported reason. Run the focused command:
   ```bash
   bun test test/path.test.ts --test-name-pattern "describes regression"
   ```
   Assert returned data, emitted events, persisted state, error shape, or resource cleanup—not private call counts. Use a seam only at an actual nondeterministic boundary (for example injected clock, launcher, filesystem, or platform adapter); keep the behavior path real.
3. **GREEN:** Make smallest production change that satisfies failing behavior and preserves existing contracts. Run focused test again, then the affected suite:
   ```bash
   bun test test/path.test.ts
   bun test test/related-area.test.ts
   ```
   Cover success, rejection, boundary, and cleanup cases relevant to regression. Do not weaken assertions, add retries, sleeps, or mock-only substitutes to hide a race.
4. **REFACTOR:** Remove accidental duplication, keep ESM/Node-targeted boundaries intact, and retain the narrow seam only when it represents a real runtime boundary. Re-run focused and affected tests after each meaningful refactor.
5. Refresh normative evidence after any test or production change, then check the generated matrix:
   ```bash
   bun run scripts/refresh-normative-proofs.ts
   bun run normative:check
   ```
6. Finish with repository gates on same current HEAD. Run `bun run fix` before checks; include UI E2E when UI/components/DTOs changed. Keep verification hooks enabled and do not bypass them.

## Verification

Run full gate in this order:

```bash
bun run fix
bun run check
bun run build
bun run scripts/refresh-normative-proofs.ts
git diff --check
vf verify
```

`bun run check` is full CI-equivalent local check: typecheck, lint, file-size, waiver,
whole-repository tests, and coverage. `vf verify` is additional VibeFlow confidence and
evidence proof, not a replacement for `bun run check`. Confirm focused behavior evidence,
refreshed normative proofs, full check, and `vf verify` all refer to current HEAD before
claiming regression fixed.
