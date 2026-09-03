import { cleanupThenThrow, runCleanups, withCleanup } from "../durability/cleanup.js";
import { durabilityError } from "../durability/errors.js";
import { DEFAULT_WINDOWS_FFI_RUNTIME, type WindowsFfiRuntime } from "./windows-ffi-runtime.js";
import { loadWindowsPrivateAuthorityBun } from "./windows-private-authority-bun.js";
import { loadWindowsPrivateAuthorityKoffi } from "./windows-private-authority-koffi.js";

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
} as const);

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
}

export interface WindowsPrivateAuthority {
  withCreationSecurity<T>(kind: WindowsAuthorityPathKind, create: (attributes: unknown) => T): T;
  verifyHandle(handle: bigint, kind: WindowsAuthorityPathKind): void;
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
    verifyHandle(handle, kind) {
      const descriptor = bindings.inspect(handle);
      const [ace] = descriptor.aces;
      if (
        (descriptor.control & WINDOWS_PRIVATE_SECURITY.SE_DACL_PROTECTED) === 0 ||
        !descriptor.daclPresent ||
        descriptor.daclDefaulted ||
        descriptor.aces.length !== 1 ||
        !descriptor.owner.equals(user.sid) ||
        !ace ||
        ace.type !== WINDOWS_PRIVATE_SECURITY.ACCESS_ALLOWED_ACE_TYPE ||
        ace.flags !== expectedAceFlags(kind) ||
        ace.mask !== WINDOWS_PRIVATE_SECURITY.FILE_ALL_ACCESS ||
        !ace.sid.equals(user.sid)
      )
        durabilityError("unsafe_path", "permissive Windows authority DACL rejected");
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
  const currentUser = (): { sid: Buffer; sddl: string } => {
    const token: unknown[] = [null];
    if (!native.openToken(native.getCurrentProcess(), WINDOWS_PRIVATE_SECURITY.TOKEN_QUERY, token))
      failed("OpenProcessToken");
    return withCleanup(() => {
      const needed = [0];
      if (
        native.tokenInfo(
          token[0] as bigint,
          WINDOWS_PRIVATE_SECURITY.TOKEN_USER_CLASS,
          null,
          0,
          needed,
        ) ||
        native.lastError() !== WINDOWS_PRIVATE_SECURITY.ERROR_INSUFFICIENT_BUFFER
      )
        failed("GetTokenInformation(size)");
      const output = Buffer.alloc(needed[0] ?? 0);
      if (
        !native.tokenInfo(
          token[0] as bigint,
          WINDOWS_PRIVATE_SECURITY.TOKEN_USER_CLASS,
          output,
          output.length,
          needed,
        )
      )
        failed("GetTokenInformation");
      const sid = native.tokenUserSid(output);
      const text: unknown[] = [null];
      if (!native.sidToString(sid, text)) failed("ConvertSidToStringSidW");
      return withCleanup(
        () => ({
          sid: copySid(sid),
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
  return { currentUser, createSecurity, inspect };
}

export function loadWindowsPrivateAuthorityBindings(
  runtime: WindowsFfiRuntime = DEFAULT_WINDOWS_FFI_RUNTIME,
): WindowsPrivateAuthorityBindings {
  if (runtime.isBun) return securityBindings(loadWindowsPrivateAuthorityBun(runtime));
  return securityBindings(loadWindowsPrivateAuthorityKoffi(runtime));
}
