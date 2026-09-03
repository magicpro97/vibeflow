---
name: runtime-portable-process-fixtures
description: Build or repair VibeFlow runtime tests that model real process lifecycles, persisted PID ownership, and cross-platform path semantics without relying on shell-specific behavior.
scope: project
project.id: magicpro97/vibeflow
status: verified
capabilities:
  - persist launcher process ownership
  - release completed cli pid
  - reclaim stale process record safely
  - portable launcher lifecycle tests
  - cross-platform process identity
  - foreign process survives
triggers:
  - child stays alive
  - pid was reused
  - pid record remains
  - launcher cleanup tests
  - shell-independent process fixture
  - orphaned executor never exits
requires:
  filesystem: write
  network: false
  shell: true
---

# Runtime Portable Process Fixtures

Use this skill for runtime or launcher changes where the risk is process
ownership, cleanup, or platform-specific path behavior rather than product UI.

## When to use

- a CLI process is left running or not released after completion
- runtime tests need to cover PID persistence, orphan cleanup, or launcher
  ownership
- path authority or namespace handling differs across POSIX and Windows
- raw spawn behavior needs a portable fixture or wrapper

## When not to use

- the task is purely UI, copy, or docs work
- the failure is a product-level business rule unrelated to process lifecycle
- a one-off local script can stay shell-specific because it is not part of the
  shipped runtime

## Steps

1. Model the real launcher boundary first: how a process is started, what
   identity is persisted, what proves ownership, and what signal marks release.
2. Prefer one tracked spawn abstraction over ad hoc raw `Bun.spawn` calls so
   PID capture, completion, failure, and cleanup semantics stay consistent.
3. Persist the minimum durable fixture state needed for recovery: process id,
   launcher identity, workspace or task identity, and expected session or
   authority metadata.
4. Encode platform semantics explicitly in tests. POSIX backslashes remain file
   name characters, while Windows may normalize separators, drive letters, UNC
   shares, and extended namespaces differently.
5. Assert cleanup on success, failure, cancellation, and orphan recovery. The
   same fixture should prove that stale records are reclaimed without killing an
   unrelated live process.
6. Prefer structured outputs and shell-free launches where possible so tests do
   not depend on quoting or terminal quirks.

## Verification

- runtime tests cover release, orphan recovery, and authority mismatches
- path tests distinguish POSIX, Windows drive, UNC, and namespace cases
- the tracked spawn path captures PID ownership and cleanup consistently
- no new shell-specific shortcut bypasses the runtime fixture contract
