/**
 * Shared Windows ACL helpers used by posix-fs-semantics.ts (hasPrivateMode,
 * isNotGroupOrWorldWritable) and native-windows-ops.ts (the leaf repair behind openDirectoryAt).
 *
 * Opens by path using the existing CreateFileW binding, then delegates to
 * createWindowsPrivateAuthority() for verify/migrate. Does NOT use _get_osfhandle —
 * that crashes the process on Node/Bun fds (see issue #807 probe comment).
 *
 * The open is by path, so a verdict describes whatever sits at the path when it happens. Callers
 * that already stat'ed the object hand in its identity, and the reopened handle has to prove it is
 * that same object before its DACL speaks for it (issue #811). The identity is carried as bigints:
 * NTFS file ids need 57 bits, so a Number-typed `ino` is rounded above 2^53 and two distinct objects
 * can share one rounded value (issue #817).
 *
 * The descriptor *write* (owner and DACL) is by handle, never by path: SetSecurityInfo replaces the
 * owner and DACL of the object the handle refers to, whatever happens to the name meanwhile
 * (measured: with WRITE_DAC on the handle it returns 0 and replaces the DACL; without it,
 * ERROR_ACCESS_DENIED and no change — see WindowsPrivateAuthorityBindings.migrateHandle). Every write
 * here additionally requires the caller's identity and fails closed without one, so there is no path
 * for a substituted object to intercept: a write that cannot be tied to the object the caller
 * measured is not performed at all (issue #817).
 */
import * as fs from "node:fs";
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
 * The exact identity of a file object as node:fs reports it with `{ bigint: true }`: `dev` is the
 * volume serial number and `ino` the file id — the same pair PinnedDirectory carries for a pinned
 * directory fd.
 *
 * Bigint on purpose. `ino` is a 64-bit NTFS file id and Number-typed stats round it above 2^53, so
 * two distinct objects can present the same rounded id; an identity that cannot be told apart is not
 * an identity.
 */
export interface WindowsFileIdentity {
  dev: bigint;
  ino: bigint;
}

/**
 * The exact identity of the object behind an open descriptor.
 *
 * The ACL machinery only ever has a path, so the caller's own measurement is the witness its verdict
 * is bound to. A descriptor cannot be retargeted, so this describes the same object the caller's
 * stat did, and `{ bigint: true }` keeps it exact.
 */
export function descriptorIdentity(descriptor: number): WindowsFileIdentity {
  const stat = fs.fstatSync(descriptor, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
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
   * The exact identity of the object the caller measured, from `descriptorIdentity(fd)`.
   *
   * The verdicts reopen the path, so this is what binds an answer to the object the caller will
   * actually use: a handle opened at `path` counts as that object only if it reproduces the pair
   * exactly, and a leaf swapped in after the caller's stat fails the comparison instead of
   * answering for it. The repairs additionally require it — a DACL write that cannot be tied to the
   * object the caller measured is refused rather than performed.
   */
  identity?: WindowsFileIdentity;
}

// READ_CONTROL answers what the DACL says; a repair additionally needs WRITE_DAC and WRITE_OWNER,
// because the write goes through the handle and replaces the descriptor's owner as well as its DACL
// (see WindowsPrivateAuthorityBindings.migrateHandle). A handle without WRITE_DAC gets
// ERROR_ACCESS_DENIED from SetSecurityInfo, and one without WRITE_OWNER leaves the owner an elevated
// token gave the object in place — which a strict verdict then refuses, even for a path this process
// has just created.
const VERDICT_ACCESS = WINDOWS_NATIVE_RECORD.READ_CONTROL >>> 0;
const REPAIR_ACCESS =
  (WINDOWS_NATIVE_RECORD.READ_CONTROL |
    WINDOWS_NATIVE_RECORD.WRITE_DAC |
    WINDOWS_NATIVE_RECORD.WRITE_OWNER) >>>
  0;

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
  access: number,
): bigint | null {
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
 *
 * The comparison is on the raw 64-bit file id, never on a Number: rounding it above 2^53 would let
 * two distinct objects share an identity, which is the whole of what this gate is for.
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
  return BigInt(info.readUInt32LE(0)) === identity.dev && info.readBigUInt64LE(8) === identity.ino;
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
    handle = openForAcl(context.binding, path, isDirectory(kind), options.identity, VERDICT_ACCESS);
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
    handle = openForAcl(context.binding, path, isDirectory(kind), options.identity, VERDICT_ACCESS);
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

export { WINDOWS_AUTHORITY_PATH_KIND };

/**
 * Verify-or-repair for one descriptor policy, with the caller's identity gating both halves.
 *
 * One handle carries the whole transaction: it is what identifies the object against the caller's
 * measurement, what the policy is read from, and what the repair is written through. The write cannot
 * be diverted — SetSecurityInfo acts on the handle, never on the name — and it replaces the owner
 * alongside the DACL, which is what brings an object an elevated token left to the group back to the
 * policy the verdict enforces. So the answer after the repair is read from the same object the answer
 * before it was rejected on, whatever happens to the path meanwhile.
 *
 * No identity, no repair. A caller that cannot say which object it measured has nothing this module
 * can tie the write to, and repairing whatever the name holds would be exactly the substitution the
 * identity gate exists to refuse (issue #817), so the answer is false and no write is attempted.
 */
function ensureAcl(
  path: string,
  kind: WindowsAuthorityPathKind,
  options: WindowsAclOpsOptions,
  verdict: (context: WindowsAclContext, handle: bigint) => void,
): boolean {
  if (options.identity === undefined) return false;
  const context = aclContext(options);
  if (context === null) return false;
  let handle: bigint | null = null;
  try {
    handle = openForAcl(context.binding, path, isDirectory(kind), options.identity, REPAIR_ACCESS);
    if (handle === null) return false;
    try {
      verdict(context, handle);
    } catch {
      context.authority.migrateHandle(handle, kind);
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
 * The answer windowsVerifyPathAcl gives, after repairing the path when the descriptor merely needs it.
 *
 * The owner-only policy is what the durable files are held to, but state written by an earlier
 * release — or by any caller that used plain fs calls — carries the inherited DACL its parent handed
 * it, and under an elevated token the owner that token leaves on everything it creates. Rejecting
 * either outright blocks every existing install on first use, and the owner blocks even the paths the
 * install has just created itself, so the migration runs first and the question is asked again; a path
 * that cannot be migrated still answers false.
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
