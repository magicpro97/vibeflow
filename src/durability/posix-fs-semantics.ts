/**
 * Platform semantics for the two POSIX filesystem primitives that do not exist on Windows.
 *
 * Both are trust-boundary adjacent, so they live in one place instead of being re-derived at each
 * call site: a platform rule copy-pasted across call sites is a platform rule the next durable
 * write will get wrong.
 */
import * as fs from "node:fs";
import { RUNTIME_PLATFORM } from "./process-identity-contract.js";
import { WINDOWS_AUTHORITY_PATH_KIND, windowsVerifyPathAcl } from "./windows-acl-ops.js";
import type { WindowsAuthorityPathKind } from "./windows-private-authority.js";

const isWindows = (): boolean => process.platform === RUNTIME_PLATFORM.WINDOWS;

// The ACL policy differs between the two kinds (a directory descriptor carries inheritance ACEs a
// file never has), so derive it from the stat the caller already took instead of guessing.
const pathKindOf = (stat: fs.Stats): WindowsAuthorityPathKind =>
  stat.isDirectory() ? WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY : WINDOWS_AUTHORITY_PATH_KIND.FILE;

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
 * On Windows, POSIX mode bits do not apply, so privacy is enforced by verifying the path's DACL
 * against the owner-only policy instead. The path is required rather than optional: an optional
 * one makes every caller that omits it silently return true, which is a trust-boundary check that
 * passes without checking anything.
 *
 * Pass the caller's existing mask result and expectation; masks differ per call site (0o777 vs
 * 0o7777) and are deliberately not normalized here.
 */
export function hasPrivateMode(
  stat: fs.Stats,
  mask: number,
  expected: number,
  path: string,
): boolean {
  if (!isWindows()) return (stat.mode & mask) === expected;
  return windowsVerifyPathAcl(path, pathKindOf(stat));
}

/**
 * Whether a stat is free of group/other write permission.
 *
 * On Windows this verifies the path's DACL, for the same reason as hasPrivateMode.
 */
export function isNotGroupOrWorldWritable(stat: fs.Stats, path: string): boolean {
  if (!isWindows()) return (stat.mode & 0o022) === 0;
  return windowsVerifyPathAcl(path, pathKindOf(stat));
}
