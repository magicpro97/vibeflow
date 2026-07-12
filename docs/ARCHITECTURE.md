---
title: Architecture
description: High-level architecture of VibeFlow — four main layers from npm CLI launcher to tool adapters.
category: explanation
last_updated: 2026-06-24
---

# Architecture

## Contents

- [Overview](#overview)
- [Main Components](#main-components)
- [Stuck Detection](#stuck-detection)
- [Tool Adapters](#tool-adapters)
- [Source Modules](#source-modules)
- [Core Data Flow](#core-data-flow)
- [Canonical Context Principle](#canonical-context-principle)

## Overview

VibeFlow is a local-first tool composed of four main layers:

```text
npm CLI Launcher
  ↓
Local Web UI
  ↓
Workflow Orchestrator Core
  ↓
Tool Adapters: Claude Code / Codex CLI / Copilot CLI
```

The system should run on the user's machine and should not send source code to a remote service controlled by the tool owner unless the user explicitly configures it.

## Main components

### 1. npm CLI Launcher

Responsibilities:

- Start the local web server.
- Open the browser automatically.
- Check local dependencies.
- Install or guide installation of optional tools.
- Initialize workflow files inside the target repo.

Example commands:

```bash
npx @magicpro97/vibeflow
vf doctor
vf init
vf ui
vf run claude
vf run codex
vf run copilot
vf skills list
vf tools status
```

### 2. Local Web UI

Responsibilities:

- Collect project information.
- Ask structured questions.
- Let user connect sources.
- Show detected skills and missing skills.
- Show generated instructions.
- Show execution logs, diffs, tests, risks, and final report.

### 3. Workflow Orchestrator Core

Responsibilities:

- Act as the main agent coordinator.
- Classify task type and risk level.
- Resolve sources and file readers.
- Select local or external skills.
- Generate project context files.
- Generate tool-specific adapters.
- Dispatch Claude Code, Codex, or Copilot CLI.
- Verify output.
- Propose skill updates.

## Stuck Detection

The orchestrator runs a `StuckDetector` per in-flight work unit to surface hung engines
without aborting sibling lanes. Three configurable detection patterns:

- **Stalled:** no progress event within `stallSeconds` (default 120s).
- **Looping:** same engine output repeated `loopThreshold` times (default 3).
- **Evidence-stuck:** evidence count unchanged across `evidenceStallRounds + 1` checks (default 2 rounds → 3 checks).

The detector is driven by `recordProgress()`, `recordOutput()`, and `recordEvidenceCount()` calls
from the orchestrator's per-unit dispatch loop. `check()` returns a `StuckState` with a `reasons`
array — consumer decides whether to warn, throttle, or escalate.

See `src/orchestrator/stuck-detector.ts`.

## Tool Adapters

Adapters translate canonical workflow context into each engine's expected format. Each
adapter also exposes a `quota()` and `probe()` capability used by the preflight gate
(see `src/preflight-delegate.ts`).

```text
Canonical Context
  ↓
Claude Adapter  → CLAUDE.md + .claude/agents + .claude/skills
Codex Adapter   → AGENTS.md + .codex/config.toml + prompt injection
Copilot Adapter → AGENTS.md + .github/copilot-instructions.md + prompt injection
```

## Source modules

```text
src/probe-cache.ts          # 60s stable / 5s short-TTL probe-result cache (vf doctor)
src/engine-quota.ts         # parse claude / codex / copilot quota JSON; exhaustion signal
src/preflight-delegate.ts   # 3-layer gate (presence → auth → quota) with auto-fallback
src/skills/sync.ts          # canonical .vibeflow/skills → engine mirrors (pointer | full)
src/skills/importer.ts      # Context7 + local-dir import (temp → validate → promote → sync)
src/skills/validator.ts     # Anthropic skill-creator standard validation
src/ai-init.ts              # writes canonical context files + engine instruction files
```

## Core data flow

```text
User input
  ↓
Intake schema
  ↓
Source resolver
  ↓
Skill resolver
  ↓
Document/file reader skills
  ↓
Normalized context
  ↓
Planning + debate + task split
  ↓
Engine adapter
  ↓
CLI execution
  ↓
Hooks + verification
  ↓
Result report
  ↓
Skill evolution proposal
```

## Canonical context principle

The system should not maintain three independent instruction systems. It should maintain one canonical source:

```text
.vibeflow/PROJECT_CONTEXT.md
.vibeflow/REQUIREMENTS.md
.vibeflow/TASK_CONTEXT.md
.vibeflow/WORKFLOW_POLICY.md
.vibeflow/SKILL_INDEX.md
```

Then it generates:

```text
CLAUDE.md
AGENTS.md
.github/copilot-instructions.md
.github/instructions/*.instructions.md
```

This prevents instruction drift between Claude Code, Codex, and Copilot CLI.

---

**Related:** [Security Model](./SECURITY_MODEL.md) · [Agent Orchestration Policy](./AGENT_ORCHESTRATION_POLICY.md)
[Edit this page on GitHub](https://github.com/magicpro97/vibeflow/edit/main/docs/ARCHITECTURE.md)
