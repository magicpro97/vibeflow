# Generated Files

## Purpose

This document describes files the orchestrator should generate in a target repository.

## Minimal-footprint rule

The file lists below are the **maximum** surface VibeFlow may generate, not a mandatory
set. Per the minimal-footprint and AI-generated-output principle in `MASTER_SPEC.md`, the
orchestrator must:

```text
- generate only the files the selected engine and current task actually require
- skip optional/empty artifacts instead of creating placeholder files
- compose every file from canonical context with the AI at runtime (no static templates)
- keep generated files disposable and reproducible from the canonical .vibeflow/* source
```

## Root files

### `CLAUDE.md`

Primary instruction file for Claude Code.

Should contain:

```text
- project overview
- architecture
- build/test/lint commands
- coding conventions
- workflow policy
- skill usage policy
- security rules
- verification rules
- skill evolution policy
```

### `AGENTS.md`

Cross-tool instruction file for Codex, Copilot, and other coding agents.

Should contain:

```text
- shared project context
- agent orchestration policy
- skill usage policy
- anti-hallucination policy
- verification requirements
- task execution rules
```

## GitHub Copilot files

```text
.github/copilot-instructions.md
.github/instructions/backend.instructions.md
.github/instructions/frontend.instructions.md
.github/instructions/testing.instructions.md
.github/instructions/security.instructions.md
```

Purpose:

```text
- repo-wide Copilot instructions
- path-specific coding rules
- testing/security guidance
```

## Claude files

```text
.claude/agents/
.claude/skills/
.claude/settings.json
```

Example agents:

```text
orchestrator.md
backend-engineer.md
frontend-engineer.md
test-engineer.md
security-reviewer.md
devops-engineer.md
skill-compliance-reviewer.md
```

Example skills:

```text
repo-onboarding/SKILL.md
skill-maintainer/SKILL.md
markdown-reader/SKILL.md
docx-reader/SKILL.md
xlsx-reader/SKILL.md
pptx-reader/SKILL.md
pdf-reader/SKILL.md
context7-docs/SKILL.md
```

## Codex files

```text
.codex/config.toml
.vibeflow/dispatch/codex.md
```

Purpose:

```text
- standard Codex execution profile
- prompt template generated from canonical context
```

## .vibeflow files

```text
.vibeflow/PROJECT_CONTEXT.md
.vibeflow/REQUIREMENTS.md
.vibeflow/TASK_CONTEXT.md
.vibeflow/WORKFLOW_POLICY.md
.vibeflow/SKILL_INDEX.md
.vibeflow/SETTINGS.json
.vibeflow/WORKFLOW_STATE.json
.vibeflow/workunits/<name>/CONTEXT.md
.vibeflow/workunits/<name>/evidence/
.vibeflow/attachments/                              # uploaded sample files (web UI)
.vibeflow/ai-context/ANTHROPIC_SKILL_STANDARD.md   # copied from src/skills/ on init
.vibeflow/ai-context/SKILL_TAXONOMY.md             # copied from src/skills/ on init
.vibeflow/skills/<name>/                           # canonical skill store (mirrored to engines)
  SKILL.md                                         # required
  references/                                      # optional
  scripts/                                         # optional
  assets/                                          # optional
```

Purpose:

```text
- canonical workflow memory
- normalized context
- skill registry summary
- per-repo settings: optional tool toggles (codegraph/lsp) and tool priority
- current task state
- per-task work units, gates, and resource ledger (see WORK_UNIT_ORCHESTRATION.md)
```

`SETTINGS.json` is written on every `vf init` from `DEFAULT_SETTINGS`. Each work unit dir
holds `CONTEXT.md` (the dispatch prompt) and an `evidence/` folder of JSON results
(`<engine>.result.json`, `investigation.json`); per-unit state lives centrally in
`WORKFLOW_STATE.json`, not in a per-unit `meta.json`. `TODO.md` and `HANDOFF.md` are planned
but not yet generated (see `WORK_UNIT_ORCHESTRATION.md`).

Work-unit files follow the minimal-footprint rule: create them only when a task is
decomposed (3+ files across multiple modules, or delegated agents). See
`WORK_UNIT_ORCHESTRATION.md` for when units are created and how they are tracked.

## Dispatch files

```text
.vibeflow/dispatch/claude.md
.vibeflow/dispatch/codex.md
.vibeflow/dispatch/copilot.md
```

Each dispatch file should include:

```text
- task goal
- selected context
- selected skills
- allowed files
- constraints
- verification commands
- expected output schema
```

## Hook files

`vf hooks emit` writes per-engine native hook configs into the target repo. There are no
per-event `.vibeflow/hooks/*.ts` scripts; instead every config delegates to the single
`vf hook` entrypoint (reads a JSON event on stdin, returns a decision):

```text
.claude/settings.json        (Claude PreToolUse/PostToolUse/Stop → `vf hook`)
.codex/hooks.json            (Codex post-command/post-write/verify-result → `vf hook`)
.github/hooks/copilot.json   (Copilot preToolUse (fail-closed) + postToolUse → `vf hook`)
.githooks/pre-commit         (fail-closed shell hook routing staged files → `vf hook`)
```

Purpose:

```text
- enforce permissions (Claude: native pre-action block; Codex/Copilot: detection-only)
- reduce unsafe actions
- verify skill usage
- validate output
- reduce false positives through risk scoring
```

## Source modules that materialise the generated files

The runtime source-of-truth modules for the generated surface (under `src/`):

```text
src/ai-init.ts                    # writes PROJECT_CONTEXT, REQUIREMENTS, SKILL_INDEX, dispatch prompts
src/skills/sync.ts                # canonical → mirror sync (.vibeflow/skills → .claude/.agents/.github)
src/skills/validator.ts           # Anthropic skill-creator standard validation
src/skills/importer.ts            # Context7 + local-dir skill import (temp → validate → promote → sync)
src/skills/ANTHROPIC_SKILL_STANDARD.md   # reference, copied to .vibeflow/ai-context/ on init
src/skills/SKILL_TAXONOMY.md             # reference, copied to .vibeflow/ai-context/ on init
src/probe-cache.ts                # 60s stable / 5s short-TTL engine readiness cache
src/engine-quota.ts               # parse claude/codex/copilot quota output for the preflight gate
src/preflight-delegate.ts         # 3-layer gate: presence → auth → quota, with auto-fallback
```
