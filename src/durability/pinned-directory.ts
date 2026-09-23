import * as fs from "node:fs";
import { durabilityError } from "./errors.js";
import { IS_BUN, WIN32_FD_PATHS, native, syscallFailure } from "./native-runtime.js";
import { RUNTIME_PLATFORM } from "./process-identity-contract.js";

/** A directory fd held open together with the identity it was opened as. */
export interface PinnedDirectory {
  fd: number;
  path: string;
  dev: number;
  ino: number;
  /** bigint dev/ino for exact identity comparison on Windows (B4: NTFS ino is 57-bit). */
  devBig?: bigint;
  inoBig?: bigint;
}

const F_GETPATH = 50;

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
    // a known path should use pinnedDirectoryPathMatches instead of resolving.
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
  if (process.platform === RUNTIME_PLATFORM.WINDOWS) {
    // Verify by identity, never by a cached entry: fd numbers are recycled, so a stale
    // registry hit from a closed fd would otherwise answer for a different directory.
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      const observed = fs.statSync(path, { bigint: true });
      if (opened.dev !== observed.dev || opened.ino !== observed.ino || !opened.isDirectory())
        return false;
    } catch {
      return false;
    }
    // Adopt the fd: the *at() shims resolve every relative open through this registry, so a
    // directory fd that never lands here cannot be descended through.
    WIN32_FD_PATHS.set(fd, path);
    return true;
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
    } else {
      const stat = fs.fstatSync(directory.fd);
      if (stat.dev !== directory.dev || stat.ino !== directory.ino || !stat.isDirectory())
        durabilityError("unsafe_path", "pinned directory identity changed");
    }
    // Every pin passes through here, including ones whose fd a caller opened itself, so this is
    // the one place that can keep the *at() shims' fd→path registry complete. Overwrite rather
    // than fill: fd numbers are recycled and callers close with plain fs.closeSync, so a stale
    // entry from a previous owner of this number must not survive.
    WIN32_FD_PATHS.set(directory.fd, directory.path);
    return;
  }
  const stat = fs.fstatSync(directory.fd);
  if (stat.dev !== directory.dev || stat.ino !== directory.ino || !stat.isDirectory())
    durabilityError("unsafe_path", "pinned directory identity changed");
  if (pinnedDirectoryPath(directory.fd) !== directory.path)
    durabilityError("unsafe_path", "pinned directory path changed during mutation");
}
