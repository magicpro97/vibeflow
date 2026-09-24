import * as fs from "node:fs";
import { durabilityError } from "./errors.js";
import { WIN32_FD_PATHS } from "./native-runtime.js";
import { type PinnedDirectory, assertPinnedDirectory } from "./pinned-directory.js";
import {
  WINDOWS_AUTHORITY_PATH_KIND,
  type WindowsAclOpsOptions,
  descriptorIdentity,
  windowsEnsurePrivateAcl,
} from "./windows-acl-ops.js";
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
 * B2: privacy is enforced by the ACL (SE_DACL_PROTECTED + owner-only ACE); the leaf is secured by
 * repairWindowsLeafAcl, which the directory walk calls while it holds the leaf open.
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
 * Apply the owner-only ACL to the directory `fd` refers to, through a handle the ACL layer opens at
 * `path` and only if that handle is the object `fd` refers to.
 *
 * This is what makes the leaf-ACL write identity-safe (issue #817). A path-based write would land on
 * whatever holds the name; a write bound only to the ACL layer's own open would land on a leaf that
 * replaced ours without proving it is ours. Here the write is gated on the identity of the object
 * this walk just opened, so the descriptor reaches the object that is about to be pinned or the
 * write does not happen at all — an open that cannot carry the identity (or a leaf that no longer
 * reproduces it) returns false and leaves the substitute's DACL alone.
 *
 * ponytail: identity is read from the fd, not from a Win32 handle — the fd cannot be retargeted, and
 * the pair it reports is the same pair the pin carries, so the ACL layer's reopen has something
 * exact to compare against. Upgrade path: a fused "create + open + ACL" syscall if the extra open
 * ever shows up in a profile.
 */
export function repairWindowsLeafAcl(
  path: string,
  fd: number,
  acl: WindowsAclOpsOptions = {},
): boolean {
  try {
    return windowsEnsurePrivateAcl(path, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, {
      ...acl,
      identity: descriptorIdentity(fd),
    });
  } catch {
    // A descriptor that cannot be identified is not a descriptor this write can be tied to.
    return false;
  }
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
