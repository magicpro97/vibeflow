/**
 * Shared Windows ACL helpers used by posix-fs-semantics.ts (hasPrivateMode, isNotGroupOrWorldWritable)
 * and windows-fs-shims.ts (fchmodat).
 *
 * Opens by path using the existing CreateFileW binding, then delegates to
 * createWindowsPrivateAuthority() for verify/migrate. Does NOT use _get_osfhandle —
 * that crashes the process on Node/Bun fds (see issue #807 probe comment).
 */
import type { WindowsFfiRuntime } from "./windows-ffi-runtime.js";
import {
  WINDOWS_NATIVE_RECORD,
  type WindowsRecordNativeBindings,
  loadWindowsRecordNativeBindings,
} from "./windows-kernel-lock.js";
import {
  WINDOWS_AUTHORITY_PATH_KIND,
  WINDOWS_PRIVATE_SECURITY,
  type WindowsAuthorityPathKind,
  type WindowsPrivateAuthority,
  createWindowsPrivateAuthority,
  loadWindowsPrivateAuthorityBindings,
} from "./windows-private-authority.js";

// S-1-5-18 (LOCAL SYSTEM) and S-1-5-32-544 (BUILTIN\\Administrators) are root-equivalent: they can
// take ownership of any object and rewrite its DACL, so a write ACE naming them grants nothing a
// principal without those rights could actually rely on. Exempting them is what makes a standard
// inherited DACL "not writable by others", exactly as POSIX mode bits ignore root.
const ROOT_EQUIVALENT_SIDS: readonly Buffer[] = [
  Buffer.from([0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x12, 0x00, 0x00, 0x00]),
  Buffer.from([
    0x01, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x20, 0x00, 0x00, 0x00, 0x20, 0x02, 0x00, 0x00,
  ]),
];

// Any right that lets a principal change the object or its permissions: a foreign ACE holding one
// of these is the Windows equivalent of a group/other write bit.
//
// Built from the individual rights rather than FILE_GENERIC_WRITE, which bundles SYNCHRONIZE and
// STANDARD_RIGHTS_WRITE. Those two are also part of FILE_GENERIC_READ, so the generic mask would
// flag a plain read/execute grant as a write.
const MODIFY_ACCESS_MASK =
  (WINDOWS_NATIVE_RECORD.FILE_WRITE_DATA |
    WINDOWS_NATIVE_RECORD.FILE_APPEND_DATA |
    WINDOWS_NATIVE_RECORD.FILE_WRITE_EA |
    WINDOWS_NATIVE_RECORD.FILE_WRITE_ATTRIBUTES |
    WINDOWS_NATIVE_RECORD.DELETE_ACCESS |
    WINDOWS_NATIVE_RECORD.WRITE_DAC |
    WINDOWS_NATIVE_RECORD.WRITE_OWNER) >>>
  0;

/**
 * Injection seam. Production callers pass nothing and get the real Win32 bindings; a test supplies
 * fakes so every branch runs on any platform, or a `runtime` whose module load fails to stand in
 * for a host with no Win32 security APIs.
 */
export interface WindowsAclOpsOptions {
  binding?: WindowsRecordNativeBindings;
  authority?: WindowsPrivateAuthority;
  runtime?: WindowsFfiRuntime;
}

const isDirectory = (kind: WindowsAuthorityPathKind): boolean =>
  kind === WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY;

function widePath(path: string): Buffer {
  return Buffer.from(`\\\\?\\${path}\0`, "utf16le");
}

// CreateFileW refuses a directory unless FILE_FLAG_BACKUP_SEMANTICS is set, so a directory ACL
// check without it fails open-handle and reads as "not owner-only" for every directory.
function openForAcl(
  binding: WindowsRecordNativeBindings,
  path: string,
  directory: boolean,
): bigint | null {
  const flags =
    (WINDOWS_NATIVE_RECORD.FILE_ATTRIBUTE_NORMAL |
      WINDOWS_NATIVE_RECORD.FILE_FLAG_OPEN_REPARSE_POINT |
      (directory ? WINDOWS_NATIVE_RECORD.FILE_FLAG_BACKUP_SEMANTICS : 0)) >>>
    0;
  const handle = binding.createFile(
    widePath(path),
    WINDOWS_NATIVE_RECORD.READ_CONTROL >>> 0,
    WINDOWS_NATIVE_RECORD.FILE_SHARE_READ | WINDOWS_NATIVE_RECORD.FILE_SHARE_WRITE,
    null,
    WINDOWS_NATIVE_RECORD.OPEN_EXISTING,
    flags,
    null,
  );
  if (handle === binding.invalidHandle) return null;
  return handle;
}

