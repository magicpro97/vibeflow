---
title: Skill Providers
description: Provider-based skill discovery layer — Context7, Vercel find-skills, npm packages, trust model, and resolution flow.
category: explanation
last_updated: 2026-06-24
---

# Skill Providers

## Contents

- [Purpose](#purpose)
- [Provider Priority](#provider-priority)
- [Why Context7 Is the Primary External Provider](#why-context7-is-the-primary-external-provider)
- [Role of Vercel find-skills](#role-of-vercel-find-skills)
- [Provider Interface](#provider-interface)
- [Skill Resolution Flow](#skill-resolution-flow)
- [Skill Status](#skill-status)
- [Rule for Agents](#rule-for-agents)
- [Context7 Import](#context7-import)
- [npm Packages Are Not Skills by Default](#npm-packages-are-not-skills-by-default)

## Purpose

VibeFlow should not rely only on model memory. It must use a provider-based skill discovery layer so agents can find, install, validate, and reuse trusted skills.

## Provider priority

Recommended default order:

```text
1. Local verified skills
2. Context7 HTTP API (skills)
3. Official Anthropic skills and Claude Code plugins
4. Vercel find-skills
5. Official vendor documentation
6. Trusted MCP registries
7. Community skills after review
8. npm packages only after security verification
```

## Why Context7 is the primary external provider

The Context7 HTTP API should be the default external skill/docs resolver because it can support both:

```text
- skill discovery / installation / generation
- fresh documentation lookup for libraries, frameworks, SDKs, and APIs
```

This matters because many coding failures happen when the model relies on outdated API knowledge. Context7 is reached over HTTP via the runtime `fetch` (no external binary), so it has zero install prerequisites; an optional `CONTEXT7_API_KEY` raises rate limits.

## Role of Vercel find-skills

Vercel `find-skills` should remain supported as an additional provider.

Use it when:

```text
- the task needs a reusable agent skill
- the stack is Vercel, Next.js, AI SDK, frontend, deployment, or web-agent related
- Context7 has no suitable skill
- the user explicitly requests Vercel skills
```

## Provider interface

Every provider adapter should implement:

```ts
interface SkillProvider {
  name: string;
  search(query: SkillSearchQuery): Promise<SkillSearchResult[]>;
  suggest(context: ProjectContext): Promise<SkillSuggestion[]>;
  install(skillRef: string, targetDir: string): Promise<InstalledSkill>;
  verify(skillPath: string): Promise<SkillVerificationResult>;
}
```

## Skill resolution flow

```text
Task received
  ↓
Detect required capabilities
  ↓
Search local verified skills
  ↓
If missing or stale, query the Context7 API for skills
  ↓
If framework/API behavior is involved, query the Context7 API for docs
  ↓
If still missing, query Vercel find-skills / official sources
  ↓
Install as draft or experimental
  ↓
Run validation prompt
  ↓
Promote to verified only after checks pass
```

## Skill status

```text
draft         = generated or downloaded but not trusted
experimental  = usable with caution and limited permissions
unverified    = default for a skill that declares no status
verified      = tested and allowed by policy
deprecated    = preserved for history but should not be selected
```

A skill whose frontmatter omits `status` (or sets an unrecognized value) defaults to `unverified`.

## Rule for agents

Agents must not invent a manual process before checking available skills.

If a matching verified skill exists, it must be used.

If no verified skill exists, the agent must:

```text
1. search external providers
2. propose the best skill candidate
3. explain risks
4. install only as draft/experimental
5. validate before use
```

## Context7 import

Context7 is the only network-backed skill source. Imported skills land in the
canonical store (`.vibeflow/skills/`) and then sync to the three engine mirrors.

Pipeline (`src/skills/importer.ts`):

```text
1. fetch to a temp dir  (Context7 search → skill bundle)
2. validate             (Anthropic skill-creator standard via src/skills/validator.ts)
3. promote              (cpSync into .vibeflow/skills/<frontmatter.name>/)
4. backup               (existing skill moved to .vibeflow/skills/.backup/<ts>/<name>)
5. sync mirrors         (vf skills sync writes .claude/ | .agents/ | .github/ mirrors)
6. report               (errors / warnings / imported names)
```

Two entry points:

```bash
vf skills import <local-dir>            # import one skill dir
vf skills import <export-parent-dir>    # import every subdir of a parent (e.g. ctx7 export)
vf skills import context7:<query>       # fetch from Context7, then run the same pipeline
```

A skill that fails validation is never promoted; errors and warnings are
returned to the caller. Re-importing an existing name creates a timestamped
backup under `.vibeflow/skills/.backup/` before overwriting.

## Non-TTY auth observability

When `vf init` runs non-interactively (CI, cron, `--autopilot`), the ctx7 auth
check cannot prompt for device OAuth. In this case the init prints a yellow
warning and falls back to the HTTP-only discovery path (`runFindSkillsFallback`).

The auth decision is persisted to `.vibeflow/ai-context/ctx7-auth-status.json`
so it survives past the init run. Running `vf doctor` reads this file and prints
the current ctx7 auth state — e.g.:

```text
ctx7: unauthenticated — using HTTP fallback (rate-limited, no direct install)
```

This lets operators confirm whether a given init run used the full ctx7 CLI
install path or the degraded HTTP-only discovery.

## npm packages are not skills by default

npm should be treated as a package/tool dependency source, not a trusted skill registry.

Before installing npm dependencies, VibeFlow must check:

```text
- package name and namespace
- maintainer/repository
- pinned version
- install scripts
- license
- known security advisories if available
- whether the dependency is truly required
```

Default install strategy should prefer:

```bash
npm install --ignore-scripts
```

or sandboxed execution.

---

**Related:** [Skill Discovery and Evolution](./SKILL_DISCOVERY_AND_EVOLUTION.md) · [Skills System](./SKILLS_SYSTEM.md)
[Edit this page on GitHub](https://github.com/magicpro97/vibeflow/edit/main/docs/SKILL_PROVIDERS.md)
