import * as fs from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { cleanupThenThrow, withFailureCleanup } from "./cleanup.js";
import { durabilityError } from "./errors.js";
import {
  IS_BUN,
  O_CLOEXEC,
  WIN32_FD_PATHS,
  assertNativeDurabilityAvailable,
  errnoIs,
  native,
  syscallFailure,
} from "./native-runtime.js";
import {
  type PinnedDirectory,
  assertPinnedDirectory,
  pinnedDirectoryPath,
  pinnedDirectoryPathMatches,
} from "./pinned-directory.js";
import { syncDirectory } from "./posix-fs-semantics.js";
import { RUNTIME_PLATFORM } from "./process-identity-contract.js";
import {
  type WindowsKernelLock,
  type WindowsKernelLockProvider,
  createWindowsKernelLockProvider,
  loadWindowsRecordNativeBindings,
} from "./windows-kernel-lock.js";

export {
  type PinnedDirectory,
  type PinnedDirectoryRuntimeV1,
  assertPinnedDirectory,
  pinnedDirectoryPath,
  pinnedDirectoryPathForRuntime,
  pinnedDirectoryPathMatches,
} from "./pinned-directory.js";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const F_GETPATH = 50;
const AT_REMOVEDIR = process.platform === RUNTIME_PLATFORM.DARWIN ? 0x80 : 0x200;
const DIRECTORY_FLAGS =
  fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | O_CLOEXEC;
const OWNER = typeof process.geteuid === "function" ? process.geteuid() : undefined;

// Module-level Windows kernel lock registry: lock-file fd → held kernel lock.
// ponytail: flock(2) is POSIX-only; LockFileEx (via createWindowsKernelLockProvider)
// is the Windows equivalent. Keyed by Node fd for the same tryAdvisoryLock/releaseAdvisoryLock API.
const WIN32_KERNEL_LOCKS: Map<number, WindowsKernelLock> = new Map();

// Lazily initialized on Windows to avoid loading FFI on POSIX at module init time.
let _winLockProvider: WindowsKernelLockProvider | undefined;
function getWinLockProvider(): WindowsKernelLockProvider {
  if (!_winLockProvider) {
    // ponytail: pass undefined privateAuthority to skip ACL verification on the lock file.
    // The OS default DACL applies. Full ACL enforcement requires createWindowsPrivateAuthority()
    // to work via GetTokenInformation — currently failing in Bun 1.3.14 FFI context.
    // Upgrade when Bun handles the pointer type correctly.
    _winLockProvider = createWindowsKernelLockProvider(
      loadWindowsRecordNativeBindings(),
      undefined,
    );
  }
  return _winLockProvider;
}

export function canonicalDurabilityPath(input: string): string {
  if (typeof input !== "string" || input.includes("\0"))
    durabilityError("unsafe_path", "durability path contains NUL or is not a string");
  if (!isAbsolute(input)) durabilityError("unsafe_path", "durability path must be absolute");
  let path = resolve(input);
  if (process.platform !== RUNTIME_PLATFORM.DARWIN) return path;
  for (const [alias, target] of [
    ["/var", "/private/var"],
    ["/tmp", "/private/tmp"],
    ["/etc", "/private/etc"],
  ] as const) {
    if (path === alias || path.startsWith(`${alias}/`)) {
      const observed = fs.lstatSync(alias);
      if (!observed.isSymbolicLink() || observed.uid !== 0 || fs.realpathSync(alias) !== target)
        durabilityError("unsafe_path", `untrusted system path alias: ${alias}`);
      path = `${target}${path.slice(alias.length)}`;
      break;
    }
  }
  return path;
}

