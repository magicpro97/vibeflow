---
title: Architecture
description: High-level architecture of VibeFlow — AI-first Home, conversation runtime, owned async dispatch, and typed capability fabric.
category: explanation
last_updated: 2026-09-22
---

# Architecture

## Contents

- [Overview](#overview)
- [Main Components](#main-components)
- [Stuck Detection](#stuck-detection)
- [Crash Recovery](#crash-recovery)
- [Conversation Turn Delivery](#conversation-turn-delivery)
- [Project Classification](#project-classification)
- [Protocol Authority Standard](#protocol-authority-standard)
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
- Keep repository intake outside Home; `vf init` asks its questionnaire in a TTY.

### 3. Conversation / Dispatch Orchestrator Core

Responsibilities:

- Keep the durable FIFO message queue, private file context, and turn envelope (`VF-TURN/1`).
- Preserve native history for exact Claude, Codex, and OpenCode resumes. Otherwise attach bounded structured recipient history to canonical public context.
- Dispatch Claude Code, Codex, Copilot, OpenCode, or Antigravity CLI through the canonical owned async route.
- Verify output, trace evidence, and completion state.
- Propose skill updates and owned-process recovery when evidence is incomplete.

### 4. Tool Adapters + Typed Capability Fabric

Responsibilities:

- Translate canonical workflow context into each engine's expected format.
- Maintain typed capability manifests and adapters for skills, MCP, tools, hooks, roles, and engine settings.
- Extend the selected CLI with approved capabilities without turning VibeFlow into another coding engine or loading arbitrary browser plugin code.
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
longer the recorded process. Live or unprovable owners fail closed. Windows behavior has injected
regression coverage. Live Windows evidence is accepted only from a green, exact-SHA
`windows-latest` CI smoke job; a local macOS/Linux run is not a Windows canary.
See `docs/ENGINE-COMPAT.md` for adapter-specific resume contracts.

### Windows path privacy (DACL policy)

POSIX mode bits do not exist on Windows, so durability paths prove privacy through their DACL
instead: exactly one allow ACE for the current user, with `SE_DACL_PROTECTED` set so the three
ACEs a path normally inherits (SYSTEM, Administrators, owner) cannot creep back in. Paths created
before this policy are migrated in place on first use rather than rejected, so an existing install
keeps working.

Three Win32 details this depends on, each measured rather than assumed:

- Migration applies **through the object's handle** (`SetSecurityInfo` on a handle opened with
  `WRITE_DAC`, flags coerced with `>>> 0`). Measured on Windows 11: with that access the handle
  write sets the DACL, so the earlier note that it returns `0` and changes nothing does not hold.
  A path-based `SetNamedSecurityInfoW` write is no longer used — a writer that replaced the name
  would have had the descriptor land on its object instead of ours.
- Any flag mask with bit 31 set (`PROTECTED_DACL_INFORMATION` is `0x80000000`) must be coerced
  with `>>> 0`; JS bitwise OR produces a negative int32 that reaches Win32 as garbage flags.
- Opening a **directory** with `CreateFileW` requires `FILE_FLAG_BACKUP_SEMANTICS`, otherwise the
  ACL check fails to obtain a handle and every directory reads as not-private.

## Conversation Turn Delivery

Public participant input is a canonical JSON envelope prefixed by `VF-TURN/1`. Claude,
Codex, and OpenCode are the only engines with proved exact by-id authority. A proved exact
native resume reuses the selected CLI's session and sends only new applicable user
messages plus peer-agent responses/reactions. The recipient's own prior output stays in that
native history and is not echoed back. Without valid exact authority, the full turn adds a
bounded replay of the recipient's last eight public responses to applicable user/peer context.
Each replay summary is capped at 2 KiB UTF-8 and carries source digest, provenance, and
count/truncation metadata. Copilot and Antigravity therefore never claim exact resume or
silently omit the recipient's own context. A full turn may also include content-addressed
`VF-HANDOFF/1`.

Private file ranges are materialized separately as one-shot canonical JSON prefixed by
`VF-PRIVATE-FILE-RANGES/1`; they never enter public trace/browser persistence and are cleared
after use. Prompt transport remains adapter-specific. A large Copilot work-unit prompt can use
`.vibeflow/dispatch/<unit>.md` plus a short absolute read pointer, but that file is transport,
not memory or native session state.

## Protocol Authority Standard

Persisted, API, and configuration closed vocabularies have one dependency-light source of
truth. Production contracts declare an `Object.freeze({ ... } as const)` authority, infer
their TypeScript union and frozen value list from it, and expose prototype-safe guards for
untrusted boundaries. Backend, CLI, and browser consumers import or alias that same authority.

TypeScript `enum`/`const enum`, duplicate UI wire unions, mutable vocabulary `Set`s, blind
casts, and raw producer/comparison literals are rejected by dynamic source gates. Exhaustive
maps and intentional subsets must also be frozen and typed from the authority. This rule is
for cross-layer protocol vocabulary; ordinary prose and genuinely local one-off strings stay
ordinary strings.

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

## Project classification

Conversations are filed into named **projects**. A project is a durable entity rather than a
derived `repo_root` path, because the rail's grouping key, the classifier's candidate list, the
public `project_id` label, and the engine preference must all be one identity that survives a
folder move and can be named by a user. The full decision record is
`docs/adr/ADR-009-project-classification.md`.

### Project entity and registry

```text
ProjectV1 { id, name, goal, context, repos[], engine { cli, model, thinking }, created_at }
<repoRoot>/.vibeflow/projects/registry.json   # one private JSON document per repo root
<repoRoot>/.vibeflow/projects/registry.lock   # write lock
```

The store writes the whole document under a process lock with an atomic stage-then-rename
compare-and-swap, and callers hand it a mutator instead of a computed list, so the preimage and
the payload come from one lock-scoped read. An absent document is the empty registry; a corrupt
one raises `ProjectRegistryCorruptError` rather than resetting the user's projects. Bounds:
256 projects, 64 repos per project, 4 MiB document. Ids are slugs
(`^[a-z0-9][a-z0-9-]{0,63}$`), `repos[]` is absolutized and order-preservingly deduped, and
`id`/`created_at` are immutable on update. The registry root is repo-local like
`.vibeflow/conversation`: two checkouts never share a project list, and no global path can
collide with a machine-wide config file.

### `project_id` on conversation summaries

Every conversation manifest carries `project_id`, and `catalog-row.ts` reads that field into
every catalog DTO and its searchable projection — the value is not derived at read time (the
former basename-of-`repo_root` derivation was removed). One grammar, `isConversationProjectId`,
is applied uniformly at six boundaries: manifest validator, create funnel, create wire, catalog
projection, catalog DTO, and registry. Because the pattern admits no separator, a `project_id`
cannot carry filesystem layout. Creation runs the deterministic classifier tiers over the new
conversation's own `repo_root` and topic, so a conversation opened inside an imported repo is
filed before its first message.

### The four-tier pipeline

Classification is server-side, first hit wins, and the model is consulted last:

```text
1. repo      repo_root inside a project's repos[] (explicit import)  → confidence 1, tier ladder stops
2. mention   message names a registered project as @project-slug     → confidence 1, tier ladder stops
3. fts       bun:sqlite FTS5 index of project descriptors            → binds when score > 30
              wins if score > 30 AND lead over runner-up > 10           and margin > 10
4. ai        injected proposal seam (curator bridge);                → binds only at confidence >= 0.6
              reached ONLY when tier 3 is inconclusive
5. fallback  nothing resolved it                                     → reserved default project `idea`, 0
```

The minimize-AI invariant is the tier order: tiers 1–2 are exact, so no later tier — retrieval
included — ever runs. Tier 3 is deterministic and re-indexed from the live registry on every
classification, so an edited project cannot keep winning with its previous goal. Tier 4 is
nullable: with no `bun:sqlite` and no `VIBEFLOW_AI` bridge, classification still answers
deterministically. `confidence` is per-tier evidence (an `@mention` is `1`; `ai` is the model's
probability; `fts` is normalized term coverage), so consumers that need "how sure" read `reason`,
and the suggestion gate branches on it: `fts` may propose at any confidence above 0, `ai` only at
`>= 0.6`, `repo`/`mention`/`fallback` never propose. Every tier re-checks the live registry, so
neither the index nor the model can bind a project that does not exist.

### UI surfaces

- **Rail folders** — `HomeSessionRail.vue` renders one divider per project from the pure,
  browser-safe `project-rail-group.ts`: newest entry first, name then id as tiebreak, the
  reserved catch-all (`Ideas`) pinned last and tinted.
- **Suggestion chip** — `ProjectSuggestionChip.vue` in the composer column offers a confirmed
  move (`POST /api/conversation-projects/move`); nothing under an acceptance floor renders a
  control that moves a conversation, and dismissals are remembered per (session, project).
- **Settings panel** — `ProjectSettingsPanel.vue` (inside the preferences drawer) holds the
  global auto-classify switch, the global classifier engine, and one per-project engine override
  row per registry project. Inherit is the empty state, shown as a placeholder, never a stored
  guess.

Routes (session-authorized; writes CSRF-guarded):

| Method | Route | Result |
|--------|-------|--------|
| `GET` | `/api/conversation-projects` | Rail labels: `id`, `name`, `goal`, `engine` only |
| `PATCH` | `/api/conversation-projects/{id}` | Project engine override |
| `POST` | `/api/conversation-projects/classify` | One classifier verdict (`project_id`, `confidence`, `reason`) |
| `POST` | `/api/conversation-projects/move` | The chip's confirm; re-binds the active revision |

`repos[]` and `context` never cross the wire. Project `create`/`delete` exist in the registry
authority but are not exposed by any route or command yet: creation needs the folder-import flow
and deletion needs decided semantics for the conversations filed under a deleted project.

### Settings persistence

`settings.ts` carries one feature-scoped block, coerced and merged like the curator block:

```text
projectClassification: {
  enabled: boolean,                    # durable gate: OFF ⇒ classifier never runs, no chips
  engine: { cli: Engine | null, model: string | null, thinking: string | null },
}
```

Auto-classify is ON by default, and OFF is read from the document at first use (not at drawer
mount) so a reload cannot resurrect a chip. `null` means "auto" — stored instead of a guessed
engine name so a project with no opinion never pins classification to one CLI. Precedence is
`project.engine.cli` → global block → unset. Only `cli` has a consumer today (the classifier's AI
tier engine); `model`/`thinking` are validated, bounded, persisted, and round-tripped with no
dispatch surface yet, as recorded in ADR-009.

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
src/orchestrator/conversation/project-registry-authority.ts # Project registry CRUD + invariants
src/orchestrator/conversation/project-classifier.ts        # deterministic tiers (repo / @mention)
src/orchestrator/conversation/project-classifier-authority.ts # tier ladder + FTS/AI gates
src/orchestrator/conversation/project-fts.ts               # bun:sqlite FTS5 retrieval tier
src/skills/project-classifier-runtime.ts # tier 3/4 composition (index + AI seam)
src/server/conversation-project-route.ts # registry read, engine override, classify, move
src/ui/src/project-rail-group.ts         # pure, browser-safe folder grouping for the rail
```

## Core data flow

```text
User input
  ↓
AI-first Home or the separate `vf init` TTY questionnaire
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
