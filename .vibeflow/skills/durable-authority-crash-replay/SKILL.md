---
name: durable-authority-crash-replay
description: Recover interrupted VibeFlow runs without replaying consumed epochs, while preserving exact workspaces, authority boundaries, borrowed auth state, and native executor sessions.
scope: project
project.id: magicpro97/vibeflow
status: verified
capabilities:
  - resume interrupted executor state
  - preserve consumed work receipts
  - recover borrowed authority after interruption
  - existing native agent session
  - reclaim abandoned launcher ownership
triggers:
  - resume interrupted
  - stopped hermes
  - without repeating completed dispatches
  - owner process died
  - salvage existing executor workspace
requires:
  filesystem: write
  network: false
  shell: true
---

# Durable Authority Crash Replay

Use this skill when a coordinator or executor stopped mid-run and the next step
is to recover durable state instead of starting over.

## When to use

- a Hermes or CLI run stopped after partial progress
- a completed epoch or ingest must not be replayed
- borrowed auth, git state, or task workspaces may be left half-restored
- the executor should resume its own native session instead of being re-briefed
  from scratch

## When not to use

- the task is a fresh implementation with no prior durable state
- only a single failed test needs rerunning and no launcher state is involved
- the problem is purely product ambiguity rather than crash recovery

## Steps

1. Reconstruct the existing durable state before issuing new work: exact
   workspace, branch tip, session receipts, review evidence, verify output,
   borrowed auth markers, and process records.
2. Treat any already-finished epoch, ingest, or promotion as consumed. Salvage
   its outputs and continue from those artifacts instead of replaying it.
3. Reconfirm authority boundaries. The coordinator stays read-only, writable
   edits stay in the executor workspace, and borrowed auth or stash state
   remains tracked until the absolute end of the run.
4. Resume the executor's native session when possible and send only peer
   deltas, review findings, or clarified contract changes that the executor
   would not already know from its own history.
5. If state is inconsistent, open a narrow corrective unit that explains the
   inconsistency and desired repair. Do not silently fork a new full run that
   loses the original receipts.
6. Only after recovery is consistent should you rerun verify, review, or CI on
   the current exact head.

## Verification

- the recovered run references the existing workspace and session artifacts
- consumed epochs or ingests were not replayed
- borrowed auth or stash state is either still tracked or restored cleanly
- the next verify or merge step runs on the recovered exact head, not on a
  guessed reconstruction
