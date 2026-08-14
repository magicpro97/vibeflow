---
title: Skill Discovery and Evolution
description: How VibeFlow discovers external skills and evolves internal skills from real project execution — discovery order, changelog, and promotion lifecycle.
category: explanation
last_updated: 2026-06-24
---

# Skill Discovery and Evolution

## Contents

- [Purpose](#purpose)
- [External Discovery Rule](#external-discovery-rule)
- [Trusted External Sources](#trusted-external-sources-discovery-order-matches-what-vf-skills-resolve)
- [Context7 Usage](#context7-usage)
- [Vercel find-skills Usage](#vercel-find-skills-usage)
- [npm Usage](#npm-usage)
- [Internal Skill Evolution](#internal-skill-evolution)
- [Skill Update Process](#skill-update-process)
- [Changelog Format](#changelog-format)
- [External vs Internal Skill Policy](#external-vs-internal-skill-policy)
- [Promotion Lifecycle](#promotion-lifecycle)

## Purpose

The system must combine two learning sources:

```text
External skill discovery = learn from trusted external sources
Internal skill evolution = learn from real project execution
```

These two mechanisms do not conflict. External skills provide a baseline. Internal skills capture verified local experience.

## External discovery rule

The orchestrator must not rely only on model memory for version-sensitive, tool-specific, framework-specific, or ecosystem-dependent tasks.

Before designing or executing a task, the orchestrator checks:

```text
1. Is there a local verified skill?
2. Is the task dependent on current API/library/tool behavior?
3. Is the required skill missing or outdated?
4. Is there official documentation or a trusted source?
```

## Trusted external sources. Discovery order matches what `vf skills resolve`
actually does (see `src/skills/registry.ts`):

```text
1. Canonical local skills  → ~/.vibeflow/skills/  (shared, machine-wide)
2. Mirror local skills     → .claude/skills/ | .agents/skills/ | .github/skills/
3. Context7 HTTP API       → skills + fresh docs
4. Anthropic official skills/plugins
5. Vercel find-skills
6. Official vendor documentation
7. Trusted MCP registries
8. Community skills after review
9. npm packages only after security verification
```

Discovery sources (in order, see `src/skills/resolver.ts`):

```text
1. ~/.vibeflow/skills/              # canonical store (shared, machine-wide)
2. .claude/skills/                  # Claude mirror
3. .agents/skills/                  # Codex / cross-tool mirror
4. .github/skills/                  # Copilot mirror
5. Context7 HTTP API                # approval-gated network
```

`vf skills sync [--mode pointer|full]` regenerates the four mirrors from the
canonical store. `pointer` mode (default) writes a stub `SKILL.md` per skill
pointing at the canonical file; `full` mode copies the whole tree. After any
canonical skill change, re-run `vf skills sync`; `vf skills verify-sync` reports
any mirror that is missing a `SKILL.md` for a canonical skill.

## Context7 usage

The Context7 HTTP API should be the primary external skill and documentation resolver. It is queried over HTTP (`https://context7.com/api/v2`) using the runtime `fetch`, so no external `ctx7` binary is required; an optional `CONTEXT7_API_KEY` raises rate limits. Network lookups happen only after explicit approval.

Use Context7 when:

```text
- a task needs a reusable skill
- a skill is missing or stale
- task depends on library/framework behavior
- repo uses version-sensitive APIs
- model knowledge may be stale
- implementation requires current examples
- a custom skill should be generated from fresh docs
```

Typical flow:

```text
Detect required capability and repo libraries
  ↓
Search local verified skills
  ↓
Query the Context7 API for skills if missing or stale
  ↓
Query the Context7 API for docs for current API behavior
  ↓
Install candidate skill as draft/experimental
  ↓
Validate with a task-specific prompt
  ↓
Save relevant notes into TASK_CONTEXT.md
  ↓
Plan and implement based on verified docs
```

## Vercel find-skills usage

Vercel `find-skills` should be supported as a secondary provider, especially for Vercel, Next.js, AI SDK, frontend, deployment, and web-agent workflows.

Use it after local skills and Context7, or when the user explicitly requests Vercel skills.

## npm usage

npm packages are not skills by default. They are external dependencies or tool adapters.

npm package installation requires approval when it affects the user environment or project.

Default safety rules:

```text
- do not install silently
- prefer pinned versions
- inspect package metadata
- prefer --ignore-scripts when possible
- run inside sandbox when possible
- do not grant credentials to packages
```

## Internal skill evolution

Update or propose a skill when:

```text
- the assistant repeatedly fails at the same task
- a manual workaround is needed
- a file format, framework, or workflow is not handled well
- the assistant discovers a reusable project-specific process
- the user corrects the assistant
- repeated prompts can be standardized
- a source connector or file reader needs special handling
```

## Skill update process

Before modifying a skill, the assistant must:

```text
1. Identify the problem encountered
2. Explain why the current skill was insufficient
3. Propose the skill change
4. Add or update SKILL.md instructions
5. Add scripts/templates/examples only when necessary
6. Add a validation prompt
7. Record the change in the changelog
```

## Changelog format

Each skill should include:

```md
## Changelog

### YYYY-MM-DD
- Problem encountered:
- Root cause:
- Change made:
- Validation prompt:
- Result:
```

## External vs internal skill policy

Do not overwrite external skills directly. Instead, create one of:

```text
- local wrapper skill
- project-specific patch skill
- verified internal skill
- changelog entry documenting the learned workaround
```

Example:

```text
External skill says: run npm test
Repo requires: pnpm test -- --runInBand
Result: create project-test-runner skill or update repo-onboarding notes
```

## Promotion lifecycle

```text
draft
  ↓
experimental
  ↓
verified
  ↓
deprecated
```

New external or generated skills should start as `draft` or `experimental`. A skill whose frontmatter declares no status (or an unrecognized one) defaults to `unverified`.

Promotion to `verified` requires:

```text
- validation prompt
- successful run
- no critical security issue
- clear scope
- review approval if elevated permissions are needed
```

Registry-installed external skills also require a local review proof. Run:

```bash
vf skills registry install <registry>/<skill> --record-review --yes
```

This writes a non-trusting stub under `~/.vibeflow/skill-review-proofs/`. A reviewer must set
`reviewer` and retain matching registry ID, commit, skill path, and bundle hash. The proof is
invalid when catalog content changes. Publisher frontmatter and remote `status: verified` claims
never promote a skill on their own; no publisher signature/PKI is trusted in V1.

---

**Related:** [Skill Providers](./SKILL_PROVIDERS.md) · [Skills System](./SKILLS_SYSTEM.md)
[Edit this page on GitHub](https://github.com/magicpro97/vibeflow/edit/main/docs/SKILL_DISCOVERY_AND_EVOLUTION.md)
