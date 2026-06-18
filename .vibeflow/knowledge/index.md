# Knowledge Index

Catalog of knowledge pages — one entry per line.
- 2026-06-12: active CLI intake for `vf init --ai --ask` recorded in `log.md`.
- 2026-06-12: `vf init --ai` active intake refactor to `src/init-intake.ts` recorded in `log.md`.
- 2026-06-12: `vf init --ask` questionnaire data model recorded in `log.md`.
- 2026-06-12: CLI-only `vf init --ask` to `applyIntake()` wiring recorded in `log.md`.
- 2026-06-12: `test/ai-init.test.ts` Copilot argv prompt expectation update recorded in `log.md`.
- 2026-06-16: agent-team `vf init --ai` loading and inline log streaming recorded in `log.md`.
- 2026-06-16: `vf init` default engine `copilot` and `--no-ask` opt-out recorded in `log.md`.
- 2026-06-16: agent-team instruction-writer scope follows selected engine (engine per scope, not all 4 files) recorded in `log.md`.
- 2026-06-17: 4-CLI audit of PR#28 → 6 critical findings (C1–C6) fixed, 6 PRs merged, release-please → v0.7.0 — `audit-2026-06-17-4cli-synthesis.json`, `audit-2026-06-17-ground-truth.md`, `audit-2026-06-17-scoreboard.md`, `plan-2026-06-17-4cli-audit.md` recorded in `log.md`.
- 2026-06-17: repo hygiene pass — added `.hermes/`, `claude/`, `coverage/`, `*.lcov*` to `.gitignore`; deleted 7 stale pr28-*.md review files + 1 Hermes session export — recorded in `log.md`.
- 2026-06-18: Phase 2 engine-scoping fix — 5 leak points patched (ADAPTER_DESCRIPTION/ACCEPTANCE/SCOPE, buildInstructionsBody, skill-curator reviewer), 10 invariant tests added — recorded in `log.md`.
