# Coordinator Operations

Load this file only for rare-path handling.

## Brief corruption

Treat the brief as corrupted when it is empty, truncated, has broken section
markers, contains an impossible consult timestamp, or carries partial temporary
content from an interrupted write.

Recovery:

1. Look for the newest clean backup next to the brief.
2. Restore that backup if it preserves the current task contract.
3. Otherwise regenerate the brief and repopulate it only from real artifacts,
   reviews, logs, and workflow state.
4. If the missing context changes the spec or acceptance gate, escalate to the
   user instead of inventing a replacement summary.

## Clarification ladder

When an executor asks for clarification, route the question back through the
coordinator first.

1. Re-read the current task contract and latest user intent.
2. Pull only the newest peer delta, review finding, or debate result that
   changes the answer.
3. Re-check repo evidence, failing logs, tests, decisions, and active ADRs.
4. If the remaining gap is narrow and reversible, choose the safe default and
   annotate the assumption in the contract.
5. Ask the user only when the open question would change scope, external side
   effects, authority, or the verify oracle.

## Durable resume and non-replay

For an interrupted run, recover before you replay.

1. Reconstruct the exact workspace, HEAD, authority receipt, session record,
   review evidence, and verify outputs that already exist.
2. If an epoch, unit ingest, or promotion already completed, treat it as
   consumed and continue from those artifacts.
3. Resume the native executor session when possible and send only peer-produced
   deltas, not the executor's own history.
4. If the durable state is inconsistent, create a new bounded corrective unit
   that references the prior attempt instead of replaying it silently.

An epoch, ingest, or promotion marked complete is permanently consumed. New
evidence can justify a new corrective unit, but it can never authorize rerunning
the consumed operation itself.

## Budget and launcher telemetry

Classify every task budget before dispatch:

- `enforced`: an external launcher, provider, or user cap will stop execution
- `target`: an internal planning limit that guides decomposition but is not a
  hard launcher control

Estimate when evidence permits it. Use `unknown` only when no defensible
estimate exists. Launcher receipts should preserve provider, model, native
session id, process identity, elapsed duration, tokens, tool calls, cache use,
spend, API usage and request count, changed paths, verification, review, and
orphan state. Missing counters remain `unknown`; they are not evidence of zero
use.

## Exact workspace and promotion

1. Keep the coordinator workspace read-only.
2. Allocate one writable task workspace per executor pinned to a specific source
   commit and authority snapshot.
3. Run the detached verifier and detached reviewer against the exact candidate
   artifact or immutable snapshot, not against a mutable live workspace.
4. Promote only content-addressed outputs that match the reviewed SHA.

## PID and orphan recovery

Persist enough process state to prove ownership and release it safely:
process id, launcher identity, workspace identity, started-at timestamp, and
expected session identity when available.

Recovery:

1. On resume, confirm the recorded process still maps to the expected executor.
2. If the process finished, release the record immediately.
3. If the process is dead or mismatched, mark it orphaned, reclaim the lease,
   and continue from durable artifacts instead of waiting forever.
4. Prefer shell-free launches and cross-platform process grouping so the same
   cleanup logic works on macOS, Linux, and Windows.

## Merge handoff

Hand off to `merge-when-green` with the exact PR number, branch tip SHA, fresh
review evidence path, verify output, and any borrowed auth or stash state that
must be restored at the absolute end.
