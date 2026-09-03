---
name: deterministic-async-teardown
description: Close asynchronous tests and runtimes through authoritative completion barriers before restoring globals or deleting fixtures; use when callbacks, timers, streams, continuations, queues, or child processes can outlive the visible result.
scope: project
project.id: magicpro97/vibeflow
status: verified
capabilities:
  - identify asynchronous resource ownership
  - design observable completion barriers
  - preserve primary errors during cleanup
  - test lifecycle quiescence without sleeps
triggers:
  - async teardown race
  - leaked background callback
  - fixture removed before callback
  - timer or listener leak
  - timer and listener leak
  - stream drain barrier
  - stream drain completion barrier
  - stream-drain completion barrier
  - child process teardown
  - process teardown deterministic
  - child output handle release
requires:
  filesystem: write
  network: false
  shell: true
---

# Deterministic Async Teardown

Use this skill when the visible result of a test, request, stream, dispatch, or process can
complete before every resource it owns has become quiescent. The fix is a lifecycle authority,
not a delay that merely makes the race less frequent.

## When to use

- fire-and-forget continuations, retry timers, subscriptions, workers, or buffered writes
- streams whose terminal value can precede drain or callback completion
- child processes whose exit can precede output drain, handle release, or record cleanup
- tests that patch globals or delete fixture roots while background owners can still use them

## When not to use

- a synchronous value with no callbacks, handles, timers, streams, processes, or deferred work
- a performance wait that has no ownership or cleanup semantics
- a fixed sleep proposed as the final repair

## Steps

1. Inventory every owner created by the operation and the resources each owner may still touch.
   Include timers, listeners, streams, queues, file descriptors, subprocesses, globals, and
   fixture paths.
2. Bind each owner to an observable terminal signal: joined task, settled promise, drained queue,
   closed stream, exited process plus drained output, released handle, or persisted terminal
   record. PID existence, elapsed time, and visible output alone are not completion proof.
3. Add the narrowest lifecycle seam when production code has no observable barrier. Keep the seam
   injectable and specific; do not expose mutable internal state just for a test.
4. Stop producers first, then await consumer quiescence. Restore globals and remove fixture roots
   only after all barriers settle, normally inside `finally`.
5. Make close, abort, unsubscribe, and release operations idempotent. Preserve the primary failure
   when cleanup also fails, while retaining cleanup failure as structured evidence where possible.
6. Bound every wait and keep timeout failure typed. A timeout reports missing proof; it never
   converts an unknown owner into a successfully released one.
7. Exercise success, primary failure, cleanup failure, cancellation, repeated cleanup, and the
   ordering case where visible output arrives before the final background callback.

## Verification

Use controlled promises, injected clocks, or explicit lifecycle events rather than sleeps. Run the
focused `bun:test` case repeatedly and assert that no timer, listener, handle, process, write, or
fixture access occurs after teardown. Then run typecheck, lint, affected lifecycle suites, and the
whole-repository `vf verify` confidence gate.
