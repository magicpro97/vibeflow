---
title: Skills System
description: The Anthropic-style skill system — standard format, metadata, categories, registry priority, and usage rules.
category: explanation
last_updated: 2026-06-24
---

# Skills System

## Contents

- [Skill Standard](#skill-standard)
- [Skill Metadata](#skill-metadata)
- [Skill Categories](#skill-categories)
- [Skill Usage Rule](#skill-usage-rule)
- [Skill Registry Priority](#skill-registry-priority)
- [Learning Loop](#learning-loop--turning-runs-into-skills)
- [No Silent Improvisation](#no-silent-improvisation)

## Skill standard

The system uses Anthropic-style skills. A skill is a directory containing `SKILL.md` and optional scripts, templates, references, and examples.

```text
.vibeflow/skills/        # canonical skill store (source of truth)
  <name>/
    SKILL.md             # required: frontmatter + instructions
    references/          # optional: linked reference docs
    scripts/             # optional: executable helpers
    assets/              # optional: templates, schemas, fixtures
```

Mirrors (regenerated from the canonical store by `vf skills sync`, see
`src/skills/sync.ts`):

```text
.claude/skills/          # Claude mirror (reads SKILL.md directly)
.agents/skills/          # Codex / cross-tool mirror
.github/skills/          # Copilot mirror
```

`SKILL.md` must contain YAML frontmatter and follow the Anthropic `skill-creator`
standard (see `src/skills/ANTHROPIC_SKILL_STANDARD.md`):

```md
---
name: skill-name
description: Clear description of when this skill should be used
---

# Skill Name

Instructions...
```

## Skill metadata

Skill metadata lives in the `SKILL.md` YAML frontmatter. The orchestrator parses that frontmatter for deterministic capability matching — there is no separate metadata file.

Example:

```md
---
name: xlsx-reader
version: 1.0.0
capabilities: ["read:xlsx", "extract:tables"]
triggers: ["xlsx", "spreadsheet", "excel"]
requires:
  filesystem: read
  network: false
  shell: false
status: verified
---

# XLSX Reader

Instructions...
```

## Skill categories

### Source skills

Used to access project sources:

```text
github-source-skill
gitlab-source-skill
google-drive-source-skill
confluence-source-skill
notion-source-skill
jira-source-skill
linear-source-skill
slack-source-skill
local-folder-source-skill
s3-source-skill
```

### File processing skills

Used to read and normalize files:

```text
markdown-reader-skill
docx-reader-skill
xlsx-reader-skill
pptx-reader-skill
pdf-reader-skill
image-ocr-skill
openapi-reader-skill
postman-reader-skill
drawio-reader-skill
mermaid-reader-skill
```

### Workflow skills

Used to run AI SDLC processes:

```text
repo-onboarding
instruction-generator
sdlc-agent-generator
copilot-task-dispatcher
claude-task-dispatcher
codex-task-dispatcher
diff-reviewer
skill-maintainer
```

## Skill usage rule

Agents must use verified skills whenever a task matches an available skill capability.

If a matching verified skill exists but the agent does not use it, the task is not compliant.

Every agent output must include:

```json
{
  "agent": "document-reader",
  "skills_considered": ["xlsx-reader"],
  "skill_used": "xlsx-reader",
  "skill_version": "1.0.0",
  "confidence": 0.91
}
```

## Skill registry priority

Canonical order (kept in sync with `MASTER_SPEC.md`, `SKILL_PROVIDERS.md`, and
`SKILL_DISCOVERY_AND_EVOLUTION.md`):

```text
1. Local verified skills
2. Context7 HTTP API (skills and docs)
3. Official Anthropic skills/plugins
4. Vercel find-skills
5. Official vendor documentation
6. Trusted MCP registries
7. Community skills after review
8. npm packages only after security verification
```

## Learning loop — turning runs into skills

VibeFlow self-improves by capturing what each run learns. Four mechanisms feed
the loop, covering **mistake / learn / knowledge / decision**:

| Dimension | Mechanism | Trigger |
|-----------|-----------|---------|
| mistake / learn | **auto-crystallize** | Automatic at the end of `vf orchestrate` (and `vf verify --journal`). Reads the run log + `knowledge/log.md`, counts recurring commands / skills / failures, and writes a DRAFT skill when a pattern crosses threshold. |
| learn (agent-driven) | **`vf skills draft <name>`** | An agent (or you) captures a reusable procedure or worked-around mistake on the spot. Scaffolds a `status: draft` SKILL.md with a Why/Evidence skeleton. |
| knowledge | **`knowledge/log.md`** | Append-only work journal (`## [YYYY-MM-DD] note | <title>`). Read before, append after. |
| decision | **`vf decision add`** | Records a durable architecture/process decision in `knowledge/decisions.md` (ADR-lite), separate from the noisy journal. |

### Safety model — DRAFT, never auto-installed

Every captured skill lands as `status: draft` and is **never installed into the
engine mirrors automatically**. A draft is an untracked file you review and
`git add` if useful. This is deliberate: a wrong skill that auto-installed would
poison every subsequent run. Promotion (draft → verified) is a human decision.

`vf verify` stays **read-only by default** — the auto-crystallize tail only runs
on the opt-in `--journal` flag, so the gate an agent runs before "claiming done"
never mutates the tree it audits.

### Dispatched agents know the loop

The `VF_WORKFLOW` block injected into every engine's context tells dispatched
agents to draft skills and record decisions as they work — so the loop runs
whether or not the deterministic auto-crystallize backstop fires.

## No silent improvisation

Agents must not invent a manual process before checking available skills.

If no skill exists, the agent must report:

```text
Missing capability:
Recommended skill:
Risk:
Safe fallback:
Validation plan:
```

---

**Related:** [Skill Providers](./SKILL_PROVIDERS.md) · [Skill Discovery and Evolution](./SKILL_DISCOVERY_AND_EVOLUTION.md)
[Edit this page on GitHub](https://github.com/magicpro97/vibeflow/edit/main/docs/SKILLS_SYSTEM.md)
