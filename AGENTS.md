<!-- vibeflow:start -->
# AGENTS.md
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
