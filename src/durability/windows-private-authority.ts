import { cleanupThenThrow, runCleanups, withCleanup } from "./cleanup.js";
import { durabilityError } from "./errors.js";
import { DEFAULT_WINDOWS_FFI_RUNTIME, type WindowsFfiRuntime } from "./windows-ffi-runtime.js";
import { loadWindowsPrivateAuthorityBun } from "./windows-private-authority-bun.js";
import { loadWindowsPrivateAuthorityKoffi } from "./windows-private-authority-koffi.js";
import {
  WINDOWS_AUTHORITY_PATH_KIND,
  WINDOWS_PRIVATE_SECURITY,
  type WindowsAuthorityPathKind,
  type WindowsCreationSecurity,
  type WindowsPrivateAce,
  type WindowsPrivateAuthorityBindings,
  type WindowsPrivateDescriptorView,
  descriptorAllowsForeignWrite,
  foreignWriteAce,
  formatWindowsSid,
} from "./windows-private-contract.js";

export {
  WINDOWS_AUTHORITY_PATH_KIND,
  WINDOWS_PRIVATE_SECURITY,
  descriptorAllowsForeignWrite,
  foreignWriteAce,
  formatWindowsSid,
  type WindowsAuthorityPathKind,
  type WindowsCreationSecurity,
  type WindowsPrivateAce,
  type WindowsPrivateAuthorityBindings,
  type WindowsPrivateDescriptorView,
};

export interface WindowsPrivateAuthority {
  withCreationSecurity<T>(kind: WindowsAuthorityPathKind, create: (attributes: unknown) => T): T;
  verifyHandle(handle: bigint, kind: WindowsAuthorityPathKind): void;
  /** Read the owner/DACL view behind a handle, for callers that apply their own policy to it. */
  inspect(handle: bigint): WindowsPrivateDescriptorView;
  /**
   * The weaker policy for containers and lock files: throw unless the descriptor behind the handle
   * refuses write to every principal but the owner and the root-equivalent SIDs. A path that has
   * merely inherited the standard DACL passes, which is what an upgrade over an existing install
   * needs — see verifyHandle for the stricter rule the data files are held to.
   */
  verifyNoForeignWrite(handle: bigint): void;
  /** The SID of the account running this process, for callers applying their own descriptor policy. */
  currentUserId(): Buffer;
  /** Reset an existing file/dir's DACL in-place to owner-only + SE_DACL_PROTECTED. */
  migrateToOwnerOnly(path: string, kind: WindowsAuthorityPathKind): void;
}

export interface WindowsSecurityNativeRuntime {
  getCurrentProcess(): bigint;
  closeHandle(handle: bigint): number;
  localFree(value: unknown): unknown;
  lastError(): number;
  openToken(process: bigint, access: number, token: unknown[]): number;
  tokenInfo(
    token: bigint,
    kind: number,
    output: Buffer | null,
    bytes: number,
    needed: number[],
  ): number;
  tokenUserSid(output: Buffer): unknown;
  validSid(sid: unknown): number;
  sidLength(sid: unknown): number;
  sidToString(sid: unknown, output: unknown[]): number;
  wideString(text: unknown): string;
  convertDescriptor(sddl: Buffer, revision: number, descriptor: unknown[], bytes: number[]): number;
  getSecurityInfo(
    handle: bigint,
    type: number,
    info: number,
    owner: unknown[],
    group: unknown[],
    dacl: unknown[],
    sacl: unknown[],
    descriptor: unknown[],
  ): number;
  setNamedSecurityInfo(
    path: Buffer,
    type: number,
    info: number,
    owner: unknown,
    group: unknown,
    dacl: unknown,
    sacl: unknown,
  ): number;
  descriptorControl(descriptor: unknown, control: number[], revision: number[]): number;
  descriptorDacl(
    descriptor: unknown,
    present: number[],
    dacl: unknown[],
    defaulted: number[],
  ): number;
  aclInfo(acl: unknown, output: Buffer, bytes: number, kind: number): number;
  bytesAt(value: unknown, length: number): Uint8Array;
  createSecurityAttributes(descriptor: unknown): WindowsCreationSecurity;
}

