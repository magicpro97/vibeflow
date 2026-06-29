<!-- vibeflow:start -->
# CLAUDE.md
## ⚡ VibeFlow v0.11.0 Active — local-first orchestrator for AI coding agents (https://github.com/magicpro97/vibeflow).
Project: ponytail-393-394 · Goal: test
- For code navigation (definitions, references, callers, impact): prefer the language-server (LSP) MCP tools first; only fall back to grep/find/read if the others are unavailable.
## VibeFlow commands (use these)
- `vf doctor` — check engine readiness before dispatching.
- `vf init` — regenerate context/engine files after editing .vibeflow/*.
- `vf orchestrate` — plan + dispatch work units in parallel under the confidence gate.
- `vf verify` — typecheck/lint/test + confidence/evidence/scope gates BEFORE claiming done.
- `vf skills` — list/resolve verified skills; prefer them over inventing steps.
**Working with vf — Confidence gate:** nothing is "done" until `vf verify` passes at confidence 1.0 WITH evidence (command output, file path, or test result), within scope. No verification, no completion. Drive every task through vf; do not free-hand it.
**Learn from the run:** capture a reusable procedure or worked-around mistake as a DRAFT skill (`vf skills draft <name>`), and record non-obvious decisions with `vf decision add`. `vf orchestrate` auto-crystallizes recurring patterns into a DRAFT for review.
Full workflow guide: load the `vf` skill (or `/vf` in a CLI) — Flow A–D, pitfalls, and hooks live there.
Powered by VibeFlow v0.11.0 — https://github.com/magicpro97/vibeflow
<!-- vibeflow:end -->