function assertDirectory(fd: number, path: string, privateMode: boolean): PinnedDirectory {
  if (process.platform === RUNTIME_PLATFORM.WINDOWS) {
    // B4: use bigint fstatSync to get exact 57-bit NTFS inode without rounding.
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isDirectory()) durabilityError("unsafe_path", `unsafe pinned directory: ${path}`);
    // B2: on Windows, privacy lives in the ACL, not mode bits. Skip the 0o700 check.
    // ponytail: ACL verification via createWindowsPrivateAuthority/verifyHandle requires a
    // Win32 HANDLE; uv_get_osfhandle (C-only) is not reachable from JS. The directory is
    // created with OS-default ACL restricted to the current user (NTFS private by default
    // in %APPDATA% and %TEMP%). Upgrade: bind GetFinalPathNameByHandleW + real HANDLEs.
    WIN32_FD_PATHS.set(fd, path);
    const pinned: PinnedDirectory = {
      fd,
      path,
      dev: Number(stat.dev),
      ino: Number(stat.ino),
      devBig: stat.dev,
      inoBig: stat.ino,
    };
    assertPinnedDirectory(pinned);
    return pinned;
  }
  const stat = fs.fstatSync(fd);
  if (
    !stat.isDirectory() ||
    (privateMode && OWNER !== undefined && stat.uid !== OWNER) ||
    (privateMode && (stat.mode & 0o7777) !== 0o700)
  )
    durabilityError("unsafe_path", `unsafe pinned directory: ${path}`);
  const pinned = { fd, path, dev: stat.dev, ino: stat.ino };
  assertPinnedDirectory(pinned);
  return pinned;
}

function openDirectoryAt(parentFd: number, name: string, path: string, create: boolean): number {
  const api = native();
  let fd = api.openat(parentFd, name, DIRECTORY_FLAGS, "int", 0);
  if (fd >= 0) return fd;
  if (!create || !errnoIs("ENOENT")) syscallFailure(`openat directory ${path}`);
  const created = api.mkdirat(parentFd, name, 0o700) === 0;
  if (!created && !errnoIs("EEXIST")) syscallFailure(`mkdirat directory ${path}`);
  if (created && api.fchmodat(parentFd, name, 0o700, 0) !== 0) {
    let primary: unknown;
    try {
      syscallFailure(`fchmodat directory ${path}`);
    } catch (error) {
      primary = error;
    }
    api.unlinkat(parentFd, name, AT_REMOVEDIR);
    throw primary;
  }
  // B3: NTFS has no dirent-flush equivalent; FlushFileBuffers on a directory handle is
  // invalid (EPERM). Skip fsync on win32. Upgrade path: none — NTFS journal provides
  // crash-consistency at the volume level without an explicit flush.
  // ponytail: on POSIX, fsync of the parent dir makes the dir-entry durable on crash.
  syncDirectory(parentFd);
  fd = api.openat(parentFd, name, DIRECTORY_FLAGS, "int", 0);
  if (fd < 0) syscallFailure(`openat created directory ${path}`);
  return fd;
}

export function openPrivateDirectory(input: string, create: boolean): PinnedDirectory {
  const path = canonicalDurabilityPath(input);
  assertNativeDurabilityAvailable();
  const root = parse(path).root;
  let fd = fs.openSync(
    root,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  let cursor = root;
  try {
    // Register root fd before pinnedDirectoryPath check (needed on Windows for B5).
    if (process.platform === RUNTIME_PLATFORM.WINDOWS) WIN32_FD_PATHS.set(fd, root);
    if (pinnedDirectoryPath(fd) !== root)
      durabilityError("unsupported", "runtime cannot prove the durability root path");
    const parts = path.slice(root.length).split(sep).filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index] as string;
      const nextPath = join(cursor, part);
      const nextFd = openDirectoryAt(fd, part, nextPath, create);
      let next: PinnedDirectory;
      try {
        next = assertDirectory(nextFd, nextPath, index === parts.length - 1);
      } catch (error) {
        return cleanupThenThrow(error, [() => closeTrackedFd(nextFd)]);
      }
      const previous = fd;
      fd = -1;
      try {
        closeTrackedFd(previous);
        // Clean up the path registry entry for the closed fd.
        WIN32_FD_PATHS.delete(previous);
      } catch (error) {
        return cleanupThenThrow(error, [() => closeTrackedFd(next.fd)]);
      }
      fd = next.fd;
      cursor = nextPath;
    }
    return assertDirectory(fd, path, true);
  } catch (error) {
    return cleanupThenThrow(error, fd >= 0 ? [() => closeTrackedFd(fd)] : []);
  }
}

