---
name: coordinator
description: "Coordinate VibeFlow work through compact task contracts, bounded engine dispatch, independent cross-review, trace capture, and merge gates. Use on every vf coord or vf init run, and whenever delegating non-trivial implementation to CLI agents or Hermes."
when_to_load: "Load for vf coord, vf init, multi-agent work, or any non-trivial delegated implementation."
triggers:
  - vf coord
  - vf init
  - multi-agent
  - delegate
  - Hermes
capabilities:
  - coordination
  - task-contract
  - engine-dispatch
  - cross-review
  - trace-capture
---

# VibeFlow Coordinator

The coordinator does not implement by default. It reads the brief, dispatches
bounded work, verifies real outcomes, and keeps the brief current.

## 0. Activation

Use for `vf coord`, `vf init`, multi-agent implementation, or any non-trivial
delegated change that needs scope, verification, and trace control.

### When not to use

Skip the full loop for a trivial local check or a task the user explicitly asks
the current agent to perform directly. Still obey repository safety and verify edits.

## 1. Startup

Before any non-trivial action:

1. Read `.vibeflow/knowledge/coordinator-brief.md`.
2. If missing, run `vf state brief write`.
3. If stale, run `vf state brief --consult`.
4. If corrupted or half-written, stop and use `references/operations.md`.
5. Read only the inputs: §1 Ask, §2 Non-negotiables, §5 Next action.

If §1 is ambiguous or §2 conflicts with the task, stop and ask the user.

## 2. Steps and task contract

For each non-trivial task:

1. Consult the brief.
2. Check §2 non-negotiables.
3. Write a Task Contract.
4. Dispatch the smallest useful bounded unit.
5. Verify from real edits/tests, not self-report.
6. Cross-review before merge.
7. Update §4 State of play and §5 Next action.

Trivial actions such as rerunning a test, pruning a worktree, or editing the
brief may skip dispatch, but still log the result in §4.

### Task Contract

Before dispatch, write a compact contract:

- Goal: one-sentence outcome.
- Scope: allowed files/dirs.
- Forbidden: what may not change.
- File pointers: exact files, symbols, logs, or tests to read first.
- Must-haves: required behaviors or acceptance checks.
- Non-goals: work explicitly out of scope.
- Verify oracle: command, test, artifact, or diff that proves success.
- Budget: label limits as `enforced` or advisory `target`; use `unspecified` only
  when no useful estimate exists.
- Output: changed files, evidence, risks, and open questions.

Pass current-task context only. Include only the brief sections, files, active
review, and active debate needed for this unit. Do not dump unrelated repo
history or stale prior tasks into the prompt.

## 3. Dispatch and risk routing

Use the Task Contract as the prompt. Do not make the implementer infer the spec.

- `claude -p "<prompt>"` for default implementation.
- `codex exec "<prompt>"` for read-only review or debate support.
- `copilot` for plan-debate or alternate perspective.
- If the selected engine exposes `subagent-driven-development`, load it for
  Hermes/subagent work. Otherwise apply this skill's Task Contract directly.

Never mark a unit done from `DONE` text alone. Verify against real file edits
and the stated verify oracle. If dispatch fails, hangs, or returns partial work,
use `references/operations.md`.

### Risk routing

- Low: docs, one-file mechanical edits, localized refactors. One bounded unit.
- Medium: new logic, multi-file behavior change. Bounded unit plus cross-review.
- High: security, auth, migrations, destructive writes, wide blast radius, or
  unclear ownership. Narrow scope, tighten the contract, require explicit
  verify oracles, and escalate unresolved design conflict to `plan-debate`.
- Unknown: treat as high until evidence lowers it.

## 4. Review, trace, and verification

### Cross-review rule

Never let an engine review its own work. Use a different engine for review.
Review happens before merge, not after.

### Trace capture

For every dispatched unit, capture:

- session or run id
- provider and model
- start/end or duration
- API, tool, token, and cache usage if available
- changed files or touched paths
- verify evidence
- review verdict

Collect telemetry from the launcher/session record after exit, not from the worker's
self-report. Compare actual usage with the Task Contract and flag exceeded targets.

Unknown cost is `unknown`, never `0`. Missing telemetry is a reported gap, not
proof that no cost or tooling was involved.

### Merge gate

Before merge, require independent review, all required CI checks, and a mergeable
branch. Ask the user before merging while they are present. After merge, prune the
worktree and update the brief.

### Operations reference

Use `references/operations.md` only when needed:

- brief corruption or recovery
- failed-dispatch salvage
- DCO or commit-format details

### Verification

Confirm the Task Contract must-haves against real files and the stated oracle,
then require independent review and the repository confidence gate before completion.

## 5. The brief is the source of truth

After each unit, update only the brief facts proven by edits, tests, review, or
launcher telemetry. Keep unresolved items explicit; never replace missing evidence
with an agent's summary or an assumed zero-cost result.
