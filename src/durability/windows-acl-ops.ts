/**
 * Shared Windows ACL helpers used by posix-fs-semantics.ts (hasPrivateMode, isNotGroupOrWorldWritable)
 * and windows-fs-shims.ts (fchmodat).
 *
 * Opens by path using the existing CreateFileW binding, then delegates to
 * createWindowsPrivateAuthority() for verify/migrate. Does NOT use _get_osfhandle —
 * that crashes the process on Node/Bun fds (see issue #807 probe comment).
 *
 * The open is by path, so a verdict describes whatever sits at the path when it happens. Callers
 * that already stat'ed the object hand in its identity, and the reopened handle has to prove it is
 * that same object before its DACL speaks for it or is rewritten (issue #811).
 */
import { durabilityError } from "./errors.js";
import type { WindowsFfiRuntime } from "./windows-ffi-runtime.js";
import {
  WINDOWS_NATIVE_RECORD,
  type WindowsRecordNativeBindings,
  loadWindowsRecordNativeBindings,
} from "./windows-kernel-lock.js";
import { WINDOWS_FILE_NATIVE } from "./windows-native-contract.js";
import {
  WINDOWS_AUTHORITY_PATH_KIND,
  type WindowsAuthorityPathKind,
  type WindowsPrivateAuthority,
  createWindowsPrivateAuthority,
  descriptorAllowsForeignWrite,
  loadWindowsPrivateAuthorityBindings,
} from "./windows-private-authority.js";

/**
 * The identity of a file object as node:fs reports it: `dev` is the volume serial number and `ino`
 * the file id — the same pair PinnedDirectory carries for a pinned directory fd.
 */
export interface WindowsFileIdentity {
  dev: number;
  ino: number;
}

/**
 * Injection seam. Production callers pass nothing and get the real Win32 bindings; a test supplies
 * fakes so every branch runs on any platform, or a `runtime` whose module load fails to stand in
 * for a host with no Win32 security APIs.
 */
export interface WindowsAclOpsOptions {
  binding?: WindowsRecordNativeBindings;
  authority?: WindowsPrivateAuthority;
  runtime?: WindowsFfiRuntime;
  /**
   * The identity of the object the caller stat'ed.
   *
   * Windows has no handle-based DACL setter and `_get_osfhandle` aborts the runtime, so both the
   * verdict and the migration go through a *reopened* path. This is what binds them to the object
   * the caller will actually read: a handle opened at `path` counts as that object only if it
   * reproduces this pair, so a leaf swapped in after the caller's stat can neither answer for it nor
   * have its DACL rewritten.
   *
   * Omitted by the fchmodat shim, which re-ACLs a directory leaf under a path its own caller pinned
   * by fd and has no stat of its own.
   */
  identity?: WindowsFileIdentity;
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
  identity: WindowsFileIdentity | undefined,
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
  if (identity === undefined || identityMatches(binding, handle, identity)) return handle;
  // The path does not hold the object the caller stat'ed. Hand back no handle at all: a substitute
  // must not get a verdict attached to it, and must not be repaired in the caller's name either.
  closeQuietly(binding, handle);
  return null;
}

/**
 * Whether a handle is the object the caller stat'ed.
 *
 * node:fs fills dev/ino from the same handle information FileIdInfo returns — the volume serial
 * number and the file id, measured on Windows 11 (see windows-acl-identity.test.ts) — so an object
 * that reproduces both is that object. A handle whose identity cannot be read is not: an unproven
 * identity is not an identity.
 */
function identityMatches(
  binding: WindowsRecordNativeBindings,
  handle: bigint,
  identity: WindowsFileIdentity,
): boolean {
  const info = Buffer.alloc(WINDOWS_FILE_NATIVE.FILE_ID_INFO_BYTES);
  if (binding.fileInfo(handle, WINDOWS_FILE_NATIVE.FILE_ID_INFO_CLASS, info, info.length) === 0)
    return false;
  // FILE_ID_INFO is the volume serial number (u64) followed by the 16-byte file id. node:fs reports
  // the low 32 bits of the serial and the low 64 bits of the id, so compare the same fields.
  return info.readUInt32LE(0) === identity.dev && Number(info.readBigUInt64LE(8)) === identity.ino;
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
 * Returns false on any error: missing file, access denied, wrong ACL, a path that no longer holds
 * the object the caller stat'ed, or a host where the Win32 security calls are not usable at all.
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
    handle = openForAcl(context.binding, path, isDirectory(kind), options.identity);
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
 * group/other write bit — it does not have to be 0700. Returns false on any error, for an object
 * that is not the one the caller stat'ed, and for a NULL DACL, which grants every principal full
 * access.
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
    handle = openForAcl(context.binding, path, isDirectory(kind), options.identity);
    if (handle === null) return false;
    return !descriptorAllowsForeignWrite(
      context.authority.inspect(handle),
      context.authority.currentUserId(),
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

/**
 * Verify-or-repair for one descriptor policy, with the caller's identity gating both halves.
 *
 * The handle stays open across the repair: the DACL write is by path — there is no handle-based
 * setter — while the handle is what identifies the object, and GetSecurityInfo through it reflects
 * the descriptor that was just written. So the answer after the repair is read from the same object
 * the answer before it was rejected on, and a repair that landed elsewhere (the name moved under
 * us, the write failed) fails the second verdict instead of answering true for a different file.
 */
function ensureAcl(
  path: string,
  kind: WindowsAuthorityPathKind,
  options: WindowsAclOpsOptions,
  verdict: (context: WindowsAclContext, handle: bigint) => void,
): boolean {
  const context = aclContext(options);
  if (context === null) return false;
  let handle: bigint | null = null;
  try {
    handle = openForAcl(context.binding, path, isDirectory(kind), options.identity);
    if (handle === null) return false;
    try {
      verdict(context, handle);
    } catch {
      context.authority.migrateToOwnerOnly(path, kind);
      verdict(context, handle);
    }
    return true;
  } catch {
    return false;
  } finally {
    if (handle !== null) closeQuietly(context.binding, handle);
  }
}

/**
 * The answer windowsVerifyPathAcl gives, after repairing the path when the DACL merely needs it.
 *
 * The owner-only policy is what the durable files are held to, but state written by an earlier
 * release — or by any caller that used plain fs calls — carries the inherited DACL its parent
 * handed it. Rejecting that outright blocks every existing install on first use, so the migration
 * runs first and the question is asked again; a path that cannot be migrated still answers false.
 */
export function windowsEnsurePrivateAcl(
  path: string,
  kind: WindowsAuthorityPathKind,
  options: WindowsAclOpsOptions = {},
): boolean {
  return ensureAcl(path, kind, options, (context, handle) =>
    context.authority.verifyHandle(handle, kind),
  );
}

/** The same repair-and-recheck for the weaker rule windowsHasNoForeignWrite answers. */
export function windowsEnsureNoForeignWrite(
  path: string,
  kind: WindowsAuthorityPathKind,
  options: WindowsAclOpsOptions = {},
): boolean {
  return ensureAcl(path, kind, options, (context, handle) => {
    if (
      descriptorAllowsForeignWrite(
        context.authority.inspect(handle),
        context.authority.currentUserId(),
      )
    )
      durabilityError("unsafe_path", "permissive Windows authority DACL rejected");
  });
}
