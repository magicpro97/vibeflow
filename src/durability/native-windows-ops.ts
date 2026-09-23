import * as fs from "node:fs";
import { durabilityError } from "./errors.js";
import { WIN32_FD_PATHS } from "./native-runtime.js";
import { type PinnedDirectory, assertPinnedDirectory } from "./pinned-directory.js";
import type { WindowsKernelLock, WindowsKernelLockProvider } from "./windows-kernel-lock.js";

/**
 * Windows-only pinning and advisory-lock steps, split out of native.ts so they can be driven
 * on any platform.
 *
 * These paths used to be reachable only by running on Windows, which is why CI (Linux) never
 * executed a line of them and the kernel-lock fd bookkeeping shipped unverified. Every function
 * here takes the pieces it needs as arguments, so a test can supply a fake provider and a stat
 * function and exercise the real control flow anywhere.
 */

/** The subset of fs used for Windows pinning, injectable so tests need no NTFS volume. */
export interface WindowsPinRuntimeV1 {
  fstatBig: (fd: number) => { dev: bigint; ino: bigint; isDirectory: () => boolean };
  assertPinned: (directory: PinnedDirectory) => void;
  registry: Map<number, string>;
}

export const windowsPinRuntime = (): WindowsPinRuntimeV1 => ({
  fstatBig: (fd) => fs.fstatSync(fd, { bigint: true }),
  assertPinned: assertPinnedDirectory,
  registry: WIN32_FD_PATHS,
});

/**
 * Build the pin for a Windows directory fd.
 *
 * B4: NTFS file ids need 57 bits, so the bigint pair is authoritative and the Number-typed
 * dev/ino are carried alongside only for callers that predate it.
 * B2: privacy lives in the ACL rather than mode bits, so there is no 0o700 check here; see #807
 * for the ACL verification that is still missing.
 */
export function pinWindowsDirectory(
  fd: number,
  path: string,
  runtime: WindowsPinRuntimeV1,
): PinnedDirectory {
  const stat = runtime.fstatBig(fd);
  if (!stat.isDirectory()) durabilityError("unsafe_path", `unsafe pinned directory: ${path}`);
  // Register before asserting: the *at() shims resolve relative opens through this registry,
  // and assertPinned is what keeps a recycled fd number from answering for a stale path.
  runtime.registry.set(fd, path);
  const pinned: PinnedDirectory = {
    fd,
    path,
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    devBig: stat.dev,
    inoBig: stat.ino,
  };
  runtime.assertPinned(pinned);
  return pinned;
}

/**
 * Take the Windows advisory lock for `fd`.
 *
 * Returns false when the lock is held elsewhere; the fd→lock entry is recorded only on success
 * so that releaseWindowsAdvisoryLock can fail loudly rather than silently leak a held lock.
 */
export function tryWindowsAdvisoryLock(
  fd: number,
  lockPath: string | undefined,
  provider: WindowsKernelLockProvider,
  locks: Map<number, WindowsKernelLock>,
): boolean {
  if (!lockPath) durabilityError("invalid_value", "Windows advisory lock requires a path");
  const lock = provider.tryAcquire(lockPath);
  if (lock === null) return false;
  locks.set(fd, lock);
  return true;
}

/**
 * Memoize the Windows kernel lock provider.
 *
 * Lazy on purpose: constructing it loads Windows FFI, which must not happen at module init on
 * POSIX. `create` is a parameter so the memoization itself is testable without Windows.
 *
 * No privateAuthority is passed. The Bun FFI defect that used to block it is fixed, but
 * verifyHandle demands a DACL of exactly one owner-only ACE, while a lock file under
 * %USERPROFILE% inherits three (SYSTEM, Administrators, user) and CreateFileW applies security
 * attributes only when it CREATES the file. Measured on an existing lock:
 *   NT AUTHORITY\SYSTEM:(I)(F)  BUILTIN\Administrators:(I)(F)  <user>:(I)(F)
 * so enabling it fails closed with "permissive Windows authority DACL rejected" on every
 * pre-existing install. Turning it on needs a policy that accepts the standard inherited ACEs
 * plus a migration for existing lock files: tracked in #807.
 */
export function memoizedWindowsLockProvider(
  create: () => WindowsKernelLockProvider,
): () => WindowsKernelLockProvider {
  let provider: WindowsKernelLockProvider | undefined;
  return () => {
    if (!provider) provider = create();
    return provider;
  };
}

/** Release the Windows advisory lock for `fd`, refusing an fd that never took one. */
export function releaseWindowsAdvisoryLock(
  fd: number,
  locks: Map<number, WindowsKernelLock>,
): void {
  const lock = locks.get(fd);
  if (!lock) durabilityError("lock_lost", "Windows kernel lock not found for fd");
  // Drop the entry before releasing: if release throws, the fd must not look locked still.
  locks.delete(fd);
  lock.release();
}
