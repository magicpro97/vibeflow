/**
 * Shared Windows ACL helpers used by posix-fs-semantics.ts (hasPrivateMode, isNotGroupOrWorldWritable)
 * and windows-fs-shims.ts (fchmodat).
 *
 * Opens by path using the existing CreateFileW binding, then delegates to
 * createWindowsPrivateAuthority() for verify/migrate. Does NOT use _get_osfhandle —
 * that crashes the process on Node/Bun fds (see issue #807 probe comment).
 */
import { WINDOWS_NATIVE_RECORD, loadWindowsRecordNativeBindings } from "./windows-kernel-lock.js";
import {
  WINDOWS_AUTHORITY_PATH_KIND,
  type WindowsAuthorityPathKind,
  createWindowsPrivateAuthority,
} from "./windows-private-authority.js";

function widePath(path: string): Buffer {
  return Buffer.from(`\\\\?\\${path}\0`, "utf16le");
}

// CreateFileW refuses a directory unless FILE_FLAG_BACKUP_SEMANTICS is set, so a directory ACL
// check without it fails open-handle and reads as "not owner-only" for every directory.
function openForAcl(path: string, write: boolean, directory: boolean): bigint | null {
  const binding = loadWindowsRecordNativeBindings();
  const access = write
    ? (WINDOWS_NATIVE_RECORD.READ_CONTROL | WINDOWS_NATIVE_RECORD.WRITE_DAC) >>> 0
    : WINDOWS_NATIVE_RECORD.READ_CONTROL >>> 0;
  const flags =
    (WINDOWS_NATIVE_RECORD.FILE_ATTRIBUTE_NORMAL |
      WINDOWS_NATIVE_RECORD.FILE_FLAG_OPEN_REPARSE_POINT |
      (directory ? WINDOWS_NATIVE_RECORD.FILE_FLAG_BACKUP_SEMANTICS : 0)) >>>
    0;
  const handle = binding.createFile(
    widePath(path),
    access,
    WINDOWS_NATIVE_RECORD.FILE_SHARE_READ | WINDOWS_NATIVE_RECORD.FILE_SHARE_WRITE,
    null,
    WINDOWS_NATIVE_RECORD.OPEN_EXISTING,
    flags,
    null,
  );
  if (handle === binding.invalidHandle) return null;
  return handle;
}

/**
 * Returns true iff the path has a protected owner-only DACL (SE_DACL_PROTECTED + one owner ACE).
 * Returns false on any error (missing file, access denied, wrong ACL).
 */
export function windowsVerifyPathAcl(path: string, kind: WindowsAuthorityPathKind): boolean {
  const binding = loadWindowsRecordNativeBindings();
  const handle = openForAcl(path, false, kind === WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY);
  if (handle === null) return false;
  try {
    createWindowsPrivateAuthority().verifyHandle(handle, kind);
    return true;
  } catch {
    return false;
  } finally {
    try {
      binding.closeHandle(handle);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Reset the DACL on path to owner-only + SE_DACL_PROTECTED.
 *
 * Applies by path rather than by handle: SetSecurityInfo on a handle opened with
 * READ_CONTROL|WRITE_DAC returns 0 and leaves the DACL untouched, while SetNamedSecurityInfoW
 * with the same descriptor replaces it (measured on Windows 11).
 */
export function windowsApplyOwnerAcl(path: string, kind: WindowsAuthorityPathKind): void {
  createWindowsPrivateAuthority().migrateToOwnerOnly(path, kind);
}

export { WINDOWS_AUTHORITY_PATH_KIND };
