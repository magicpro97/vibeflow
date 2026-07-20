---
title: Work-Unit Orchestration
description: How VibeFlow decomposes tasks into scoped, file-backed work units with quality gates, lifecycle tracking, and sub-agent guardrails.
category: explanation
last_updated: 2026-06-24
---

# Work-Unit Orchestration

## Contents

- [Purpose](#purpose)
- [Core Concept: The Work Unit](#core-concept-the-work-unit)
- [When VibeFlow Creates Work Units](#when-vibeflow-creates-work-units)
- [Lifecycle](#lifecycle)
- [Quality Assurance](#quality-assurance)
- [Pre-Flight Gate](#pre-flight-gate)
- [Handoff Triage](#handoff-triage)
- [Resource and Progress Tracking](#resource-and-progress-tracking)
- [Sub-Agent Guardrails](#sub-agent-guardrails)
- [Mapping to the Rest of the Spec](#mapping-to-the-rest-of-the-spec)

## Purpose

This document defines how VibeFlow decomposes a task into scoped, file-backed **work
units**, enforces **quality gates** on each, and keeps **orchestration resources easy to
track**. It is the operational mechanism behind `AGENT_ORCHESTRATION_POLICY.md`: that
document sets the policy (orchestrator role, confidence thresholds, debate, anti-
hallucination), this document defines the file structure, gates, and tracking ledger that
make the policy observable and auditable.

The model is adapted from the tentacle / OctoGent pattern: one orchestrator, many scoped
work units, each persisted as files so nothing is lost between agent boundaries.

## Core concept: the work unit

A **work unit** is a scoped slice of the task stored as files under the canonical
`.vibeflow/` tree (no new top-level directories — keeps the minimal-footprint principle
in `MASTER_SPEC.md`):

```text
.vibeflow/workunits/<name>/
  CONTEXT.md     # scope, constraints, key files the agent needs (the dispatch prompt)
  evidence/      # recorded gate output as JSON: <engine>.result.json, investigation.json
```

Today the orchestrator writes exactly `CONTEXT.md` (the per-unit dispatch prompt) and the
`evidence/` folder (`<engine>.result.json` from each dispatch, `investigation.json` when a
sub-1.0 confidence run is investigated). Per-unit STATE — status, confidence, gates, owner,
skills, resources, evidence paths — does NOT live in a per-unit `meta.json`; it lives
centrally in `.vibeflow/WORKFLOW_STATE.json` (see Resource and progress tracking below).

Planned (not yet implemented): `TODO.md` (atomic checkbox deliverables) and `HANDOFF.md`
(agent results + evidence on completion). The shape a planned `meta.json` would carry — and
which today is held inside each `work_units[]` entry of `WORKFLOW_STATE.json` — is:

```json
{
  "name": "auth-refactor",
  "scope": ["src/auth/**"],
  "status": "pending",
  "confidence": 1.0,
  "depends_on": [],
  "evidence_owner": "test-engineer",
  "implementation_owner": "backend-engineer",
  "acceptance_signal": "all auth tests pass and login flow works",
  "resources": { "agents": 0, "tokens": 0, "cost_usd": 0.0, "wall_seconds": 0 }
}
```

## When VibeFlow creates work units

Follow the minimal-footprint principle — do not create work-unit files for trivial tasks.

```text
1-2 files, single concern        → direct execution, no work unit
3+ files, single module          → optional single work unit for tracking
3+ files, multiple modules       → REQUIRED: one non-overlapping work unit per module
Multi-phase / delegated agents   → REQUIRED: one work unit per delegated agent
Bug with multiple hypotheses     → recommended: one work unit per hypothesis
```

**Non-overlapping scopes are mandatory.** Two work units must never declare overlapping
file scopes — parallel agents would otherwise overwrite each other.

## Lifecycle

```text
Clarify → Plan → Execute → Verify → Goal-eval → Close
```

```text
Clarify   : spec is made implementation-ready before any decomposition
Plan      : decompose into non-overlapping work units; write CONTEXT.md + TODO.md
Execute   : dispatch one agent per work unit; independent units run in parallel
Verify    : run quality gates on each unit; record evidence
Goal-eval : orchestrator checks the overarching goal; loop for gaps or proceed
Close     : merge, runtime-verify, persist learnings, clean up
```

## Quality assurance

### Decision confidence gate

Before creating, dispatching, merging, or closing a work unit, confidence must be `1.0`.
Confidence `< 1.0` means the orchestrator is still guessing.

```text
If confidence < 1.0:
  - stop implementation/merge/close decisions for that scope
  - split the ambiguity into atomic research questions
  - dispatch read-only research/validation agents on the strongest model
  - record evidence + rejected alternatives in HANDOFF.md
  - proceed only at confidence 1.0 or with an explicit, logged user override
```

This composes with the risk-based thresholds in `AGENT_ORCHESTRATION_POLICY.md`: those
thresholds decide when bounded investigation is required; this gate forbids merging or
closing on a guess.

### Verification gates

Each work unit's output passes these gates before it is accepted. Build, lint, test, and
review are mandatory; docs and QA-audit are conditional.

```text
Build     : compiles / type-checks            (never skip)
Lint      : style, unused imports, formatting  (never skip)
Test      : logic, regressions, contracts      (never skip)
Review    : security, design, scope creep      (never skip — separate review agent)
             Context isolation (ADR-001): reviewer receives ONLY goal + spec + diff.
             No dispatch prompt, no self-report, no workflow reasoning chain.
             `buildReviewerPrompt()` enforces this — do not bypass.
Docs      : README/API/JSDoc/CHANGELOG sync    (skip only for internal refactors)
QA audit  : cross-check by a different agent    (high-risk changes only: auth/data/billing/infra)
```

### Evidence requirement

A gate is passed only when VibeFlow holds the recorded proof — never on an agent's claim
that "tests pass" or "lint is clean". The orchestrator (or hooks) runs the command and
stores output under `evidence/`.

```text
- "all tests pass"  is not evidence; the recorded test command + pass/fail counts are.
- A gate that was not run is recorded as: "not proven yet — run <command>".
- A DONE handoff with no evidence ledger is treated as AMBIGUOUS and requires triage.
```

### Verifiable evidence format (ADR-004)

`vf verify` warns when evidence strings are free-text claims rather than machine-verifiable
artifacts. Accepted formats:

| Format | Example |
|--------|---------|
| Command output capture | `bun test 2>&1 \| tail -3 → "12 pass, 0 fail"` |
| File:line reference | `src/gates.ts:47 — added isVerifiableEvidence()` |
| Commit SHA | `commit abc1234 — feat: add goalEval gate` |
| Test name:result | `pending-hooks > clearPending: removes all entries [0.04ms]` |
| CI run URL | `https://github.com/magicpro97/vibeflow/actions/runs/123` |
| Git command output | `git diff --stat origin/main HEAD → 3 files changed` |

Rejected: `"done"`, `"tests pass"`, `"implementation complete"`, any string under 10 chars.

Use `vf units evidence <name> --add 'bun test 2>&1 | tail -3 → "<output>"'` to record.
Phase 2 (current): **gate failure** — `vf verify` exits 1 when evidence is free-text.
Escape hatch: `vf verify --allow-unverified-evidence` / `vf orchestrate --allow-unverified-evidence`.
```

This is the file-backed enforcement of the policy rule "no verification, no completion"
(`MASTER_SPEC.md`) and ties directly to the hook `final-verify` and `skill-compliance`
events in `HOOKS_AND_GUARDRAILS.md`.

## Pre-flight gate

Before any unit is dispatched the orchestrator runs a **3-layer gate** for the
target engine (`src/preflight-delegate.ts`):

```text
1. presence  → is the engine binary on PATH?
2. auth      → is the engine authenticated for this user?
3. quota     → does the engine have usable capacity right now?
```

If any layer fails the orchestrator **auto-falls-back** to the next engine that
passes all three layers (claude → codex → copilot by default; see
`AGENT_ORCHESTRATION_POLICY.md` for the priority). A unit that finds no engine
ready is recorded as `BLOCKED` and surfaced on the triage banner
(`WEB_UI_DESIGN.md`) — the dispatch never silently no-ops. The gate consults the
probe cache (`src/probe-cache.ts`, 60 s stable / 5 s short TTL) and only hits the
network / engine CLI on miss; `vf doctor --refresh` invalidates the cache.

Quota signals come from `src/engine-quota.ts`, which parses:

```text
claude  → `claude usage --json`
codex   → `codex doctor --usage`
copilot → `gh api copilot`
```

Exhaustion, 429 (rate-limited), 403 (forbidden / billing region), and auth
failures all trigger fallback. A `BLOCKED` unit with no fallback engine is the
terminal state — the orchestrator surfaces the reason and stops.

## Handoff triage

Every agent writes a structured handoff with a terminal status. Triage precedes the
verification gates — do not run Build/Lint/Test/Review on a unit with a triage status
until the underlying issue is resolved.

```text
DONE       → proceed to verification gates
BLOCKED    → read HANDOFF.md; create new unit for missing scope, adjust scope, or cancel
TOO_BIG    → re-decompose into 2+ smaller non-overlapping units
AMBIGUOUS  → clarify spec/constraints with user, then re-dispatch with updated CONTEXT.md
REGRESSED  → fix the regression before any other gate
```

### Goal-evaluation loop

After all per-unit gates pass, the orchestrator (never a sub-agent) evaluates the
overarching goal against success criteria that were defined during Plan — not invented now.

```text
Goal met            → proceed to Close
Goal partially met  → return to Plan; create NEW units for the gaps (never re-open closed units)
Goal blocked        → record the gap in HANDOFF.md, surface to the user
```

The goal-eval result is recorded as evidence so the decision is auditable.

### Calibrated judge score (#545)

When the reviewer-LLM judges a unit, it ends its verdict with a calibrated
`SCORE: 0.NN` line — its own probability (0..1) that the goal is fully met. vf
records this as `goal_score` on the unit and folds it into the computed
confidence as a *graded* signal (weight ≈ the independent review gate): a weak
but "COVERED" verdict no longer scores the same as a confident one. The score is
advisory-graded, never the sole authority — the binary `goal_eval` gate remains
the hard floor (a failed judge still zeros confidence), and self-report can only
lower confidence, never inflate it. Absent/unparseable score ⇒ omitted
(fail-open: units without a judge run are unchanged). The score surfaces per unit
in the web UI work-unit table (⚖ badge).

## Resource and progress tracking

The orchestration ledger lives in `.vibeflow/WORKFLOW_STATE.json` and aggregates every
work unit, so progress and resource use are observable at a glance instead of being lost
inside agent contexts.

```json
{
  "task_id": "TASK-123",
  "goal": "Refactor auth without breaking login",
  "success_criteria": ["all auth tests pass", "login e2e green"],
  "work_units": [
    {
      "name": "auth-refactor",
      "status": "verifying",
      "confidence": 1.0,
      "owner_agent": "backend-engineer",
      "skills_used": ["repo-onboarding"],
      "gates": { "build": "pass", "lint": "pass", "test": "running", "review": "pending" },
      "resources": { "agents": 1, "tokens": 48213, "cost_usd": 0.42, "wall_seconds": 95 },
      "evidence": ["evidence/build.log", "evidence/lint.txt"]
    }
  ],
  "totals": { "units": 3, "done": 1, "tokens": 152104, "cost_usd": 1.31, "wall_seconds": 410 }
}
```

Tracked per work unit and rolled up to `totals`:

```text
- status and gate state (pending / running / verifying / done / blocked)
- decision confidence
- owner agent and skills used (for skill-compliance checks)
- resources: agent count, tokens, estimated cost, wall-clock time
- evidence file paths
```

### Web UI surfacing

The web UI (`WEB_UI_DESIGN.md`) renders this ledger as a live orchestration dashboard so
the user can follow quality and resource consumption without reading raw logs:

```text
- Work-unit board: one card per unit showing status, gates, owner, confidence
- Gate strip: build / lint / test / review with pass / fail / running / pending
- Resource meter: tokens, estimated cost, elapsed time per unit and in total
- Evidence drawer: links to recorded gate output under evidence/
- Triage banner: any BLOCKED / TOO_BIG / AMBIGUOUS / REGRESSED unit is surfaced first
```

Updates stream over the existing WebSocket/SSE channel (`WEB_UI_DESIGN.md`).

### CLI surfacing

The same ledger is inspectable from the terminal (see `COMMAND_REFERENCE.md`):

```bash
vf units status            # board: status, gates, owner, confidence per unit
vf units show <name>       # one unit: scope, todos, gates, evidence, resources
vf units resources         # token / cost / wall-time totals across units
vf units evidence <name>   # recorded gate output for a unit
```

When a unit's review settles, the orchestrator also emits a verdict event onto the
`vf` logbus channel (visible via `vf logs` / the SSE endpoint) as
`{ kind: "verdict", review: "pass"|"fail", gates, goal_score? }` with the unit as
`unit`. Unlike `WORKFLOW_STATE.gates` (which keeps only the last state, overwritten
each update), this is an append-only record of the decision at the moment it
happened, so `vf logs` and any export see a complete, ordered stream (#542).

## Sub-agent guardrails

Conventions injected into every dispatched agent's CONTEXT.md and enforced by hooks where
possible (`HOOKS_AND_GUARDRAILS.md`, `SECURITY_MODEL.md`):

```text
- stay in scope: never edit files outside the unit's declared scope
- escalate, don't expand: write the gap to HANDOFF.md and stop; the orchestrator decides
- no over-implementation: do only what TODO.md specifies
- handoff before stopping: always write a structured handoff with status + changed files
- the orchestrator commits/merges; sub-agents must not push or merge
```

## Pipeline observability

The workflow dashboard (Home screen) shows every registered workflow as a
dependency pipeline. Each work unit appears as a node in the correct wave
(layer). Node colors reflect status: pending (neutral), running (animated blue),
verifying (animated amber), done (green), blocked (red). Edge arrows indicate
`depends_on` relationships.

Node detail shows:
- Owner agent and elapsed time
- First failing gate (blocked) or "waiting for: a, b" text
- No dependency cycle or missing-dep warnings

A dashboard log drawer scoped to the selected workflow and unit replaces the
ad-hoc project log drawer. Events carry `workflowId` and `repoPath` for
correlation; legacy events lacking these fields remain visible only within
their selected repo file (never leaked across workflows).

### Log ownership

Every `out()` call in a workflow run stamps `(repoPath, task_id)` onto the
event. This is set once at `installLogbus()` time and merged into all writes.
Non-workflow commands produce unowned events that remain valid and parseable.

## Mapping to the rest of the spec

```text
AGENT_ORCHESTRATION_POLICY.md → policy (roles, confidence thresholds, debate, parallelism)
WORK_UNIT_ORCHESTRATION.md     → mechanism (file-backed units, gates, ledger)  [this doc]
HOOKS_AND_GUARDRAILS.md        → enforcement points (final-verify, skill-compliance, pre-write)
WEB_UI_DESIGN.md               → operator view (work-unit board, gates, resource meter, pipeline graph)
GENERATED_FILES.md             → .vibeflow/workunits/* file layout
WORKFLOW.md                    → end-to-end run that drives these units
ADR-006.md                     → pipeline observability decision record
```

---

**Related:** [Agent Orchestration Policy](./AGENT_ORCHESTRATION_POLICY.md) · [Skill Discovery and Evolution](./SKILL_DISCOVERY_AND_EVOLUTION.md)
[Edit this page on GitHub](https://github.com/magicpro97/vibeflow/edit/main/docs/WORK_UNIT_ORCHESTRATION.md)

### Spec-first test generation (ADR-002)

When `work_unit.spec` is non-empty, vf can generate test stubs from the spec BEFORE
dispatching the implementer. The LLM sees ONLY the spec — no source code, no implementation.

```text
Phase 1 (current): generateSpecFirstTests() is injectable — opt-in via --spec-first flag (phase 2).
Phase 2: vf orchestrate --spec-first generates *.spec-first.test.ts before dispatch.
```

Protection rule: pre-write hook blocks any write to `*.spec-first.*` files during dispatch.
These files are oracle tests — the implementer must pass them, not change them.

Use `generateSpecFirstTests({ unitName, spec, llmFn })` to generate stubs programmatically.
