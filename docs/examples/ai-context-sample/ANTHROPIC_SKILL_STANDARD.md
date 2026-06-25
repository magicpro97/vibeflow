# Anthropic Skill Standard (VibeFlow enforced subset)

A skill is a folder named `<skill-name>` containing a required `SKILL.md`.

## Required
- `<skill-name>/SKILL.md`
- YAML frontmatter with `name` and `description`
- `name` is lowercase kebab-case (e.g. `rust-debugging`)
- `description` is concise and <= 1024 characters
- body contains actionable instructions, not TODO placeholders

## Optional standard folders
- `scripts/`
- `references/`
- `assets/`
- `LICENSE.txt`

## Validation rules (enforced by `vf skills validate`)
- missing `SKILL.md` → error
- missing/invalid frontmatter → error
- `name` not lowercase kebab-case → error
- folder name != frontmatter `name` → warning
- body < 50 chars → error
- body without markdown heading → warning
- unsupported top-level child dir → warning
- empty `scripts/`, `references/`, `assets/` → warning

## Canonical source of truth
`.vibeflow/skills/<name>/` is canonical. Engine dirs (`.claude/skills/`,
`.agents/skills/`, `.github/skills/`) are generated views.

Default sync writes a tiny `SKILL.md` pointer. Use `--mode full` to copy
the entire directory.
