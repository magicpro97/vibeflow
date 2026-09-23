import * as fs from "node:fs";
import { join } from "node:path";
import type { NativeBindings } from "./native-runtime.js";
import {
  WINDOWS_AUTHORITY_PATH_KIND,
  type WindowsAclOpsOptions,
  windowsApplyOwnerAcl,
} from "./windows-acl-ops.js";

/**
 * Windows-specific NativeBindings backed by node:fs with a module-level fd→path registry.
 * openat/mkdirat/unlinkat use the full path looked up from the registry;
 * flock is intentionally a no-op here — advisory locking on Windows is done in
 * tryAdvisoryLock/releaseAdvisoryLock via the Windows kernel lock provider.
 *
 * ponytail: dir fsync (B3) and path reverification (B5) are skipped on win32.
 * FlushFileBuffers on a directory handle is invalid on NTFS; GetFinalPathNameByHandleW
 * requires a HANDLE not a Node fd (uv_get_osfhandle is C-only). OS enforces identity
 * via fd pinning (probe: ancestor rename → EPERM, delete → ENOENT while fd held).
 */
// Module-level fd→path registry for Windows. Not needed on POSIX.
export const WIN32_FD_PATHS: Map<number, string> = new Map();

/** Map a node:fs error to the POSIX errno the *at() callers branch on. */
const win32Errno = (error: unknown): number => {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return 2;
  if (code === "EACCES" || code === "EPERM") return 13;
  if (code === "EEXIST") return 17;
  if (code === "ENOTDIR") return 20;
  if (code === "EISDIR") return 21;
  if (code === "ENOTEMPTY") return 41;
  return 0;
};

// Windows errno emulation: the node:fs bindings don't set POSIX errno.
// Track the last "errno" from Windows node:fs calls to satisfy errnoIs() checks.
let win32LastErrno = 0;
export function win32SetErrno(errno: number): void {
  win32LastErrno = errno;
}

/** Last errno recorded by the Windows shims, for errnoIs() in the runtime module. */
export function win32LastErrnoValue(): number {
  return win32LastErrno;
}

/**
 * @param acl Injection seam for the Win32 ACL machinery behind fchmodat. Production callers omit
 *   it; a test supplies fakes so both the applied and the rejected branch run on any platform.
 */
export function loadWindowsBindings(acl: WindowsAclOpsOptions = {}): NativeBindings {
  // ponytail: no-op flock — advisory locking is handled via WindowsKernelLockProvider
  // in tryAdvisoryLock/releaseAdvisoryLock in native.ts.
  return {
    openat(directoryFd, name, flags, _modeType, mode) {
      const base = WIN32_FD_PATHS.get(directoryFd);
      if (base === undefined) {
        win32SetErrno(2 /* ENOENT */);
        return -1;
      }
      const target = join(base, name);
      try {
        // O_DIRECTORY, O_NOFOLLOW, O_CLOEXEC are undefined on Windows (→ 0 in DIRECTORY_FLAGS).
        // Pass flags through; node:fs on Windows understands O_RDONLY, O_RDWR, O_CREAT, O_EXCL.
        const nodeFlags = flags || fs.constants.O_RDONLY;
        const fd = mode ? fs.openSync(target, nodeFlags, mode) : fs.openSync(target, nodeFlags);
        win32SetErrno(0);
        return fd;
      } catch (error) {
        win32SetErrno(win32Errno(error));
        return -1;
      }
    },
    mkdirat(directoryFd, name, _mode) {
      const base = WIN32_FD_PATHS.get(directoryFd);
      if (base === undefined) {
        win32SetErrno(2);
        return -1;
      }
      try {
        fs.mkdirSync(join(base, name));
        win32SetErrno(0);
        return 0;
      } catch (error) {
        win32SetErrno(win32Errno(error));
        return -1;
      }
    },
    fchmodat(directoryFd, name, _mode, _flags) {
      const base = WIN32_FD_PATHS.get(directoryFd);
      if (base === undefined) {
        // Every other *at shim reports the unknown fd through node:fs. This one has no node:fs
        // call to do it, and reporting success would claim an ACL that was never applied: the
        // native.ts caller unlinks the directory it cannot secure.
        win32SetErrno(2 /* ENOENT */);
        return -1;
      }
      const target = join(base, name);
      try {
        windowsApplyOwnerAcl(target, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, acl);
        win32SetErrno(0);
        return 0;
      } catch {
        win32SetErrno(13 /* EACCES */);
        return -1;
      }
    },
    renameat(fromFd, from, toFd, to) {
      const fromBase = WIN32_FD_PATHS.get(fromFd);
      const toBase = WIN32_FD_PATHS.get(toFd);
      if (fromBase === undefined || toBase === undefined) {
        win32SetErrno(2 /* ENOENT */);
        return -1;
      }
      try {
        // POSIX renameat replaces the destination atomically; fs.renameSync does the same on
        // Windows (MoveFileEx with MOVEFILE_REPLACE_EXISTING underneath).
        fs.renameSync(join(fromBase, from), join(toBase, to));
        win32SetErrno(0);
        return 0;
      } catch (error) {
        win32SetErrno(win32Errno(error));
        return -1;
      }
    },
    linkat(fromFd, from, toFd, to, _flags) {
      const fromBase = WIN32_FD_PATHS.get(fromFd);
      const toBase = WIN32_FD_PATHS.get(toFd);
      if (fromBase === undefined || toBase === undefined) {
        win32SetErrno(2);
        return -1;
      }
      try {
        // NTFS supports hard links; linkSync fails with EEXIST when the destination is taken,
        // which is the O_EXCL-style contract the CAS callers rely on.
        fs.linkSync(join(fromBase, from), join(toBase, to));
        win32SetErrno(0);
        return 0;
      } catch (error) {
        win32SetErrno(win32Errno(error));
        return -1;
      }
    },
    unlinkat(directoryFd, name, _flags) {
      const base = WIN32_FD_PATHS.get(directoryFd);
      if (base === undefined) {
        win32SetErrno(2);
        return -1;
      }
      try {
        fs.rmSync(join(base, name), { recursive: false });
        win32SetErrno(0);
        return 0;
      } catch (error) {
        win32SetErrno(win32Errno(error));
        return -1;
      }
    },
    flock(_fd, _op) {
      // Handled via WindowsKernelLockProvider in tryAdvisoryLock/releaseAdvisoryLock.
      win32SetErrno(0);
      return -1;
    },
    fcntl: null,
  };
}
