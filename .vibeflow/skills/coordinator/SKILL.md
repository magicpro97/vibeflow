---
name: coordinator
description: Coordinate non-trivial VibeFlow work through compact contracts, distinct writable CLI executors, coordinator-first clarification, exact-head review, and verified promotion.
when_to_load: Load for vf coord, vf init, multi-agent work, Hermes recovery, or any non-trivial delegated implementation.
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

Use this skill when VibeFlow coordinates work rather than implementing it in
the coordinator process. Keep authority explicit, context compact, and every
promotion tied to immutable evidence.

## 0. Activation

### When to use

- `vf coord` or `vf init` is steering non-trivial implementation.
- A CLI agent is executing work on behalf of a coordinator.
- Hermes or another runner needs bounded delegation, review, and promotion.
- An executor needs clarification before it can finish an accepted contract.
- Existing artifacts must be recovered without replaying completed work.

### When not to use

- A trivial read-only check needs no delegation or writable executor.
- The current agent was explicitly asked to implement directly without a
  handoff.
- The task is only a status question with no dispatch, recovery, or promotion.

## 1. Startup and authority freeze

1. Read the latest user intent, repository instructions, workflow state, and
   live Git evidence before dispatch.
2. Freeze the base SHA, target branch, exact worktree, writable path scope,
   acceptance criteria, forbidden actions, and merge authority.
3. Treat spend limits, epoch state, ingest receipts, review evidence, and
   external CI as authorities. Do not infer them from prose or stale summaries.
4. Label every budget as an externally enforced cap or an internal target.
   Use `unknown` only when no defensible estimate exists.
5. Keep the coordinator read-only by default. A distinct launcher-authenticated
   CLI executor owns implementation writes.
6. If the repository is bare, resolve and use the existing task worktree; do
   not create a replacement merely for convenience.

Record non-obvious authority choices with `vf decision add`. Arm the project
guardrail once with `vf hooks emit --yes` when the workflow requires it.

## 2. Steps and task contract

### Steps

1. Refresh the brief from live evidence.
2. Decompose only along independent ownership boundaries.
3. Dispatch a bounded contract to each executor.
4. Collect artifacts, launcher telemetry, and clarification requests.
5. Send the smallest corrective unit when evidence exposes a defect.
6. Review the exact candidate with a different engine.
7. Run required gates on the reviewed SHA.
8. Promote only the reviewed, verified content address.
9. Observe exact-SHA CI and merge only under frozen authority.

### Task contract

Every dispatch must include:

- the concrete goal and user-visible outcome;
- the exact workspace, base SHA, branch, and owned files;
- must-haves, non-goals, forbidden changes, and first evidence to inspect;
- the verify oracle and platform-specific checks;
- the allowed budget and whether it is a hard cap or planning target;
- how to return artifacts, findings, and unresolved questions;
- a reminder that other workers share the repository and their edits must not
  be reverted.

Do not disguise one large mutable task as parallel work. Overlapping writable
scope requires sequential ownership or a new isolated candidate workspace.

## 3. Dispatch, context, and clarification

Let every executor resume its native CLI session so its own prior messages stay
in the session history. Do not echo that history back into its prompt.

Send a compact structured envelope containing only:

- the current contract and latest relevant user turns;
- new facts produced by the coordinator or other agents;
- exact message identifiers and quotations needed for attribution;
- review findings, changed authority, and decisions since the last dispatch.

Keep source attribution explicit: user, coordinator, peer agent, repository,
or external gate. When content exceeds a CLI input boundary, pass a bounded
prompt file referenced by path and digest instead of truncating silently.

Resolve ambiguity in this order:

1. current contract and latest user intent;
2. fresh peer deltas and review notes;
3. repository evidence and recorded decisions;
4. a reversible safe default within frozen scope;
5. the user only when the remaining choice changes scope, authority, or
   acceptance criteria.

An executor asks the coordinator first. The coordinator researches, consults
peers when useful, updates the contract, and routes the answer back. Asking the
user is the final path, not the default interaction model.

## 4. Recovery, review, and promotion

Pin every unit to an exact task workspace and authority snapshot. Verify and
review detached from a mutable executor workspace whenever possible.

An already-finished epoch, ingest, or promotion is permanently consumed. Never
replay it. Create a new corrective unit referencing the prior receipts and
salvaged artifacts.

Record launcher-owned telemetry that a worker cannot self-attest reliably:

- provider, model, native session, PID, and process-start identity;
- start time, end time, elapsed duration, and terminal status;
- token, tool, cache, spend, API usage, and request counters;
- changed paths, artifact digests, verify evidence, and review verdict;
- orphan detection, cleanup, recovery, and promotion state.

Preserve missing telemetry as `unknown`; never coerce it to zero. Release owned
PIDs and durable process records after proved terminal cleanup on POSIX and
Windows.

When a defect appears, redelegate only the smallest corrective unit. Review the
new exact head with an engine different from the implementation engine. Promote
through the repository's content-addressed path only after review and verify
both bind to that SHA.

Load [references/operations.md](references/operations.md) for corrupted briefs,
durable recovery, PID cleanup, CI observation, and merge handoff details.

## 5. Verification and source of truth

### Verification

- The executor and reviewer use different engines.
- Focused tests cover each changed authority and failure path.
- Whole-repository `vf verify` passes at confidence `1.0` on the current SHA.
- Required platform CI, including same-SHA Windows proof, passes rather than
  being skipped or simulated.
- The promoted artifact digest matches the reviewed SHA.
- Recovery did not replay a consumed epoch or duplicate an ingest.
- PR checks and review threads are green before an authorized merge.

The current brief is a navigation aid, not proof. Files, exact-SHA tests, signed
receipts, launcher telemetry, review evidence, CI, and repository state are the
source of truth. If they disagree with prose, repair the prose from evidence;
never rewrite evidence to match the story.