function closeQuietly(binding: WindowsRecordNativeBindings, handle: bigint): void {
  try {
    binding.closeHandle(handle);
  } catch {
    /* A close failure must not mask the result the caller asked for. */
  }
}

function authorityFor(options: WindowsAclOpsOptions): WindowsPrivateAuthority {
  return (
    options.authority ??
    createWindowsPrivateAuthority(loadWindowsPrivateAuthorityBindings(options.runtime))
  );
}

interface WindowsAclContext {
  binding: WindowsRecordNativeBindings;
  authority: WindowsPrivateAuthority;
}

// Loading the Win32 security bindings can fail on a host that has no such APIs. A caller asking a
// yes/no question must get "no" rather than an exception from the machinery behind the question.
function aclContext(options: WindowsAclOpsOptions): WindowsAclContext | null {
  try {
    return {
      binding: options.binding ?? loadWindowsRecordNativeBindings(options.runtime),
      authority: authorityFor(options),
    };
  } catch {
    return null;
  }
}

/**
 * Returns true iff the path has a protected owner-only DACL (SE_DACL_PROTECTED + one owner ACE).
 * Returns false on any error: missing file, access denied, wrong ACL, or a host where the Win32
 * security calls are not usable at all.
 */
export function windowsVerifyPathAcl(
  path: string,
  kind: WindowsAuthorityPathKind,
  options: WindowsAclOpsOptions = {},
): boolean {
  const context = aclContext(options);
  if (context === null) return false;
  let handle: bigint | null = null;
  try {
    handle = openForAcl(context.binding, path, isDirectory(kind));
    if (handle === null) return false;
    context.authority.verifyHandle(handle, kind);
    return true;
  } catch {
    return false;
  } finally {
    if (handle !== null) closeQuietly(context.binding, handle);
  }
}

/**
 * Windows counterpart of the POSIX "free of group/other write" rule.
 *
 * POSIX asks whether the mode grants write to anyone but the owner. The Windows equivalent is
 * whether any allow ACE grants a modifying right to a principal other than the owner. This is
 * deliberately weaker than windowsVerifyPathAcl: a container such as `.vibeflow` legitimately
 * carries a standard inherited DACL, and on POSIX the same directory only has to avoid a
 * group/other write bit — it does not have to be 0700. Returns false on any error, and false for a
 * NULL DACL, which grants every principal full access.
 */
export function windowsHasNoForeignWrite(
  path: string,
  kind: WindowsAuthorityPathKind,
  options: WindowsAclOpsOptions = {},
): boolean {
  const context = aclContext(options);
  if (context === null) return false;
  let handle: bigint | null = null;
  try {
    handle = openForAcl(context.binding, path, isDirectory(kind));
    if (handle === null) return false;
    const descriptor = context.authority.inspect(handle);
    if (!descriptor.daclPresent) return false;
    return !descriptor.aces.some(
      (ace) =>
        ace.type === WINDOWS_PRIVATE_SECURITY.ACCESS_ALLOWED_ACE_TYPE &&
        !ace.sid.equals(descriptor.owner) &&
        !ROOT_EQUIVALENT_SIDS.some((root) => ace.sid.equals(root)) &&
        (ace.mask & MODIFY_ACCESS_MASK) !== 0,
    );
  } catch {
    return false;
  } finally {
    if (handle !== null) closeQuietly(context.binding, handle);
  }
}

/**
 * Reset the DACL on path to owner-only + SE_DACL_PROTECTED.
 *
 * Applies by path rather than by handle: SetSecurityInfo on a handle opened with
 * READ_CONTROL|WRITE_DAC returns 0 and leaves the DACL untouched, while SetNamedSecurityInfoW
 * with the same descriptor replaces it (measured on Windows 11).
 *
 * Unlike the two predicates above this one reports failure by throwing, because the caller asked
 * for a change rather than an answer; fchmodat turns the throw into EACCES.
 */
export function windowsApplyOwnerAcl(
  path: string,
  kind: WindowsAuthorityPathKind,
  options: WindowsAclOpsOptions = {},
): void {
  authorityFor(options).migrateToOwnerOnly(path, kind);
}

export { WINDOWS_AUTHORITY_PATH_KIND };
