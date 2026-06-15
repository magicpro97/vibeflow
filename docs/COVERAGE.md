# VibeFlow CLI flag reference

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

**Tests:** 7 new tests in `test/ai-init.test.ts` (autopilot flag
block) and 2 new tests in `test/commands-coverage.test.ts` (CLI
integration). All pass; 100% lcov line coverage maintained.
