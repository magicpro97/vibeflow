/**
 * Platform semantics for the two POSIX filesystem primitives that do not exist on Windows.
 *
 * Both are trust-boundary adjacent, so they live in one place instead of being re-derived at each
 * call site: a platform rule copy-pasted across call sites is a platform rule the next durable
 * write will get wrong.
 */
import * as fs from "node:fs";
import { RUNTIME_PLATFORM } from "./process-identity-contract.js";

const isWindows = (): boolean => process.platform === RUNTIME_PLATFORM.WINDOWS;

/**
 * fsync a DIRECTORY descriptor to flush its entries.
 *
 * POSIX needs this so a freshly linked name survives a crash. Windows returns EPERM for fsync on a
 * directory handle and has no dirent-flush equivalent, so the call is skipped there.
 *
 * ponytail: no-op on Windows — NTFS exposes no directory-entry flush at all (FlushFileBuffers
 * rejects directory handles), so there is no upgrade path at the descriptor level. A crash in the
 * window between creating a name and writing it can therefore lose the entry on Windows; callers
 * treat a missing entry as absent and recreate it, so this degrades to a retry, not corruption.
 *
 * Only for directory descriptors. fsync on a FILE descriptor works on every platform — keep using
 * fs.fsyncSync directly for those.
 */
export function syncDirectory(fd: number): void {
  if (isWindows()) return;
  fs.fsyncSync(fd);
}

/**
 * Whether a stat carries exactly the expected POSIX permission bits.
 *
 * Windows does not implement POSIX mode bits: a directory created with mode 0o700 reports 0o666, so
 * the compare can never hold and privacy is instead an ACL property of the object. This returns
 * true there, which makes the mode term vacuous rather than falsely failing. The surrounding checks
 * that still apply on Windows — symlink-component rejection, O_NOFOLLOW opens, and the
 * fstat-vs-lstat dev/ino identity match — continue to do the real work.
 *
 * ponytail: vacuous on Windows — upgrade by asserting the object's ACL (a private-authority check)
 * once that layer is reachable from these call sites.
 *
 * Pass the caller's existing mask result and expectation; masks differ per call site (0o777 vs
 * 0o7777) and are deliberately not normalized here.
 */
export function hasPrivateMode(stat: fs.Stats, mask: number, expected: number): boolean {
  if (isWindows()) return true;
  return (stat.mode & mask) === expected;
}

/**
 * Whether a stat is free of group/other write permission.
 *
 * Same Windows caveat as hasPrivateMode: POSIX mode bits do not exist there (every directory
 * reports 0o666), so the check is vacuous on Windows and the object's ACL is what actually
 * restricts writers.
 *
 * ponytail: vacuous on Windows — upgrade by asserting the ACL once that layer is reachable here.
 */
export function isNotGroupOrWorldWritable(stat: fs.Stats): boolean {
  if (isWindows()) return true;
  return (stat.mode & 0o022) === 0;
}
