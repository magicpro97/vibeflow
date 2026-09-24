/**
 * The Windows private-state contract: path kinds, the security vocabulary the authority is built
 * from, and the descriptor policies that vocabulary is queried with.
 *
 * Split out of windows-private-authority.ts so that constants and pure policy do not have to travel
 * with the FFI implementation.
 */
import { WINDOWS_FILE_NATIVE } from "./windows-native-contract.js";

export const WINDOWS_AUTHORITY_PATH_KIND = Object.freeze({
  FILE: "file",
  DIRECTORY: "directory",
} as const);

export type WindowsAuthorityPathKind =
  (typeof WINDOWS_AUTHORITY_PATH_KIND)[keyof typeof WINDOWS_AUTHORITY_PATH_KIND];

export const WINDOWS_PRIVATE_SECURITY = Object.freeze({
  TOKEN_QUERY: 0x8,
  TOKEN_USER_CLASS: 1,
  OWNER_INFORMATION: 0x1,
  DACL_INFORMATION: 0x4,
  PROTECTED_DACL_INFORMATION: 0x8000_0000,
  SE_FILE_OBJECT: 1,
  SE_DACL_PROTECTED: 0x1000,
  ACCESS_ALLOWED_ACE_TYPE: 0,
  OBJECT_INHERIT_ACE: 0x1,
  CONTAINER_INHERIT_ACE: 0x2,
  FILE_ALL_ACCESS: 0x001f_01ff,
  ACL_SIZE_INFORMATION_CLASS: 2,
  ERROR_INSUFFICIENT_BUFFER: 122,
  SDDL_REVISION: 1,
  ACL_INFORMATION_BYTES: 12,
  ACL_HEADER_BYTES: 8,
  ACE_HEADER_BYTES: 4,
  ACCESS_ALLOWED_SID_OFFSET: 8,
  WRITE_DAC: 0x00040000,
  GENERIC_READ: 0x80000000,
  OPEN_EXISTING: 3,
  FILE_FLAG_OPEN_REPARSE_POINT: 0x00200000,
  FILE_FLAG_BACKUP_SEMANTICS: 0x02000000,
  FILE_ATTRIBUTE_NORMAL: 0x80,
} as const);

// S-1-5-18 (LOCAL SYSTEM) and S-1-5-32-544 (BUILTIN\Administrators) are root-equivalent: they can
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
const FOREIGN_WRITE_MASK =
  (WINDOWS_FILE_NATIVE.FILE_WRITE_DATA |
    WINDOWS_FILE_NATIVE.FILE_APPEND_DATA |
    WINDOWS_FILE_NATIVE.FILE_WRITE_EA |
    WINDOWS_FILE_NATIVE.FILE_WRITE_ATTRIBUTES |
    WINDOWS_FILE_NATIVE.DELETE_ACCESS |
    WINDOWS_FILE_NATIVE.WRITE_DAC |
    WINDOWS_FILE_NATIVE.WRITE_OWNER) >>>
  0;

/**
 * Whether the descriptor grants a modifying right to a principal other than the owner.
 *
 * This is the weaker of the two Windows privacy policies, and the one a container or lock file is
 * held to: POSIX asks the same question of a directory with 0755, which is what the standard
 * inherited SYSTEM/Administrators/owner DACL is equivalent to. The owner-only policy lives in
 * verifyHandle and applies to the files whose contents are the trust boundary.
 *
 * A NULL DACL (not present, or defaulted) grants every principal full access and therefore counts.
 */
export function descriptorAllowsForeignWrite(
  view: WindowsPrivateDescriptorView,
  self: Buffer,
): boolean {
  if (!view.daclPresent || view.daclDefaulted) return true;
  return foreignWriteAce(view, self) !== null;
}

/**
 * The first ACE that grants a modifying right to a principal other than the owner, or null when the
 * DACL grants no such right.
 *
 * `self` is the SID of the account running this process, and `view.owner` is the descriptor's
 * owner: both are the caller's own principal for this question. The owner is tracked separately
 * because Windows can record a group there — Administrators is the default owner for the objects a
 * process started from an elevated token creates — and an ACE naming it still only grants the
 * caller the right it already holds.
 *
 * A NULL DACL has no single offending ACE — it grants every principal full access — so callers test
 * daclPresent/daclDefaulted themselves, which is what descriptorAllowsForeignWrite does.
 */
export function foreignWriteAce(
  view: WindowsPrivateDescriptorView,
  self: Buffer,
): WindowsPrivateAce | null {
  return (
    view.aces.find(
      (ace) =>
        ace.type === WINDOWS_PRIVATE_SECURITY.ACCESS_ALLOWED_ACE_TYPE &&
        !ace.sid.equals(self) &&
        !ace.sid.equals(view.owner) &&
        !ROOT_EQUIVALENT_SIDS.some((root) => ace.sid.equals(root)) &&
        (ace.mask & FOREIGN_WRITE_MASK) !== 0,
    ) ?? null
  );
}

/** Render a SID in the S-1-5-21-… form so a failure can name the principal that holds the right. */
export function formatWindowsSid(sid: Buffer): string {
  if (sid.length < 8) return `unreadable SID 0x${sid.toString("hex")}`;
  const subAuthorities = Array.from({ length: sid[1] ?? 0 }, (_, index) =>
    sid.readUInt32LE(8 + index * 4),
  );
  return ["S", sid[0], sid.readUIntBE(2, 6), ...subAuthorities].join("-");
}

export interface WindowsPrivateAce {
  type: number;
  flags: number;
  mask: number;
  sid: Buffer;
}

export interface WindowsPrivateDescriptorView {
  control: number;
  owner: Buffer;
  daclPresent: boolean;
  daclDefaulted: boolean;
  aces: readonly WindowsPrivateAce[];
}

export interface WindowsCreationSecurity {
  attributes: unknown;
  release(): void;
}

export interface WindowsPrivateAuthorityBindings {
  currentUser(): { sid: Buffer; sddl: string };
  createSecurity(sddl: string): WindowsCreationSecurity;
  inspect(handle: bigint): WindowsPrivateDescriptorView;
  /**
   * Replace an existing object's owner and DACL (both derived from sddl) in place, through the
   * handle that names it.
   *
   * By handle, not by path: the descriptor lands on the object this handle refers to, so a name
   * that is replaced while the handle is held cannot receive the write — one measure that closed
   * the migration window (issue #817). SetSecurityInfo requires WRITE_DAC on the handle for the
   * DACL half and WRITE_OWNER for the owner half: with WRITE_DAC the call returns 0 and the DACL is
   * replaced, and without it (a READ_CONTROL-only handle) it fails with ERROR_ACCESS_DENIED(5).
   * Measured on Windows 11 — see test/durability/windows-acl-identity.test.ts.
   *
   * The owner is part of what a strict verdict checks: an elevated token leaves the objects it
   * creates owned by its Administrators group, so a DACL-only write would leave the object one
   * field short of the policy and the caller refusing its own files. Windows only accepts the write
   * for an object the caller already commands (WRITE_OWNER, and the token user as the new owner
   * without SeRestorePrivilege), so a foreign object stays refused.
   */
  migrateHandle(handle: bigint, sddl: string): void;
}
