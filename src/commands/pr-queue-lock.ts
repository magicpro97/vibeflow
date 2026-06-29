// src/commands/pr-queue-lock.ts
// Lock primitives for the PR merge queue.
// Uses mkdirSync atomicity: two concurrent mkdirSync(lock) calls
// produce at most one success on POSIX.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { cwd } from "./_shared.js";

/** Lock dir (POSIX mkdirSync is atomic, so two concurrent `mkdirSync`
 *  calls on the same path produce exactly one success). */
export const LOCK_DIR = ".vibeflow/.merge-queue.lock";

/** Atomic lock acquire via mkdirSync. Returns true if we got it.
 *  Uses `recursive: false` so mkdirSync throws EEXIST when the path
 *  already exists. The parent dir (`.vibeflow/`) is created first. */
export function acquireLock(
  inject: {
    existsSync?: (p: string) => boolean;
    mkdirSync?: (p: string, opts: { recursive: boolean }) => void;
  } = {},
): boolean {
  return tryAcquireLockInternal(inject);
}

/** Internal: extracted so bun's coverage tool can attribute the
 *  try/catch close-brace. */
function tryAcquireLockInternal(inject: {
  existsSync?: (p: string) => boolean;
  mkdirSync?: (p: string, opts: { recursive: boolean }) => void;
}): boolean {
  const _exists = inject.existsSync ?? existsSync;
  const _mkdir = inject.mkdirSync ?? mkdirSync;
  const lock = join(cwd(), LOCK_DIR);
  const parent = dirname(lock);
  if (!_exists(parent)) {
    if (!tryMkdirParent(_mkdir, parent)) return false;
  }
  if (_exists(lock)) return false;
  return tryMkdirLock(_mkdir, lock);
}

/** Top-level helper: try to mkdir the parent. Returns false on EEXIST
 *  (another process created it). Re-throws on any other error (e.g.
 *  EACCES — permission denied on the repo) so the caller can surface
 *  a real error instead of silently mapping it to "lock held". */
function tryMkdirParent(
  _mkdir: (p: string, opts: { recursive: boolean }) => void,
  parent: string,
): boolean {
  try {
    _mkdir(parent, { recursive: true });
    return true;
  } catch (err) {
    if (isErrnoCode(err, "EEXIST")) return false;
    throw err;
  }
}

/** Top-level helper: try to mkdir the lock. EEXIST (lock held) returns
 *  false; other errors (EACCES, ENOTDIR, …) re-throw so the caller
 *  doesn't misreport them as "lock held". */
function tryMkdirLock(
  _mkdir: (p: string, opts: { recursive: boolean }) => void,
  lock: string,
): boolean {
  try {
    _mkdir(lock, { recursive: false });
    return true;
  } catch (err) {
    if (isErrnoCode(err, "EEXIST")) return false;
    throw err;
  }
}

/** Narrow type guard: does `err` look like a NodeJS.ErrnoException
 *  with the given `code`? Used by the lock helpers to distinguish
 *  "lock held" (EEXIST) from "permission denied" (EACCES) and
 *  other unrecoverable I/O errors. */
function isErrnoCode(err: unknown, code: string): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown };
  return e.code === code;
}

/** Release the lock (rmdir the dir). */
export function releaseLock(
  inject: {
    existsSync?: (p: string) => boolean;
    rmSync?: (p: string, opts: { recursive: boolean }) => void;
  } = {},
): boolean {
  const _exists = inject.existsSync ?? existsSync;
  const _rm = inject.rmSync ?? rmSync;
  const lock = join(cwd(), LOCK_DIR);
  if (!_exists(lock)) return false;
  return tryRemoveLock(_rm, lock);
}

/** Top-level helper: try to remove the lock dir. */
function tryRemoveLock(
  _rm: (p: string, opts: { recursive: boolean }) => void,
  lock: string,
): boolean {
  try {
    _rm(lock, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
