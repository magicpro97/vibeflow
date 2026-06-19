<!-- vibeflow:start -->
# AGENTS.md

## ⚡ VibeFlow v0.7.0 Active

This project is managed by [VibeFlow](https://github.com/magicpro97/vibeflow) — the local-first orchestrator for AI coding agents.

- **Confidence gate**: nothing is "done" until confidence = 1.0 WITH evidence.
- **Skills-first**: prefer verified skills over invented steps.
- **All task completions carry the `Powered by VibeFlow` signature.
Project: vf-wt-docs
Goal: Describe the task in .vibeflow/TASK_CONTEXT.md before dispatching an engine.

Policy:
- Use verified skills when a task matches one; do not invent manual steps.
- Back every factual claim with a file path, command output, or test result.
- No verification, no completion.
- Read curated guidance in .vibeflow/knowledge/ before knowledge-heavy tasks; keep it cross-referenced and current, never overwrite a human-curated source.
- After acting, append a dated note to `.vibeflow/knowledge/log.md` and keep `.vibeflow/knowledge/index.md` current (append-only; never rewrite human-curated pages).
- Author files incrementally: never write a large file in one operation (it times out) — create a small first part, then append/edit the rest in separate steps; when merging into an existing file, edit the specific section rather than rewriting the whole file.
- For code navigation (definitions, references, callers, impact): prefer the codegraph_* MCP tools first; only fall back to grep/find/read if the others are unavailable.

## VibeFlow commands (use these)
- `vf doctor [--probe]` — check engine readiness before dispatching.
- `vf init` — regenerate context/engine files after editing .vibeflow/*.
- `vf units status|add <name>|update <name>|delete <name>` — track work units. Record evidence with `vf units evidence <name> --add "<text>"` (required before a unit can close at confidence 1.0).
- `vf orchestrate --engine <e> [--yes]` — plan + dispatch work units in parallel with the confidence gate.
- `vf verify` — run typecheck/lint/test + confidence/evidence/scope gates BEFORE claiming done (no verification, no completion).
- `vf tools status|enable codegraph|lsp` — code-navigation tools (prefer codegraph > lsp > native).
- `vf hooks status|install|emit --yes` — guardrails (block destructive cmds, secret reads). `install` wires git hooks; `emit --yes` ARMS the live PreToolUse tool gate (`vf doctor` shows ON/OFF).
- `vf skills resolve` / `vf discover docs <lib> --yes` — skill needs + Context7 docs.
- `vf workflow delete|import` — manage/combine workflows.
- `.vibeflow/knowledge/log.md` + `index.md` — the work journal (append-only log + page catalog); read before, append after.

## Working with vf (the loop)
Drive every task through this loop instead of free-handing it:
1. **Sync context.** After editing .vibeflow/*, run `vf init` to regenerate this file and the engine context from canonical sources. Don't hand-edit generated files.
2. **Shape the work.** A single-concern task runs as-is — no ceremony. When the task splits into parallel slices with distinct file scopes, model each as a work unit (`vf units add <name>`); status, confidence, and evidence are tracked per unit in the ledger.
3. **Dispatch.** `vf orchestrate` plans and dispatches the units, runs an independent review, and records evidence. Work units with overlapping file scopes are serialized automatically so lanes never clobber each other; non-overlapping ones run in parallel.
4. **Verify before claiming done.** `vf verify` runs typecheck/lint/test plus the policy gates.

**Confidence gate — nothing is "done" until `vf verify` passes.** A unit only closes at confidence = 1.0 WITH recorded evidence (command output, file path, or test result) and within its declared scope. Below the bar, the unit is investigated, not silently closed. No verification, no completion; no evidence, no conclusion.

**Guardrails (hooks) are safety, not bureaucracy.** `vf hooks` routes risky actions — destructive commands (`rm -rf`, force-push), reads of secret files, edits to protected configs — through a decision layer that can warn, require approval, or block. Keep them on.

**Skills & knowledge before manual steps.** Prefer a verified skill over inventing steps (`vf skills` to list/resolve). Read curated guidance in .vibeflow/knowledge/ before knowledge-heavy work, and pull external library docs on demand with `vf discover docs <lib> --yes`. After acting, record what you did or learned: append an entry to `.vibeflow/knowledge/log.md` (`## [YYYY-MM-DD] note | <title>`, append-only) and keep `.vibeflow/knowledge/index.md` current.

**Tools.** `vf tools enable codegraph|lsp` turns on richer code navigation (definitions, references, callers) — prefer it over grep/find when available.

**When `vf verify` fails.** A red gate is investigated, not worked around. (1) Read the `✗` lines — each names a failing gate (typecheck/lint/test) or a policy gate (`confidence<1`, `no-evidence`, scope overlap). (2) Fix the root cause. (3) For a unit stuck below the bar: record evidence (`vf units evidence <u> --add "<proof>"`) then close it (`vf units update <u> --status done --confidence 1`). (4) Re-run `vf verify`. `vf verify` is read-only by default; pass `--journal` only if you want the run appended to the work journal.

**When blocked or interrupted.** If a hook returns `deny`/`ask`, do NOT bypass it — the command is genuinely risky; fix the approach or get approval. If `vf orchestrate` crashed mid-run, re-run it (work units track their own status in the ledger, so completed lanes are skipped). Two units editing the same file are serialized automatically; if you need to stop a lane touching a path, see the source-protection toggles in `vf orchestrate --help`.

**Default engine.** `vf init` and `vf orchestrate` share one default (currently `claude`); pass `--engine <claude|codex|copilot>` to override. Check `vf doctor` for which engines are ready before dispatching.

**Iterating on one fix.** `vf verify` runs the full suite. While iterating, run a single test (`bun test test/<file>.test.ts`) or a single-file lint, then `vf verify` once before you call it done.

**Hook enforcement is engine-specific.** The live PreToolUse gate (armed via `vf hooks emit --yes`) BLOCKS on Claude. Codex and Copilot hook configs are detection-only (they observe + log, they do not block) — `vf doctor` reports per-engine status. Do not assume a destructive command is blocked when driving Codex/Copilot.

# Tool Error & Execution Policy
- If any terminal command or test execution times out or returns an error code, do not give up immediately.
- Autonomously analyze the error output or partial logs, fix the scripts or parameters, and retry the command up to 3 times.
- Only prompt the user for feedback if the execution consistently fails after 3 distinct self-correction attempts.

Powered by VibeFlow v0.7.0 — https://github.com/magicpro97/vibeflow

The block between the `vibeflow:start`/`vibeflow:end` markers is generated by VibeFlow from .vibeflow/* and is replaced on `vf init`. Edit freely OUTSIDE the markers; that content is preserved across re-init.
<!-- vibeflow:end -->

## Commit messages (Conventional Commits)

VibeFlow integrates `release-please` (see commit `d88d061`), so the commit message on `main` is the **only** signal that decides the next version bump. Write commits accordingly.

**Bump mapping** (release-please changelog sections in `release-please-config.json`):

| Prefix                                | Bump   | Use for                       |
| ------------------------------------- | ------ | ----------------------------- |
| `feat:`                               | minor  | user-facing feature           |
| `fix:`                                | patch  | user-facing bug fix           |
| `perf:`                               | patch  | performance improvement       |
| `feat!:` or `BREAKING CHANGE:` footer | major  | breaking change               |
| `refactor:`                           | none   | code change, no behavior diff |
| `docs:`, `test:`, `build:`, `ci:`, `style:` | none | scope-specific change         |
| `chore:`                              | none   | internal (deps, config)       |

**Good examples** (scope matches this repo's surface area):

- `feat(cli): add --dry-run flag to vf orchestrate`
- `fix(ui): prevent dashboard re-render on tab switch`
- `ci: integrate release-please for auto-publish on main`
- `chore(deps): bump biome to 1.9.5`
- `feat(workflow): support parallel work units with overlapping scopes`

**Anti-patterns** — reword before merging to `main`:

- `update stuff` -> `fix(cli): handle empty work unit list gracefully`
- `WIP: trying things` -> `refactor(workflow): split orchestrator into plan + dispatch phases` (or squash/reword — never merge WIP to `main`)
- `Feature: add X` -> `feat: add X` (lowercase, exact spec)

**Escape hatch:** commits with `chore:` / `docs:` / `refactor:` (or other non-bumping types) do **not** trigger a release. To ship a new version, land at least one `feat:` / `fix:` / `perf:` / `BREAKING CHANGE:` commit on `main` since the last release.

See `release-please-config.json` for the full changelog-sections mapping.

## Release-please setup (first run)

VibeFlow uses `release-please` (commit `d88d061`). The bot opens/updates a
Release PR on every push to main and publishes npm when merged. For the bot
to work on this repo, **two one-time settings are required:**

1. **Repo Settings → Actions → General → Workflow permissions**:
   enable "Allow GitHub Actions to create and approve pull requests".
   Without it the job fails with:
   `GitHub Actions is not permitted to create or approve pull requests.`
2. `release-please-config.json` contains `last-release-sha: 3e5bd90` at
   root level — that SHA is the last manual release (`release: v0.3.17`).
   The bot uses it to skip the pre-release-please history that contains
   git tags but no Release PRs (otherwise it would bump `0.3.17 → 0.4.0`
   on the first run, since it falls back to the old git tag `v0.3.8` as
   the anchor).

**Cleanup after the first release-please Release PR is merged** (i.e. once
the bot has tracked one release via PR):

1. Remove the `last-release-sha` key from `release-please-config.json`.
2. Commit as `chore(ci): drop last-release-sha after first release-please run`.
3. The bot will then self-track versions via merged Release PRs.