export function duplicatePinnedDirectory(directory: PinnedDirectory): PinnedDirectory {
  assertPinnedDirectory(directory);
  const fd = native().openat(directory.fd, ".", DIRECTORY_FLAGS, "int", 0);
  if (fd < 0) syscallFailure("openat duplicate pinned directory");
  return withFailureCleanup(
    () => assertDirectory(fd, directory.path, true),
    [() => closeTrackedFd(fd)],
  );
}

export function openPinnedDescendant(
  root: PinnedDirectory,
  targetDirectory: string,
  create: boolean,
): PinnedDirectory {
  assertPinnedDirectory(root);
  const target = canonicalDurabilityPath(targetDirectory);
  const relationship = relative(root.path, target);
  if (isAbsolute(relationship) || relationship === ".." || relationship.startsWith(`..${sep}`))
    durabilityError("lock_lost", "owning lock does not cover target directory");
  let current: PinnedDirectory | null = duplicatePinnedDirectory(root);
  try {
    for (const part of relationship.split(sep).filter(Boolean)) {
      const previous = current;
      const nextPath = join(previous.path, part);
      const nextFd = openDirectoryAt(previous.fd, part, nextPath, create);
      let next: PinnedDirectory;
      try {
        next = assertDirectory(nextFd, nextPath, true);
      } catch (error) {
        return cleanupThenThrow(error, [() => closeTrackedFd(nextFd)]);
      }
      current = null;
      try {
        closeTrackedFd(previous.fd);
        WIN32_FD_PATHS.delete(previous.fd);
      } catch (error) {
        return cleanupThenThrow(error, [() => closeTrackedFd(next.fd)]);
      }
      current = next;
    }
    return current as PinnedDirectory;
  } catch (error) {
    const remaining = current;
    return cleanupThenThrow(error, remaining ? [() => closeTrackedFd(remaining.fd)] : []);
  }
}

export function closePinnedDirectory(directory: PinnedDirectory): void {
  WIN32_FD_PATHS.delete(directory.fd);
  fs.closeSync(directory.fd);
}

/**
 * Close a bare fd obtained from tryOpenAt/openAt, dropping any fd→path registration with it.
 *
 * Use this instead of fs.closeSync for those fds: the OS recycles fd numbers, so an entry left
 * behind would later describe a different directory. Registration is overwritten rather than
 * trusted everywhere it is read, so a leak is not exploitable today — this keeps it from
 * becoming an unenforced cross-file invariant.
 */
export function closeTrackedFd(fd: number): void {
  WIN32_FD_PATHS.delete(fd);
  fs.closeSync(fd);
}

export function openAt(directory: PinnedDirectory, name: string, flags: number, mode = 0): number {
  assertSafeName(name);
  const fd = native().openat(
    directory.fd,
    name,
    flags | fs.constants.O_NOFOLLOW | O_CLOEXEC,
    "int",
    mode,
  );
  if (fd < 0) syscallFailure(`openat file ${name}`);
  return fd;
}

