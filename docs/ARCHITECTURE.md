---
title: Architecture
description: High-level architecture of VibeFlow — AI-first Home, conversation runtime, owned async dispatch, and typed capability fabric.
category: explanation
last_updated: 2026-08-26
---

# Architecture

## Contents

- [Overview](#overview)
- [Main Components](#main-components)
- [Stuck Detection](#stuck-detection)
- [Crash Recovery](#crash-recovery)
- [Conversation Turn Delivery](#conversation-turn-delivery)
- [Tool Adapters](#tool-adapters)
- [Source Modules](#source-modules)
- [Core Data Flow](#core-data-flow)
- [Canonical Context Principle](#canonical-context-principle)

## Overview

VibeFlow is a local-first harness composed of four main layers:

```text
npm CLI Launcher
  ↓
AI-first Home + Local Web UI
  ↓
Conversation / Dispatch Orchestrator Core
  ↓
Tool Adapters + Typed Capability Fabric
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
- Expose the command surface that launches AI-first Home and the owned dispatch paths.

Example commands:

```bash
npx @magicpro97/vibeflow
vf doctor
vf init
vf ui
vf run claude
vf run codex
vf run copilot
vf run antigravity
vf skills list
vf tools status
```

### 2. AI-first Home / Local Web UI

Responsibilities:

- Show a searchable session rail, central conversation pane, and composer-first workflow.
- Preserve the conversation in one place: participants, lifecycle, trace, approvals, and artifacts.
- Keep add/remove-agent actions, queue editing, quotes, reactions, and approval/capability
  actions inside the conversation instead of opening a separate workspace.
- Surface details, capabilities, and trace drawers without leaving the current conversation.
- Fall back to the intake wizard for first-run repo setup and context capture.

### 3. Conversation / Dispatch Orchestrator Core

Responsibilities:

- Keep the durable FIFO message queue, private file context, and turn envelope (`VF-TURN/1`).
- Preserve each CLI's native session history when exact resume proof exists; fall back to full public context when it does not.
- Dispatch Claude Code, Codex, Copilot, OpenCode, or Antigravity CLI through the canonical owned async route.
- Verify output, trace evidence, and completion state.
- Propose skill updates and owned-process recovery when evidence is incomplete.

### 4. Tool Adapters + Typed Capability Fabric

Responsibilities:

- Translate canonical workflow context into each engine's expected format.
- Maintain typed capability manifests and adapters for skills, MCP, tools, hooks, roles, and engine settings.
- Extend the selected CLI with approved capabilities without loading arbitrary browser plugin code.
- Expose `quota()` and `probe()` capabilities used by the preflight gate.

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

Dispatch captures the engine's native session id into `DispatchMarker.engineSessionId` for
crash-resume. The canonical owned async launcher also stores supervisor and CLI PIDs, host,
attempt/operation, and exact process-start identity. A terminal record is not released until
the process is quiescent and stdout/stderr have crossed the `streams-drained` barrier.

| Platform | Scope | Proof strength | Boundary |
|----------|-------|----------------|----------|
| Windows | `windows-job` | `kernel-contained` | A kill-on-close Job Object is established before receipt/spawn; exact creation ticks come from PowerShell/CIM, never `/bin/ps`. |
| Linux / macOS | `posix-process-group` | `cooperative-lineage` | An isolated process group and exact root identity are proved, but descendants can deliberately escape the group. |

Linux uses boot id plus `/proc` start ticks; macOS uses exact Darwin `libproc`
seconds/microseconds. `vf doctor --fix` takes over only after exact proof that an owner is no
longer the recorded process. Live or unprovable owners fail closed. Windows behavior has
injected cross-platform regression coverage in this tree; this evidence does not claim a live
Windows canary. See `docs/ENGINE-COMPAT.md` for adapter-specific resume contracts.

## Conversation Turn Delivery

Public participant input is a canonical JSON envelope prefixed by `VF-TURN/1`. A proved
exact native resume reuses the selected CLI's session and sends only new applicable user
messages plus peer-agent responses/reactions. The recipient's own prior output stays in that
native history and is not echoed back. Missing or stale cursor proof switches to the
full applicable public handoff, optionally combined with content-addressed `VF-HANDOFF/1`.

Private file ranges are materialized separately as one-shot canonical JSON prefixed by
`VF-PRIVATE-FILE-RANGES/1`; they never enter public trace/browser persistence and are cleared
after use. Prompt transport remains adapter-specific. A large Copilot work-unit prompt can use
`.vibeflow/dispatch/<unit>.md` plus a short absolute read pointer, but that file is transport,
not memory or native session state.

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
OpenCode Adapter → AGENTS.md + opencode.json + .opencode/plugins/vf-guard.ts
Antigravity Adapter → AGENTS.md + .agents/agents + .agents/skills + .agents/mcp_config.json + .agents/hooks.json
```

## Interactive Plan Review (PR1)

The plan review subsystem persists plan markdown as file-backed immutable revisions
under `.vibeflow/plan-review/`. Each revision is a write-once JSON file keyed by UUID;
`index.json` tracks the current revision pointer per workflow. Blocks are parsed
server-side into typed segments (heading, paragraph, list-run, fenced-code,
fenced-mermaid) and rendered by the client through a safe semantic renderer
(`plan-render.ts`) that HTML-escapes all content — no `v-html`.

Selection anchors (`BlockAnchor`) provide the groundwork for threaded comments (PR2)
without storing comment data in PR1. Mermaid sources are preserved as fallback text;
no mermaid runtime is loaded.

API surface: `GET /api/plan-review` and `POST /api/plan-review/revisions`, both
CSRF-guarded, with scope caps (1,000 blocks, 1 MB markdown, 100 KB per block).

See `src/plan-review/`, `src/server/plan-review.ts`, `src/ui/src/lib/plan-render.ts`,
`src/ui/src/lib/plan-anchor.ts`, and `docs/adr/ADR-007-interactive-plan-review.md`.

## Source modules

The web UI also exposes a read-only diff preview endpoint (`GET /api/dashboard/diff`)
that returns workflow-level changed-file summaries and scope-limited work-unit diffs.
Git operations use `spawnSync` with argv arrays (no shell interpolation).
See `src/server/dashboard-diff.ts` and `docs/WEB_UI_DESIGN.md` section 10.

```text
src/probe-cache.ts          # 60s stable / 5s short-TTL probe-result cache (vf doctor)
src/engine-quota.ts         # parse claude / codex / copilot quota JSON; exhaustion signal
src/preflight-delegate.ts   # 3-layer gate (presence → auth → quota) with auto-fallback
src/dispatch/owned-ai-route.ts  # canonical lifecycle boundary for owned AI launches
src/orchestrator/conversation/turn-delivery.ts # VF-TURN/1 exact/full-history turn delivery
src/capabilities/service.ts # typed capability fabric service
src/skills/sync.ts          # canonical .vibeflow/skills → engine mirrors (pointer | full)
src/skills/importer.ts      # Context7 + local-dir import (temp → validate → promote → sync)
src/skills/validator.ts     # Anthropic skill-creator standard validation
src/ai-init.ts              # writes canonical context files + engine instruction files
src/plan-review/            # immutable revision store, blocks parser, types
```

## Core data flow

```text
User input
  ↓
AI-first Home / intake wizard
  ↓
Source resolver
  ↓
Skill resolver
  ↓
Private file context + document/file reader skills
  ↓
Normalized context
  ↓
Planning + debate + task split
  ↓
VF-TURN/1 turn delivery
  ↓
Engine adapter
  ↓
Owned async CLI execution
  ↓
Hooks + verification
  ↓
Result report
  ↓
Skill evolution proposal
```

## Pipeline observability data flow (ADR-006)

```text
Registry + WORKFLOW_STATE + durable logs (current.log)
  → buildDashboardItems() — read-only aggregation
  → GET /api/dashboard/workflows — snapshot JSON
  → GET /api/dashboard/logs — selected workflow durable events
  → SSE /api/dashboard/logs/stream — live tail of selected workflow log
  → Vue WorkflowDashboard (polling composable)
  → PipelineGraph (CSS Grid + SVG) + WorkflowLogPane (scoped drawer)
```

Events carry optional `workflowId` (state.task_id) and `repoPath` for
correlation. Legacy events without these fields are still parseable and
visible within their repo's log file. The selection resolver validates
`repoPath` against the registry, `workflowId` against the state, and
`unit` against known unit names — all server-side.

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
