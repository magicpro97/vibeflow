---
name: windows-path-authority-leases
description: Pin a fixed-drive Windows directory and every ancestor with non-delete-sharing handles while path-based reads, writes, renames, cleanup, locks, or evidence publication execute; use when check-use-check identity validation still permits an ancestor swap.
scope: project
project.id: magicpro97/vibeflow
status: draft
capabilities:
  - close Windows ancestor swap races
  - design synchronous native path leases
  - preserve cleanup error precedence
  - test real Windows rename exclusion
triggers:
  - Windows ancestor swap
  - Windows path authority lease
  - check use check race
  - FILE_SHARE_DELETE authority
  - Windows reparse-safe storage
  - Windows rename exclusion
requires:
  filesystem: write
  network: false
  shell: true
---

# Windows Path Authority Leases

Use this skill when a security- or durability-sensitive Windows operation names
a child by absolute path. Checking the directory identity before and after the
operation is not sufficient: another process can replace an ancestor, route the
operation through a different tree, then restore the original path.

## When to use

- record, lock, CAS, evidence, or cleanup code performs child I/O by Windows path
- a directory identity is checked before and after an operation but no handle is
  retained across the path lookup
- rename, publication, enumeration, or failure cleanup must stay within one
  previously authenticated directory tree

## When not to use

- POSIX code already uses descriptor-relative operations such as `openat`
- the operation is read-only metadata inspection with no authority claim
- an off-Windows test seam is being mistaken for native rename exclusion

## Steps

1. Resolve and validate one drive-qualified path on a fixed local volume with
   persistent ACLs. Reject UNC, relative, reparse, delete-pending, and wrong-type
   paths before granting authority.
2. Build every prefix from the drive root through the final directory. Open each
   prefix with `FILE_READ_ATTRIBUTES`, `FILE_FLAG_BACKUP_SEMANTICS`, and
   `FILE_FLAG_OPEN_REPARSE_POINT`. Add `READ_CONTROL` only where the private DACL
   is inspected.
3. Share read and write but omit `FILE_SHARE_DELETE` on every directory handle.
   Retain all handles for the entire synchronous callback; a pre/post identity
   digest without retained handles is still vulnerable to an ABA ancestor swap.
4. Before the callback, validate type, non-reparse state, non-delete-pending
   state, the full `FILE_ID_INFO` bytes, and the final token-user-only protected
   DACL. Compare the final identity with the caller's exact expected value.
5. Keep every path-based effect inside the lease, including enumeration, kernel
   lock acquisition, recovery, publication, rename, unlink, CAS, readback, and
   failure cleanup. Nested leases are acceptable when their share modes agree.
6. After the callback, re-query every retained handle and revalidate the final
   DACL before closing deepest-first. Keep the callback or durability failure
   primary and attach close failures as cause evidence.
7. If the callback can return an acquired resource and post-validation or close
   may fail, capture that resource outside the callback and release it before
   rethrowing the lease failure.
8. Off Windows, expose the same synchronous seam with before/after identity and
   privacy checks for deterministic unit tests, but never describe that seam as
   native rename pinning.

## Evidence

- `bun test test/windows-path-authority.test.ts`: 15 pass, 0 fail
- `bun test test/owned-process-record-windows.test.ts`: 28 pass, 0 fail
- `bun test test/windows-attempt-evidence.test.ts`: 5 pass, 0 fail
- the live Windows suite attempts to rename both the final directory and an
  ancestor during the lease, then proves both renames succeed after release

## Verification

Unit-test prefix handle lifetime, exact share masks, full identity mismatch,
post-callback mutation, and cleanup error precedence. Add lease-depth seams that
assert every filesystem/native effect occurs at depth greater than zero. Run a
real Windows test for final-directory and ancestor rename exclusion, then run
typecheck, lint, file-size, coverage, and whole-repository `vf verify`.

> DRAFT — captured from a real task. Review and refine before relying on it.