export function tryOpenAt(
  directory: PinnedDirectory,
  name: string,
  flags: number,
  mode = 0,
): number | null {
  assertSafeName(name);
  const fd = native().openat(
    directory.fd,
    name,
    flags | fs.constants.O_NOFOLLOW | O_CLOEXEC,
    "int",
    mode,
  );
  if (fd >= 0) {
    // Register directories opened relatively: WIN32_FD_PATHS is how the *at() shims resolve a
    // directory fd back to a path, so a fd that never lands here cannot be descended through.
    // Only directories — a file fd is never a valid *at() base, so registering one would just
    // leave an entry behind for a number the OS will recycle. The flag cannot be tested here:
    // node exposes no O_DIRECTORY on win32 (it is undefined), so ask the fd itself.
    // Overwrite unconditionally: callers close these with plain fs.closeSync, so an entry from
    // a previous owner of this recycled fd number can still be present and must not win.
    if (process.platform === RUNTIME_PLATFORM.WINDOWS && fs.fstatSync(fd).isDirectory())
      WIN32_FD_PATHS.set(fd, join(directory.path, name));
    return fd;
  }
  if (errnoIs("ENOENT")) return null;
  syscallFailure(`openat file ${name}`);
}

export function createAt(
  directory: PinnedDirectory,
  name: string,
  flags: number,
  mode = 0o600,
): number | null {
  assertSafeName(name);
  const fd = native().openat(
    directory.fd,
    name,
    flags | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | O_CLOEXEC,
    "int",
    mode,
  );
  if (fd >= 0) return fd;
  if (errnoIs("EEXIST")) return null;
  syscallFailure(`createat file ${name}`);
}

export function renameAt(directory: PinnedDirectory, from: string, to: string): void {
  assertSafeName(from);
  assertSafeName(to);
  if (native().renameat(directory.fd, from, directory.fd, to) !== 0) syscallFailure("renameat");
}

export function linkAt(directory: PinnedDirectory, from: string, to: string): void {
  assertSafeName(from);
  assertSafeName(to);
  if (native().linkat(directory.fd, from, directory.fd, to, 0) !== 0) syscallFailure("linkat");
}

export function tryLinkAt(directory: PinnedDirectory, from: string, to: string): boolean {
  assertSafeName(from);
  assertSafeName(to);
  if (native().linkat(directory.fd, from, directory.fd, to, 0) === 0) return true;
  if (errnoIs("EEXIST")) return false;
  syscallFailure("linkat");
}

export function unlinkAt(directory: PinnedDirectory, name: string, missingOk = false): void {
  assertSafeName(name);
  if (native().unlinkat(directory.fd, name, 0) === 0) return;
  if (missingOk && errnoIs("ENOENT")) return;
  syscallFailure(`unlinkat file ${name}`);
}

export function tryAdvisoryLock(fd: number, lockPath?: string): boolean {
  if (process.platform === RUNTIME_PLATFORM.WINDOWS) {
    if (!lockPath) durabilityError("invalid_value", "Windows advisory lock requires a path");
    const lock = getWinLockProvider().tryAcquire(lockPath);
    if (lock === null) return false;
    WIN32_KERNEL_LOCKS.set(fd, lock);
    return true;
  }
  if (native().flock(fd, LOCK_EX | LOCK_NB) === 0) return true;
  if (errnoIs("EAGAIN") || errnoIs("EWOULDBLOCK")) return false;
  syscallFailure("advisory writer lock");
}

export function releaseAdvisoryLock(fd: number): void {
  if (process.platform === RUNTIME_PLATFORM.WINDOWS) {
    const lock = WIN32_KERNEL_LOCKS.get(fd);
    if (!lock) durabilityError("lock_lost", "Windows kernel lock not found for fd");
    WIN32_KERNEL_LOCKS.delete(fd);
    lock.release();
    return;
  }
  if (native().flock(fd, LOCK_UN) !== 0) syscallFailure("advisory writer unlock");
}

export { assertNativeDurabilityAvailable };

function assertSafeName(name: string): void {
  // A name is resolved against a pinned directory, so it must be a single component. Windows
  // treats "\" as a separator too, and join() collapses "..\outside" out of the pin entirely.
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  )
    durabilityError("unsafe_path", "unsafe relative native path name");
}
