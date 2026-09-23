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
import { RUNTIME_PLATFORM } from "./process-identity-contract.js";
import {
  type WindowsKernelLock,
  type WindowsKernelLockProvider,
  createWindowsKernelLockProvider,
  loadWindowsRecordNativeBindings,
} from "./windows-kernel-lock.js";

export interface PinnedDirectory {
  fd: number;
  path: string;
  dev: number;
  ino: number;
  /** bigint dev/ino for exact identity comparison on Windows (B4: NTFS ino is 57-bit). */
  devBig?: bigint;
  inoBig?: bigint;
}

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
  if (process.platform !== RUNTIME_PLATFORM.WINDOWS) fs.fsyncSync(parentFd);
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
        return cleanupThenThrow(error, [() => fs.closeSync(nextFd)]);
      }
      const previous = fd;
      fd = -1;
      try {
        fs.closeSync(previous);
        // Clean up the path registry entry for the closed fd.
        WIN32_FD_PATHS.delete(previous);
      } catch (error) {
        return cleanupThenThrow(error, [() => fs.closeSync(next.fd)]);
      }
      fd = next.fd;
      cursor = nextPath;
    }
    return assertDirectory(fd, path, true);
  } catch (error) {
    return cleanupThenThrow(error, fd >= 0 ? [() => fs.closeSync(fd)] : []);
  }
}

export function duplicatePinnedDirectory(directory: PinnedDirectory): PinnedDirectory {
  assertPinnedDirectory(directory);
  const fd = native().openat(directory.fd, ".", DIRECTORY_FLAGS, "int", 0);
  if (fd < 0) syscallFailure("openat duplicate pinned directory");
  return withFailureCleanup(
    () => assertDirectory(fd, directory.path, true),
    [() => fs.closeSync(fd)],
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
        return cleanupThenThrow(error, [() => fs.closeSync(nextFd)]);
      }
      current = null;
      try {
        fs.closeSync(previous.fd);
        WIN32_FD_PATHS.delete(previous.fd);
      } catch (error) {
        return cleanupThenThrow(error, [() => fs.closeSync(next.fd)]);
      }
      current = next;
    }
    return current as PinnedDirectory;
  } catch (error) {
    const remaining = current;
    return cleanupThenThrow(error, remaining ? [() => fs.closeSync(remaining.fd)] : []);
  }
}

export interface PinnedDirectoryRuntimeV1 {
  platform: NodeJS.Platform;
  isBun: boolean;
  realpath: typeof fs.realpathSync;
  fcntl: ReturnType<typeof native>["fcntl"];
}

export function pinnedDirectoryPathForRuntime(
  fd: number,
  runtime: PinnedDirectoryRuntimeV1,
): string {
  // B5: no fd→path route on Windows. /proc/self/fd and /dev/fd are ENOENT; fcntl is null;
  // GetFinalPathNameByHandleW needs a HANDLE not a Node fd (uv_get_osfhandle is C-only).
  // Use the WIN32_FD_PATHS registry maintained during directory open. OS enforces identity:
  // ancestor rename → EPERM, delete → ENOENT while fd is held (probed on this machine).
  // ponytail: GetFinalPathNameByHandleW + real HANDLEs is the upgrade path for the
  // one security gap: a rename of the pinned leaf itself is undetectable on win32.
  if (runtime.platform === RUNTIME_PLATFORM.WINDOWS) {
    const stored = WIN32_FD_PATHS.get(fd);
    if (stored !== undefined) return stored;
    // A directory fd opened outside this module (fs.openSync in a caller) was never registered.
    // Windows offers no fd→path resolution at all, so the path cannot be recovered here; the
    // caller must register it when it opens the fd. Callers that only want to CHECK an fd against
    // a known path should use windowsPinnedPathMatches instead of resolving.
    durabilityError("unsupported", "runtime cannot resolve Windows pinned directory path");
  }
  if (runtime.platform === RUNTIME_PLATFORM.LINUX) {
    let observed: string;
    try {
      observed = fs.readlinkSync(`/proc/self/fd/${fd}`);
    } catch (error) {
      return durabilityError(
        "unsupported",
        "runtime cannot resolve pinned directory handles",
        error,
      );
    }
    if (observed.endsWith(" (deleted)"))
      durabilityError("unsafe_path", "pinned directory was removed");
    return observed;
  }
  if (runtime.isBun) {
    try {
      return runtime.realpath(`/dev/fd/${fd}`);
    } catch (error) {
      return durabilityError("unsupported", "Bun cannot resolve pinned directory handles", error);
    }
  }
  const output = Buffer.alloc(1024);
  const { fcntl } = runtime;
  if (!fcntl || fcntl(fd, F_GETPATH, "void *", output) !== 0) syscallFailure("fcntl F_GETPATH");
  const end = output.indexOf(0);
  return output.subarray(0, end < 0 ? output.length : end).toString("utf8");
}

