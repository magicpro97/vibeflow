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
- [Crash Recovery](#crash-recovery)
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

## Crash Recovery

The orchestrator persists a marker (`~/.vibeflow/markers/<unit>.json`) for every unit
it dispatches, plus an append-only timeline ledger (`<unit>.timeline`) next to it. These
files are the source of truth for "what was the engine doing when the process died" — they
survive a crash or Ctrl-C intact.

`vf status` reads them back (never re-running anything): a table of UNIT / STATUS / CONF /
EVID / UPDATED / ISSUE across all units, highlighting the `running` unit (the crash point)
and flagging a `done` marker that published no evidence. `vf status timeline <unit>` dumps
that unit's full transition ledger; `vf status --json` emits machine-readable output.

See `src/commands/status.ts`, `src/orchestrator/marker.ts`, `src/orchestrator/timeline.ts`.

Dispatch captures the engine's `session_id` (claude JSON envelope) into `DispatchMarker.engineSessionId`, persisted for crash-resume. PR2a (#618 PR2a) wires `resumeSessionId` through the dispatch layer so a claude unit can resume its prior session (`claude -p -r <id>`) instead of a fresh run. Orchestrate-level resume (reading a crashed marker) + codex/copilot support land in PR2b.

## Wave Handoff

Units declare `depends_on` (carried from the planner's proposal onto the `WorkUnit`).
`scheduleWaves` topologically orders them into dependency waves: each wave holds only
units whose deps are already satisfied, and units within a wave run concurrently.
`dispatchInWaves` runs the waves in order — after every wave, each finished unit's
derived one-line summary (`deriveHandoff`: name + status + evidence count, sanitized and
capped at 500 bytes) is recorded and injected as an `## Upstream context` block into its
dependents' dispatch prompt in the next wave. This is best-effort context, not a contract.
With no `depends_on`, `scheduleWaves` returns a single wave ⇒ one dispatch call ⇒ identical
to the pre-#612 behavior.

See `src/orchestrator/waves.ts`, `src/orchestrator/handoff.ts`, `src/orchestrator/plan.ts`.

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
