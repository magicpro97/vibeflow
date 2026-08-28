---
name: coordinator
description: Coordinate non-trivial VibeFlow work through a read-only coordinator, distinct writable CLI executors, coordinator-first clarification, exact-head review, and verified promotion.
scope: project
project.id: magicpro97/vibeflow
status: verified
capabilities:
  - lead agent delegate implementation
  - route executor clarification
  - peer-only context handoff
  - detached candidate verification
  - content-addressed promotion
triggers:
  - delegates implementation to codex
  - implementing cli
  - send codex the implementation
  - executor asks coordinator
  - autopilot agent delegation
  - recover delegated workflow
requires:
  filesystem: write
  network: true
  shell: true
---

# Coordinator

Use this skill when VibeFlow is coordinating work rather than coding directly.
The coordinator keeps the brief current, dispatches bounded work, verifies real
artifacts, and only asks the user after cheaper clarification paths are
exhausted.

## When to use

- `vf coord` or `vf init` is steering non-trivial implementation
- a CLI agent is executing work on behalf of a coordinator
- Hermes or another runner needs bounded delegation, review, and promotion
- a task needs coordinator-managed clarification before touching the user

## When not to use

- a trivial local check or one-file direct edit does not need delegation
- the current agent was explicitly asked to implement directly with no handoff
- the task is only a read-only status question with no dispatch or salvage work

## Steps

1. Refresh the current brief, then write a compact task contract with goal,
   scope, forbidden changes, first files or logs to inspect, must-haves,
   non-goals, verify oracle, and budget. Label every budget as an externally
   enforced cap or an internal target; use `unknown` only when no defensible
   estimate exists, never as a substitute for estimating.
2. Keep the coordinator read-only by default. Dispatch implementation to a
   distinct writable CLI executor authenticated by the launcher, and pass only
   the current contract, the latest relevant user turns, and peer-produced
   deltas.
3. Let each executor reuse its native session for its own history. When
   resuming, send concise peer-only deltas rather than replaying the executor's
   own prior conversation back into its prompt.
4. Resolve ambiguity in this order: current contract and latest user intent,
   fresh peer deltas and review notes, repo evidence and recorded decisions,
   reversible safe default, then the user only if the remaining ambiguity would
   change scope, authority, or acceptance criteria.
5. Pin each bounded unit to an exact task workspace and authority snapshot. Run
   verifier and reviewer detached from the mutable executor workspace, and
   promote changes only through content-addressed promotion after exact-head
   review and verification succeed.
6. When a defect or question appears, redelegate only the smallest corrective
   unit. An already-finished epoch, ingest, or promotion is permanently
   consumed and must never be rerun. Create a new corrective unit or epoch that
   references the prior receipts and salvaged artifacts instead.
7. Record launcher telemetry that the worker cannot self-attest reliably:
   provider and model, session and process identity, elapsed duration,
   token/tool/cache/spend counters, API usage and request count, changed paths,
   verify evidence, review verdict, and orphan or recovery state. Preserve
   `unknown` as unknown; never coerce missing telemetry to zero.

Load [references/operations.md](references/operations.md) for brief corruption,
durable recovery, PID cleanup, or merge handoff details.

## Verification

- the executor and reviewer use different engines
- the current SHA has fresh review and verify evidence
- the promoted artifact matches the reviewed SHA
- recovery did not replay a consumed epoch or duplicate an ingest
- the brief or workflow state reflects only facts proven by files, tests,
  reviews, or launcher telemetry
