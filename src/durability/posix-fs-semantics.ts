/**
 * Platform semantics for the two POSIX filesystem primitives that do not exist on Windows.
 *
 * Both are trust-boundary adjacent, so they live in one place instead of being re-derived at each
 * call site: a platform rule copy-pasted across call sites is a platform rule the next durable
 * write will get wrong.
 */
import * as fs from "node:fs";
import { RUNTIME_PLATFORM } from "./process-identity-contract.js";
import {
  WINDOWS_AUTHORITY_PATH_KIND,
  descriptorIdentity,
  windowsEnsureNoForeignWrite,
  windowsEnsurePrivateAcl,
} from "./windows-acl-ops.js";
import type { WindowsAuthorityPathKind } from "./windows-private-authority.js";

const isWindows = (): boolean => process.platform === RUNTIME_PLATFORM.WINDOWS;

// The ACL policy differs between the two kinds (a directory descriptor carries inheritance ACEs a
// file never has), so derive it from the stat the caller already took instead of guessing.
const pathKindOf = (stat: fs.Stats): WindowsAuthorityPathKind =>
  stat.isDirectory() ? WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY : WINDOWS_AUTHORITY_PATH_KIND.FILE;

// The caller's own measurement is the identity witness for the verdicts below: the ACL machinery has
// to reopen the path (a verdict has no handle of its own), and node:fs reports the same dev/ino pair
// for the object a descriptor is bound to, so a leaf swapped in behind it fails the comparison. The
// pair is read as bigint — NTFS ids need 57 bits and a Number-typed `ino` is rounded above 2^53,
// which would let two distinct objects share one identity (issue #817).

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
 * `descriptor` is the descriptor the stat came from. The DACL check reopens the path, so the answer
 * is bound to the object that descriptor is bound to; omitting it would let a leaf swapped in after
 * the caller's stat answer in its name.
 *
 * Pass the caller's existing mask result and expectation; masks differ per call site (0o777 vs
 * 0o7777) and are deliberately not normalized here.
 */
export function hasPrivateMode(
  stat: fs.Stats,
  mask: number,
  expected: number,
  path: string,
  descriptor: number,
): boolean {
  if (!isWindows()) return (stat.mode & mask) === expected;
  return windowsEnsurePrivateAcl(path, pathKindOf(stat), {
    identity: descriptorIdentity(descriptor),
  });
}

/**
 * Whether a stat is free of group/other write permission.
 *
 * On Windows this asks the DACL the same question the POSIX branch asks the mode: does anyone but
 * the owner hold a write right? It is deliberately not the owner-only policy hasPrivateMode
 * applies — a container directory such as `.vibeflow` only has to avoid a foreign write bit, and
 * the standard inherited DACL it arrives with is exactly POSIX 0755, so it is accepted as it stands
 * rather than rewritten.
 *
 * `descriptor` carries the same binding as it does for hasPrivateMode.
 */
export function isNotGroupOrWorldWritable(
  stat: fs.Stats,
  path: string,
  descriptor: number,
): boolean {
  if (!isWindows()) return (stat.mode & 0o022) === 0;
  return windowsEnsureNoForeignWrite(path, pathKindOf(stat), {
    identity: descriptorIdentity(descriptor),
  });
}