export function pinnedDirectoryPath(fd: number): string {
  return pinnedDirectoryPathForRuntime(fd, {
    platform: process.platform,
    isBun: IS_BUN,
    realpath: fs.realpathSync,
    fcntl: native().fcntl,
  });
}

/**
 * Confirm a directory fd refers to `path`, for callers that opened the fd themselves.
 *
 * POSIX resolves the fd and compares paths. Windows has no fd→path route, so an unregistered fd
 * is instead verified by identity: stat the fd and the path and require the same volume + file id.
 * That is the property the path compare exists to establish, and the fd stays inode-bound while
 * held (a rename of an ancestor is refused by the OS with EPERM).
 *
 * ponytail: identity compare instead of a path compare on win32 — upgrade to
 * GetFinalPathNameByHandleW once real HANDLEs are reachable from JS.
 */
export function pinnedDirectoryPathMatches(fd: number, path: string): boolean {
  if (process.platform === RUNTIME_PLATFORM.WINDOWS && !WIN32_FD_PATHS.has(fd)) {
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      const observed = fs.statSync(path, { bigint: true });
      return opened.dev === observed.dev && opened.ino === observed.ino;
    } catch {
      return false;
    }
  }
  return pinnedDirectoryPath(fd) === path;
}

export function assertPinnedDirectory(directory: PinnedDirectory): void {
  if (process.platform === RUNTIME_PLATFORM.WINDOWS) {
    // B4: NTFS file ids need 57 bits, so a Number-typed ino is rounded. Compare bigints when the
    // pin recorded them. Pins built outside this module carry only the rounded pair; compare those
    // like for like, which is still exact for "is this the same fd as before" — rounding only ever
    // risks conflating two *different* directories, and both sides here come from the same fd.
    // B5: no path re-check — Windows has no fd→path route (see pinnedDirectoryPath). The OS
    // refuses ancestor renames (EPERM) and deletes (ENOENT) while the fd is held.
    if (directory.devBig !== undefined && directory.inoBig !== undefined) {
      const stat = fs.fstatSync(directory.fd, { bigint: true });
      if (stat.dev !== directory.devBig || stat.ino !== directory.inoBig || !stat.isDirectory())
        durabilityError("unsafe_path", "pinned directory identity changed");
      return;
    }
    const stat = fs.fstatSync(directory.fd);
    if (stat.dev !== directory.dev || stat.ino !== directory.ino || !stat.isDirectory())
      durabilityError("unsafe_path", "pinned directory identity changed");
    return;
  }
  const stat = fs.fstatSync(directory.fd);
  if (stat.dev !== directory.dev || stat.ino !== directory.ino || !stat.isDirectory())
    durabilityError("unsafe_path", "pinned directory identity changed");
  if (pinnedDirectoryPath(directory.fd) !== directory.path)
    durabilityError("unsafe_path", "pinned directory path changed during mutation");
}

export function closePinnedDirectory(directory: PinnedDirectory): void {
  WIN32_FD_PATHS.delete(directory.fd);
  fs.closeSync(directory.fd);
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
  if (fd >= 0) return fd;
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
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0"))
    durabilityError("unsafe_path", "unsafe relative native path name");
}
