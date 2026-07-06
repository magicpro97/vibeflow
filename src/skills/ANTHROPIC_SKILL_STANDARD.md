# Anthropic Skill Standard (VibeFlow enforced subset)

Canonical spec: <https://agentskills.io/specification>. VibeFlow enforces the
subset below via `vf skills validate` (see `src/skills/validator.ts`).

A skill is a folder named `<skill-name>` containing a required `SKILL.md`.

## Required
- `<skill-name>/SKILL.md`
- YAML frontmatter with `name` and `description`
- `name` is lowercase kebab-case (e.g. `rust-debugging`), 1–64 chars, no
  leading/trailing/consecutive hyphens
- `description` is concise, <= 1024 characters, and must NOT contain angle
  brackets (`<` / `>`) — they corrupt XML tool-call parsing
- body contains actionable instructions, not TODO placeholders

## Standard frontmatter fields (spec)
`name` and `description` are required. These are also standard and recognized:
- `license` — license name or reference to a bundled license file
- `allowed-tools` — space-separated pre-approved tools (experimental)
- `metadata` — arbitrary key-value mapping for extra metadata
- `compatibility` — environment requirements, <= 500 chars

Any OTHER frontmatter key is warned as non-standard (not an error), so legacy
VibeFlow keys (`status`, `version`, `triggers`, `requires`) keep validating.

## Optional standard folders
- `scripts/`
- `references/`
- `assets/`
- `LICENSE.txt`

The spec allows **any additional files or directories** at the top level
(Anthropic's own `skill-creator` ships `agents/` and `eval-viewer/`), so extra
entries are NOT flagged.

## Validation rules (enforced by `vf skills validate`)
- missing `SKILL.md` → error
- missing/invalid frontmatter → error
- `name` not lowercase kebab-case → error
- `name` > 64 chars → error
- `description` missing → error; > 1024 chars → error; contains `<`/`>` → error
- `compatibility` > 500 chars → error
- non-standard frontmatter key → warning
- folder name != frontmatter `name` → warning
- body < 50 chars → error
- body without markdown heading → warning
- empty `scripts/`, `references/`, `assets/` → warning

## Canonical source of truth
`.vibeflow/skills/<name>/` is canonical. Engine dirs (`.claude/skills/`,
`.agents/skills/`, `.github/skills/`) are generated views.

Default sync writes a tiny `SKILL.md` pointer. Use `--mode full` to copy
the entire directory.
