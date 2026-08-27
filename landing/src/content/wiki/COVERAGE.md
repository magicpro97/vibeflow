---
title: Coverage
description: Reference for VibeFlow CLI flags, coverage enforcement rules, anti-patterns suite, and bun:coverage quirks.
category: reference
last_updated: 2026-08-27
---

# VibeFlow CLI flag reference

## Contents

- [`vf init --ai --autopilot`](#vf-init---ai---autopilot)
- [How It is Enforced](#how-its-enforced)
- [What to Do When You Add a New File and Coverage Drops](#what-to-do-when-you-add-a-new-file-and-coverage-drops)
- [bun:coverage Quirks](#buncoverage-quirks)
- [Anti-Patterns Suite](#anti-patterns-suite)
- [When You Have a Real Coverage Blocker](#when-you-have-a-real-coverage-blocker)

This document tracks every non-trivial flag in the VibeFlow CLI that the
release notes, marketing copy, or new contributors need to know about.
It is maintained alongside the source: when a flag is added or its
behavior changes, update the entry here in the same commit.

## `vf init --ai --autopilot`

**Added in:** `feat(ai-init): add --autopilot flag for engine auto-fallback`

**Summary:** When the chosen engine is unavailable or returns a
permission/unauthorized error, automatically fall back to the
next-best ready engine instead of failing hard.

**Default:** `false` (preserves pre-existing single-shot behavior; a
failure is the user's problem to debug).

**Scope:** The flag is on `vf init --ai`, NOT a global flag. Only the
AI-powered enrichment phase (Phase 2 of `vf init`) is affected. The
deterministic baseline (Phase 1) is unchanged.

**Behavior:**

1. If `forceEngine` (from `--engine`) is set and the engine is not
   ready, autopilot clears `forceEngine` and falls through to
   `selectBestEngine(readiness)`, which picks the next-best engine in
   priority order: `claude > copilot > codex`.
2. If the engine invocation reports the CLI as unavailable (e.g.
   `copilot` binary missing), autopilot retries with the next-best
   engine.
3. If the engine spawner returns a permission-denied or unauthorized
   response (e.g. copilot missing `--allow-all` flags), autopilot
   retries with the next-best engine.
4. Timeouts and unknown non-zero status codes are NOT retried —
   those indicate an engine-side issue, not a fallback opportunity.
5. Retries are capped at 3 (4 total attempts). The fallback engine
   must be DIFFERENT from the one that just failed (the loop never
   retries the same engine twice).
6. The `AiInitResult` includes a `fallback: { original, used }` field
   when the chosen engine differs from the original request. The CLI
   surfaces this as
   `✔ AI analysis complete (used; fell back from original via --autopilot)`.

**Result on total failure:** If every engine fails (or the only
candidate is unavailable), the result reason is wrapped with
`— exhausted 3 autopilot fallbacks; original request was <engine>` so
the caller knows fallback was attempted and gave up.

**Non-retryable failures (preserved single-shot):** When autopilot is
off, the loop is bypassed entirely. A failure on the first attempt
returns immediately — no fallback is attempted. The original error
message is preserved verbatim.

**Tests:** the behavior has focused coverage in `test/ai-init.test.ts`
and `test/commands-coverage.test.ts`. Do not infer a repository-wide
coverage percentage from those focused tests; only a fresh
`bun run coverage:check` result is coverage evidence.

---

# Coverage policy: fresh lcov evidence, no invented percentage

VibeFlow targets 100% executable line coverage per `src/` file unless
the coverage gate carries an explicit issue-bound waiver. A normal test
pass, a stale `coverage/lcov.info`, or the Bun version is not proof that
the target was met. Report the exact live numerator/denominator from
`bun run coverage:check`.

## How it's enforced

1. `scripts/coverage-gate.cjs` parses freshly generated
   `coverage/lcov.info`. It enforces per-file executable-line coverage
   for `src/`, except entries in its explicit `COVERAGE_WAIVERS` map.
2. `bun run coverage:check` removes old coverage, builds the UI, runs
   Bun 1.4 with the lcov reporter, then runs that gate.
3. `bun run check` — runs typecheck + lint + test + coverage:check.
4. `.github/workflows/ci.yml` runs the same coverage command. Its result
   is authoritative only after the current commit's job is green.

## What to do when you add a new file and coverage drops

### Option A: Cover the new code with a test (always preferred)

1. Add the new src/ file.
2. Add `test/foo.test.ts` with at least one `expect()` per public
   function.
3. Run `bun run coverage:check` to confirm.

### Option B: Extract and test a real seam

If the code path depends on a network, filesystem, clock, process, or
platform boundary, inject that dependency and drive both success and
failure branches. Do not reshape production control flow merely to make
the reporter count fewer lines.

### Option C: Use an issue-bound waiver (last resort)

When a platform-only path cannot run in the current job, add the narrow
file waiver required by `scripts/coverage-gate.cjs`, with an owner,
issue, expiry, and a dedicated platform test job.

## bun:coverage quirks

1. Bun 1.4 can generate the lcov file used by this repository, including
   executable `DA` line records. That fixes neither missing tests nor a
   stale report.
2. **The current Bun 1.4 lcov path emits no BRDA records in this suite**,
   so branch coverage reports `0/0`. The `::notice::` line in
   `coverage-gate.cjs` makes that blind spot explicit; do not call it
   100% branch coverage.
3. **`setInterval(() => {...}, 25000)` callback body never hits in
   tests** because tests complete in <25s. Either exercise the
   callback in a test, or use an `inject.timer` seam.

## Anti-patterns suite

`test/coverage-anti-patterns.test.ts` rejects structural patterns that
make coverage or test isolation unreliable, including top-level spawn,
empty catches, and raw `Bun.spawn` in tests. It is a hygiene gate, not a
substitute for the lcov result.

## When you have a real coverage blocker

Open an issue with the file, uncovered executable line, runtime
condition, and an expiry/owner for any temporary waiver. Prefer an
injected seam and a real test. Do not hide a gap with a type cast,
formatting trick, stale lcov file, or an untracked ignore.

---

**Related:** [Master Spec](./MASTER_SPEC.md) · [Generated Files](./GENERATED_FILES.md)
[Edit this page on GitHub](https://github.com/magicpro97/vibeflow/edit/main/docs/COVERAGE.md)
