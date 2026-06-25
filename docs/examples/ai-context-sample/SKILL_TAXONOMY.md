# VibeFlow Skill Taxonomy

## Project-fit skills
Create these only when they encode repo-specific domain knowledge, business workflow, architecture rules, or recurring project tasks.

Canonical source: `.vibeflow/skills/<name>/SKILL.md`

Examples:
- `zoom-audio-pipeline`
- `provider-fallback-policy`
- `phase-gate-roadmap`

These may become `verified` after validation and review.

## Tool/tweak skills
Do not invent these. Source from Context7/docs when possible.

Examples:
- Playwright testing
- Bun/Node runtime compatibility
- GitHub Actions release workflow
- Rust/Tokio debugging
- Windows audio APIs

Keep these `experimental` unless reviewed locally.

## Sync modes
- Default: `vf skills sync` writes pointer files into engine dirs
  (`.claude/skills/`, `.agents/skills/`, `.github/skills/`).
- `vf skills sync --mode full` copies the full directory.

Always read the canonical skill at `.vibeflow/skills/<name>/SKILL.md` before relying on engine-dir content.
