---
title: Master Spec
description: Master specification — one-sentence summary, design principles, engine support, skill system, hook system, and security posture.
category: reference
last_updated: 2026-06-24
---

# VibeFlow Master Spec

## Contents

- [One-Sentence Summary](#one-sentence-summary)
- [What the Tool Does](#what-the-tool-does)
- [Key Design Principles](#key-design-principles)
- [Minimal-Footprint and AI-Generated Output](#minimal-footprint-and-ai-generated-output)
- [Engine Support](#engine-support)
- [Skill System](#skill-system)
- [Hook System](#hook-system)
- [Security Posture](#security-posture)
- [Engine Readiness](#engine-readiness)
- [Pre-Flight Quota Gate](#pre-flight-quota-gate)
- [Naming Decision](#naming-decision)
- [Updated Skill Provider Decision](#updated-skill-provider-decision)

## One-sentence summary

A local-first npm CLI tool that opens a web UI and orchestrates Claude Code, Codex CLI, and GitHub Copilot CLI using shared project context, Anthropic-style skills, source/file readers, hooks, multi-agent planning, verification, and continuous skill evolution.

## What the tool does

```text
- Starts from npm/npx
- Opens a local web UI
- Collects repo, task, docs, and work management sources
- Finds source connector skills
- Finds file reader skills
- Reads and normalizes project context
- Generates CLAUDE.md, AGENTS.md, and Copilot instructions
- Creates Claude agents and Anthropic-style skills
- Dispatches Claude Code, Codex, or Copilot CLI
- Uses hooks to control risky actions
- Verifies diff, tests, logs, and acceptance criteria
- Proposes skill updates from lessons learned
```

## Key design principles

```text
Main agent is always the orchestrator.
Do not rely on stale model memory for version-sensitive tasks.
Use verified skills when available.
Search trusted external docs/skills when needed.
Do not silently install or enable risky dependencies.
Confidence below threshold triggers bounded investigation, not infinite loops.
If confidence remains low, recommend the next best action with evidence.
Ask for approval only for side effects or high-risk actions.
No evidence, no conclusion.
No verification, no completion.
Generate the fewest files possible.
Everything a tool emits is AI-generated, not hand-maintained boilerplate.
```

## Minimal-footprint and AI-generated output

VibeFlow must keep the number of files it creates in a target repo as small as
possible, and every file it does create must be produced by the AI at runtime from
canonical context — not copied from static, hand-maintained template files.

```text
- Generate the minimum set of files needed for the selected engine and task.
- Do not scaffold files the current run does not use (lazy, on-demand generation).
- Prefer one canonical source plus on-demand projections over many persisted copies.
- No static template files checked into the tool as the source of generated output;
  the orchestrator composes each file from canonical context with the AI.
- Generated files are disposable and reproducible: deleting them and re-running
  must reproduce equivalent output from the same canonical context.
- Collapse optional/empty artifacts: only emit per-area files (e.g.
  .github/instructions/*.instructions.md, .claude/agents/*) that the task actually needs.
```

This principle takes precedence over the illustrative "full" file lists elsewhere in
these specs (for example in `GENERATED_FILES.md` and `ARCHITECTURE.md`): those lists
describe the maximum surface VibeFlow *may* generate, not a set it must always create.

## Engine support

```text
Claude Code:
- CLAUDE.md
- .claude/agents
- .claude/skills
- .claude/settings.json

Codex CLI:
- AGENTS.md
- .codex/config.toml
- prompt-injected selected skills

GitHub Copilot CLI:
- AGENTS.md
- .github/copilot-instructions.md
- .github/instructions/*.instructions.md
- prompt-injected selected skills
```

## Skill system

```text
External skills = baseline knowledge from trusted sources
Internal skills = verified project/team lessons
```

Every skill:

```text
- has SKILL.md
- has metadata in SKILL.md YAML frontmatter
- declares capabilities
- declares permissions
- has status: draft / experimental / verified / deprecated
- has changelog when updated
```

## Hook system

Hooks use a universal protocol:

```text
pre-command
post-command
pre-write
post-write
skill-compliance
final-verify
```

Decisions:

```text
allow
warn
require_approval
block
```

## Security posture

```text
Local-first
Read-only by default
No public tunnel by default
No silent install
No source upload by default
No auto-push
No auto-merge
No auto-deploy
```

## Engine readiness

```text
presence   → binary on PATH (or `which`)
auth       → whoami / login status, no live run
quota      → parse claude / codex / copilot quota output (src/engine-quota.ts)
```

Engine readiness results are cached in-process (`src/probe-cache.ts`): stable
results live 60 s, transient `probe-failed` results live 5 s. `vf doctor --refresh`
discards the cache and re-probes immediately. The preflight gate
(`src/preflight-delegate.ts`) layers **presence → auth → quota** in that order
and auto-falls-back to the next ready engine when the chosen one is exhausted,
returns 429 / 403, or fails auth.

## Pre-flight quota gate

```text
exhausted  → engine reports 0% quota remaining       → fall back to next ready engine
429        → rate-limited response                    → fall back to next ready engine
403        → forbidden / unauthorised billing region  → fall back to next ready engine
auth       → CLI present but no valid credentials     → fall back to next ready engine
no engine  → no engine passes all three layers        → block dispatch + surface reason
```

The gate is evaluated before every dispatch (`vf run` / `vf orchestrate`) and
short-circuits cheaply on the cache; on miss it parses a single JSON output per
engine. See `WORK_UNIT_ORCHESTRATION.md` for how the gate plugs into the
work-unit lifecycle.

## Naming decision

The recommended public product name is **VibeFlow** and the short CLI command is `vf`.

Recommended package:

```bash
npx @magicpro97/vibeflow
```

## Memory recall

VibeFlow ships a built-in recall layer (`MemoryProvider` seam, two providers):

- **builtin** (default opt-in): bun:sqlite FTS5 over `.vibeflow/knowledge/decisions.md`; zero deps; lazy-indexed on mtime.
- **claude-mem** (external opt-in): shells `claude-mem search`; requires separate install.

Recall injects a `Relevant past decisions:` block into `dispatchPrompt` (between Skills and Constraints) and `buildPlanPrompt` (beside §2 Non-negotiables). Off by default; enable via `vf config memory builtin`.

## Updated skill provider decision

The Context7 HTTP API should be the primary external skill and documentation resolver. It is queried over HTTP (`https://context7.com/api/v2`) via the runtime `fetch` — no external `ctx7` binary is required — with an optional `CONTEXT7_API_KEY` for higher rate limits. Vercel `find-skills` remains a supported secondary provider.

Default priority:

```text
1. Local verified skills
2. Context7 HTTP API (skills and docs)
3. Anthropic official skills/plugins
4. Vercel find-skills
5. Official vendor docs
6. Trusted MCP registries
7. Community skills after review
8. npm packages after security verification
```

---

**Related:** [Architecture](./ARCHITECTURE.md) · [Security Model](./SECURITY_MODEL.md)
[Edit this page on GitHub](https://github.com/magicpro97/vibeflow/edit/main/docs/MASTER_SPEC.md)