function expectedAceFlags(kind: WindowsAuthorityPathKind): number {
  return kind === WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY
    ? WINDOWS_PRIVATE_SECURITY.OBJECT_INHERIT_ACE | WINDOWS_PRIVATE_SECURITY.CONTAINER_INHERIT_ACE
    : 0;
}

function descriptorSddl(user: string, kind: WindowsAuthorityPathKind): string {
  const inheritance = kind === WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY ? "OICI" : "";
  return `O:${user}D:P(A;${inheritance};FA;;;${user})`;
}

export function createWindowsPrivateAuthority(
  bindings: WindowsPrivateAuthorityBindings = loadWindowsPrivateAuthorityBindings(),
): WindowsPrivateAuthority {
  const user = bindings.currentUser();
  if (user.sid.length < 8 || !/^S-\d(?:-\d+)+$/u.test(user.sddl))
    durabilityError("unsupported", "Windows token user SID is unavailable");
  return {
    withCreationSecurity(kind, create) {
      const security = bindings.createSecurity(descriptorSddl(user.sddl, kind));
      return withCleanup(() => create(security.attributes), [security.release]);
    },
    inspect(handle) {
      return bindings.inspect(handle);
    },
    currentUserId: () => bindings.currentUser().sid,
    verifyNoForeignWrite(handle) {
      const view = bindings.inspect(handle);
      const holder = foreignWriteAce(view, bindings.currentUser().sid);
      if (view.daclPresent && !view.daclDefaulted && holder === null) return;
      durabilityError(
        "unsafe_path",
        holder === null
          ? "permissive Windows authority DACL rejected: the DACL is absent"
          : `permissive Windows authority DACL rejected: ${formatWindowsSid(holder.sid)} holds mask 0x${(holder.mask >>> 0).toString(16)} (owner ${formatWindowsSid(view.owner)})`,
      );
    },
    verifyHandle(handle, kind) {
      const descriptor = bindings.inspect(handle);
      const [ace] = descriptor.aces;
      if (
        (descriptor.control & WINDOWS_PRIVATE_SECURITY.SE_DACL_PROTECTED) === 0 ||
        !descriptor.daclPresent ||
        descriptor.daclDefaulted ||
        descriptor.aces.length !== 1 ||
        // The owner must be the caller's own principal — which is the token's owner SID, not
        // necessarily its user SID: Windows stamps the token owner on every object the token
        // creates, and for an elevated administrator token that is BUILTIN\Administrators. A
        // freshly created directory on such a host is owned by that group, so comparing against
        // the user SID alone rejected objects this process had just created and could not be
        // repaired back (the owner is not the DACL). See #803.
        (!descriptor.owner.equals(user.sid) && !descriptor.owner.equals(user.ownerSid)) ||
        !ace ||
        ace.type !== WINDOWS_PRIVATE_SECURITY.ACCESS_ALLOWED_ACE_TYPE ||
        ace.flags !== expectedAceFlags(kind) ||
        ace.mask !== WINDOWS_PRIVATE_SECURITY.FILE_ALL_ACCESS ||
        !ace.sid.equals(user.sid)
      )
        durabilityError("unsafe_path", "permissive Windows authority DACL rejected");
    },
    migrateToOwnerOnly(path, kind) {
      bindings.migrateDacl(path, descriptorSddl(user.sddl, kind));
    },
  };
}

