# Sequential vf→codex orchestration with per-unit QA (Wave runbook)

Verified recipe for driving a whole wave of codex units through `vf orchestrate`
one at a time, with the agent (Hermes) as QA gate. Battle-tested 2026-09-02 on
sport-host Wave 1 (5 units, KMP repo).

## Setup (once per machine/repo)

1. `~/.codex/config.toml` (global): `sandbox_mode = "danger-full-access"` +
   `approval_policy = "never"` + `model_provider` → 9router
   (`clinepass/cline-pass/deepseek-v4-pro`, base `http://127.0.0.1:20128/v1`,
   `wire_api = "responses"`), plus `[projects."/Users/<you>"] trust_level="trusted"`.
   `workspace-write` is NOT enough — Gradle wrapper/daemon write `~/.gradle`,
   `~/.konan`, Android SDK (all outside the workspace): `.lck Operation not
   permitted`, then codex tries `rm -f` (policy-rejected).
2. Export `CODEX_HOME=$HOME/.codex` for every dispatch. Without it the CLI falls
   back to stale OAuth state (`refresh token was revoked`) even with 9router
   configured — with CODEX_HOME set it uses the clean config. Codex OAuth state
   lives in ~/.codex sqlite; a revoked OAuth session can't be cleared by deleting
   auth.json alone — backup `~/.codex` and recreate.
3. JDK 17: `brew install openjdk@17`, fix `gradle.properties`
   `org.gradle.java.home` to the opt symlink (Cellar paths renumber on upgrade).
4. Version catalog vs spec §9 toolchain table — align kotlinx-datetime (0.8: use
   `kotlin.time.Instant`, NOT kotlinx.datetime.Instant), kotlin minor, serialization
   (1.11.0) BEFORE dispatch; diff after any unit that touches libs.versions.toml.

## Per-unit loop (the increment mechanism)

1. Ledger: keep ONLY the pending unit in `WORKFLOW_STATE.json.work_units` (blocked
   units still dispatch — vf bug). Stash remaining unit specs to `/tmp/<proj>-units.json`.
   Unit spec = scope + spec + DoD + `LESSONS (from previous rounds — DO NOT repeat)`
   block listing concrete pitfalls from prior units (forbidden commands, settled
   files, API facts, missing imports).
2. `vf orchestrate --engine codex --yes --auto-wip` (background, notify).
3. QA — NEVER trust codex's JSON summary/confidence. `vf` marks `build:fail` even
   when code compiles; re-verify: grep banned imports in the unit's dir;
   `./gradlew :composeApp:testDebugUnitTest --rerun-tasks` (`--rerun-tasks`
   bypasses the UP-TO-DATE cache); count via python over
   `composeApp/build/test-results/testDebugUnitTest/*.xml`; read the code for spec
   fidelity (each state machine vs spec transitions table).
4. Codex compile errors → FIX BY SELF-EDIT (e.g. missing `import
   kotlin.time.Duration.Companion.minutes` for `60.minutes`), rerun, then record
   the exact missing fact in the next unit's LESSONS.
5. Correct YOUR premise before blaming codex — this session the agent wrongly
   assumed a dep was already wired; codex's diff was correct and necessary.
6. Mark unit done@1.0 in the ledger with REAL evidence strings (file paths + test
   counts), commit per unit with `-s`.
7. Append the next unit to the ledger (never filter-and-append by the mutated
   unit's name — silently drops it), dispatch next.

## vf bugs filed from this pattern

- magicpro97/vibeflow #782 — vf units status crashes on partial unit fields
  (same class: orchestrate recomputeTotals `reading 'tokens'` at cli.js:254).
- magicpro97/vibeflow #783 — orchestrate dispatches `blocked` units; can't gate
  sequential dispatch via status.

## Mutation-proof test pattern (spec 12.2, domain level)

Pure guard functions file (`DomainGuards.kt`: bookingOverlap, grantedBy,
roundNearest1000, isValidMessageBody, consentGranted, withinMatchBounds,
quickPlayWindow, memberOf) + `MutationProofTest` where each test documents the
specific guard whose removal makes it red. DoD: full suite green; every test doc
comment names the removed-guard proof.