function securityBindings(native: WindowsSecurityNativeRuntime): WindowsPrivateAuthorityBindings {
  const failed = (operation: string): never =>
    durabilityError("unsafe_path", `${operation} failed with Windows error ${native.lastError()}`);
  const copyBytes = (value: unknown, length: number): Buffer =>
    Buffer.from(new Uint8Array(native.bytesAt(value, length)));
  const copySid = (sid: unknown): Buffer => {
    if (!sid || !native.validSid(sid)) failed("IsValidSid");
    const length = native.sidLength(sid);
    if (length < 8 || length > 68) failed("GetLengthSid");
    return copyBytes(sid, length);
  };
  const aceSid = (ace: Buffer): Buffer => {
    const sid = ace.subarray(WINDOWS_PRIVATE_SECURITY.ACCESS_ALLOWED_SID_OFFSET);
    const subAuthorities = sid[1];
    if (
      sid.length < 8 ||
      subAuthorities === undefined ||
      sid.length !== 8 + subAuthorities * 4 ||
      !native.validSid(sid) ||
      native.sidLength(sid) !== sid.length
    )
      durabilityError("unsafe_path", "invalid Windows authority ACE SID");
    return Buffer.from(sid);
  };
  const tokenSid = (token: bigint, kind: number): unknown => {
    const needed = [0];
    if (
      native.tokenInfo(token, kind, null, 0, needed) ||
      native.lastError() !== WINDOWS_PRIVATE_SECURITY.ERROR_INSUFFICIENT_BUFFER
    )
      failed("GetTokenInformation(size)");
    const output = Buffer.alloc(needed[0] ?? 0);
    if (!native.tokenInfo(token, kind, output, output.length, needed))
      failed("GetTokenInformation");
    // TOKEN_USER and TOKEN_OWNER both begin with the SID pointer, and the reader takes that
    // pointer rather than a struct, so one read serves both classes.
    return native.tokenUserSid(output);
  };
  const currentUser = (): { sid: Buffer; sddl: string; ownerSid: Buffer } => {
    const token: unknown[] = [null];
    if (!native.openToken(native.getCurrentProcess(), WINDOWS_PRIVATE_SECURITY.TOKEN_QUERY, token))
      failed("OpenProcessToken");
    return withCleanup(() => {
      const sid = tokenSid(token[0] as bigint, WINDOWS_PRIVATE_SECURITY.TOKEN_USER_CLASS);
      const ownerSid = tokenSid(token[0] as bigint, WINDOWS_PRIVATE_SECURITY.TOKEN_OWNER_CLASS);
      const text: unknown[] = [null];
      if (!native.sidToString(sid, text)) failed("ConvertSidToStringSidW");
      return withCleanup(
        () => ({
          sid: copySid(sid),
          ownerSid: copySid(ownerSid),
          sddl: native.wideString(text[0]),
        }),
        [() => native.localFree(text[0])],
      );
    }, [
      () => {
        if (!native.closeHandle(token[0] as bigint)) failed("CloseHandle(token)");
      },
    ]);
  };
  const createSecurity = (sddl: string): WindowsCreationSecurity => {
    const descriptor: unknown[] = [null];
    if (
      !native.convertDescriptor(
        Buffer.from(`${sddl}\0`, "utf16le"),
        WINDOWS_PRIVATE_SECURITY.SDDL_REVISION,
        descriptor,
        [0],
      )
    )
      failed("ConvertStringSecurityDescriptorToSecurityDescriptorW");
    let attributes: WindowsCreationSecurity;
    try {
      attributes = native.createSecurityAttributes(descriptor[0]);
    } catch (error) {
      return cleanupThenThrow(error, [() => native.localFree(descriptor[0])]);
    }
    return {
      attributes: attributes.attributes,
      release: () => runCleanups([attributes.release, () => native.localFree(descriptor[0])]),
    };
  };
  const migrateDacl = (path: string, sddl: string): void => {
    const descriptor: unknown[] = [null];
    if (
      !native.convertDescriptor(
        Buffer.from(`${sddl}\0`, "utf16le"),
        WINDOWS_PRIVATE_SECURITY.SDDL_REVISION,
        descriptor,
        [0],
      )
    )
      failed("ConvertStringSecurityDescriptorToSecurityDescriptorW(migrate)");
    try {
      const present = [0];
      const dacl: unknown[] = [null];
      const defaulted = [0];
      if (
        !native.descriptorDacl(descriptor[0], present, dacl, defaulted) ||
        !present[0] ||
        !dacl[0]
      )
        failed("GetSecurityDescriptorDacl(migrate)");
      const code = native.setNamedSecurityInfo(
        Buffer.from(`${path}\0`, "utf16le"),
        WINDOWS_PRIVATE_SECURITY.SE_FILE_OBJECT,
        // >>> 0: PROTECTED_DACL_INFORMATION is 0x80000000, so the bitwise OR yields a negative
        // int32 in JS. Passing that to a u32 FFI parameter reaches Windows as garbage flags and
        // the call fails with ERROR_ACCESS_DENIED(5).
        (WINDOWS_PRIVATE_SECURITY.DACL_INFORMATION |
          WINDOWS_PRIVATE_SECURITY.PROTECTED_DACL_INFORMATION) >>>
          0,
        null,
        null,
        dacl[0],
        null,
      );
      if (code !== 0)
        durabilityError("unsafe_path", `SetNamedSecurityInfoW failed with Windows error ${code}`);
    } finally {
      native.localFree(descriptor[0]);
    }
  };
  const inspect = (handle: bigint): WindowsPrivateDescriptorView => {
    const owner: unknown[] = [null];
    const dacl: unknown[] = [null];
    const descriptor: unknown[] = [null];
    const code = native.getSecurityInfo(
      handle,
      WINDOWS_PRIVATE_SECURITY.SE_FILE_OBJECT,
      WINDOWS_PRIVATE_SECURITY.OWNER_INFORMATION | WINDOWS_PRIVATE_SECURITY.DACL_INFORMATION,
      owner,
      [null],
      dacl,
      [null],
      descriptor,
    );
    if (code !== 0)
      durabilityError("unsafe_path", `GetSecurityInfo failed with Windows error ${code}`);
    return withCleanup(() => {
      const control = [0];
      if (!native.descriptorControl(descriptor[0], control, [0]))
        failed("GetSecurityDescriptorControl");
      const present = [0];
      const defaulted = [0];
      const checkedDacl: unknown[] = [null];
      if (!native.descriptorDacl(descriptor[0], present, checkedDacl, defaulted))
        failed("GetSecurityDescriptorDacl");
      const aces: WindowsPrivateAce[] = [];
      if (present[0] && checkedDacl[0]) {
        const info = Buffer.alloc(WINDOWS_PRIVATE_SECURITY.ACL_INFORMATION_BYTES);
        if (
          !native.aclInfo(
            checkedDacl[0],
            info,
            info.length,
            WINDOWS_PRIVATE_SECURITY.ACL_SIZE_INFORMATION_CLASS,
          )
        )
          failed("GetAclInformation");
        const aceCount = info.readUInt32LE(0);
        const bytesInUse = info.readUInt32LE(4);
        if (bytesInUse < WINDOWS_PRIVATE_SECURITY.ACL_HEADER_BYTES || bytesInUse > 0xffff)
          durabilityError("unsafe_path", "invalid Windows authority ACL bounds");
        const acl = copyBytes(checkedDacl[0], bytesInUse);
        if (acl.readUInt16LE(2) < bytesInUse || acl.readUInt16LE(4) !== aceCount)
          durabilityError("unsafe_path", "inconsistent Windows authority ACL");
        let offset = WINDOWS_PRIVATE_SECURITY.ACL_HEADER_BYTES;
        for (let index = 0; index < aceCount; index++) {
          if (offset + WINDOWS_PRIVATE_SECURITY.ACE_HEADER_BYTES > bytesInUse)
            durabilityError("unsafe_path", "truncated Windows authority ACE");
          const size = acl.readUInt16LE(offset + 2);
          if (
            size < WINDOWS_PRIVATE_SECURITY.ACCESS_ALLOWED_SID_OFFSET + 8 ||
            offset + size > bytesInUse
          )
            durabilityError("unsafe_path", "invalid Windows authority ACE");
          const bytes = acl.subarray(offset, offset + size);
          aces.push({
            type: bytes.readUInt8(0),
            flags: bytes.readUInt8(1),
            mask: bytes.readUInt32LE(4),
            sid: aceSid(bytes),
          });
          offset += size;
        }
        if (offset !== bytesInUse)
          durabilityError("unsafe_path", "noncanonical Windows authority ACL bytes");
      }
      return {
        control: control[0] ?? 0,
        owner: copySid(owner[0]),
        daclPresent: Boolean(present[0]),
        daclDefaulted: Boolean(defaulted[0]),
        aces,
      };
    }, [() => native.localFree(descriptor[0])]);
  };
  return { currentUser, createSecurity, inspect, migrateDacl };
}

export function loadWindowsPrivateAuthorityBindings(
  runtime: WindowsFfiRuntime = DEFAULT_WINDOWS_FFI_RUNTIME,
): WindowsPrivateAuthorityBindings {
  if (runtime.isBun) return securityBindings(loadWindowsPrivateAuthorityBun(runtime));
  return securityBindings(loadWindowsPrivateAuthorityKoffi(runtime));
}
