import { createRequire } from "node:module";
import { cleanupThenThrow, runCleanups, withCleanup } from "../durability/cleanup.js";
import { durabilityError } from "../durability/errors.js";

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

interface KoffiRuntime {
  require: (specifier: string) => unknown;
}

export function loadWindowsPrivateAuthorityBindings(
  runtime: KoffiRuntime = { require: createRequire(import.meta.url) },
): WindowsPrivateAuthorityBindings {
  const koffi = runtime.require("koffi") as typeof import("koffi").default;
  const advapi = koffi.load("Advapi32.dll");
  const kernel = koffi.load("Kernel32.dll");
  const opaque = koffi.opaque();
  const pointer = koffi.pointer(opaque);
  const pointerOut = koffi.out(koffi.pointer(pointer));
  const dwordOut = koffi.out(koffi.pointer("uint32_t"));
  const boolOut = koffi.out(koffi.pointer("int"));
  const wide = koffi.pointer("char16_t");
  const securityAttributes = koffi.struct({
    nLength: "uint32_t",
    lpSecurityDescriptor: pointer,
    bInheritHandle: "int",
  });
  const tokenUser = koffi.struct({
    User: koffi.struct({ Sid: pointer, Attributes: "uint32_t" }),
  });
  const getCurrentProcess = kernel.func(
    "__stdcall",
    "GetCurrentProcess",
    pointer,
    [],
  ) as () => bigint;
  const closeHandle = kernel.func("__stdcall", "CloseHandle", "int", [pointer]) as (
    handle: bigint,
  ) => number;
  const localFree = kernel.func("__stdcall", "LocalFree", pointer, [pointer]) as (
    value: unknown,
  ) => unknown;
  const lastError = kernel.func("__stdcall", "GetLastError", "uint32_t", []) as () => number;
  const openToken = advapi.func("__stdcall", "OpenProcessToken", "int", [
    pointer,
    "uint32_t",
    pointerOut,
  ]) as (process: bigint, access: number, token: unknown[]) => number;
  const tokenInfo = advapi.func("__stdcall", "GetTokenInformation", "int", [
    pointer,
    "int",
    pointer,
    "uint32_t",
    dwordOut,
  ]) as (
    token: bigint,
    kind: number,
    output: Buffer | null,
    bytes: number,
    needed: number[],
  ) => number;
  const validSid = advapi.func("__stdcall", "IsValidSid", "int", [pointer]) as (
    sid: unknown,
  ) => number;
  const sidLength = advapi.func("__stdcall", "GetLengthSid", "uint32_t", [pointer]) as (
    sid: unknown,
  ) => number;
  const sidToString = advapi.func("__stdcall", "ConvertSidToStringSidW", "int", [
    pointer,
    pointerOut,
  ]) as (sid: unknown, output: unknown[]) => number;
  const convertDescriptor = advapi.func(
    "__stdcall",
    "ConvertStringSecurityDescriptorToSecurityDescriptorW",
    "int",
    [wide, "uint32_t", pointerOut, dwordOut],
  ) as (sddl: Buffer, revision: number, descriptor: unknown[], bytes: number[]) => number;
  const getSecurityInfo = advapi.func("__stdcall", "GetSecurityInfo", "uint32_t", [
    pointer,
    "int",
    "uint32_t",
    pointerOut,
    pointerOut,
    pointerOut,
    pointerOut,
    pointerOut,
  ]) as (
    handle: bigint,
    type: number,
    info: number,
    owner: unknown[],
    group: unknown[],
    dacl: unknown[],
    sacl: unknown[],
    descriptor: unknown[],
  ) => number;
  const descriptorControl = advapi.func("__stdcall", "GetSecurityDescriptorControl", "int", [
    pointer,
    koffi.out(koffi.pointer("uint16_t")),
    dwordOut,
  ]) as (descriptor: unknown, control: number[], revision: number[]) => number;
  const descriptorDacl = advapi.func("__stdcall", "GetSecurityDescriptorDacl", "int", [
    pointer,
    boolOut,
    pointerOut,
    boolOut,
  ]) as (descriptor: unknown, present: number[], dacl: unknown[], defaulted: number[]) => number;
  const aclInfo = advapi.func("__stdcall", "GetAclInformation", "int", [
    pointer,
    pointer,
    "uint32_t",
    "int",
  ]) as (acl: unknown, output: Buffer, bytes: number, kind: number) => number;
  const failed = (operation: string): never =>
    durabilityError("unsafe_path", `${operation} failed with Windows error ${lastError()}`);
  const copyBytes = (value: unknown, length: number): Buffer =>
    Buffer.from(new Uint8Array(koffi.view(value, length)));
  const copySid = (sid: unknown): Buffer => {
    if (!sid || !validSid(sid)) failed("IsValidSid");
    const length = sidLength(sid);
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
      !validSid(sid) ||
      sidLength(sid) !== sid.length
    )
      durabilityError("unsafe_path", "invalid Windows authority ACE SID");
    return Buffer.from(sid);
  };
  const currentUser = (): { sid: Buffer; sddl: string } => {
    const token: unknown[] = [null];
    if (!openToken(getCurrentProcess(), WINDOWS_PRIVATE_SECURITY.TOKEN_QUERY, token))
      failed("OpenProcessToken");
    return withCleanup(() => {
      const needed = [0];
      if (
        tokenInfo(token[0] as bigint, WINDOWS_PRIVATE_SECURITY.TOKEN_USER_CLASS, null, 0, needed) ||
        lastError() !== WINDOWS_PRIVATE_SECURITY.ERROR_INSUFFICIENT_BUFFER
      )
        failed("GetTokenInformation(size)");
      const output = Buffer.alloc(needed[0] ?? 0);
      if (
        !tokenInfo(
          token[0] as bigint,
          WINDOWS_PRIVATE_SECURITY.TOKEN_USER_CLASS,
          output,
          output.length,
          needed,
        )
      )
        failed("GetTokenInformation");
      const decoded = koffi.decode(output, tokenUser) as { User: { Sid: unknown } };
      const text: unknown[] = [null];
      if (!sidToString(decoded.User.Sid, text)) failed("ConvertSidToStringSidW");
      return withCleanup(
        () => ({
          sid: copySid(decoded.User.Sid),
          sddl: koffi.decode(text[0], "char16_t *") as string,
        }),
        [() => localFree(text[0])],
      );
    }, [
      () => {
        if (!closeHandle(token[0] as bigint)) failed("CloseHandle(token)");
      },
    ]);
  };
  return {
    currentUser,
    createSecurity(sddl) {
      const descriptor: unknown[] = [null];
      if (
        !convertDescriptor(
          Buffer.from(`${sddl}\0`, "utf16le"),
          WINDOWS_PRIVATE_SECURITY.SDDL_REVISION,
          descriptor,
          [0],
        )
      )
        failed("ConvertStringSecurityDescriptorToSecurityDescriptorW");
      let attributes: unknown;
      try {
        attributes = koffi.alloc(securityAttributes, 1);
        koffi.encode(attributes, securityAttributes, {
          nLength: koffi.sizeof(securityAttributes),
          lpSecurityDescriptor: descriptor[0],
          bInheritHandle: 0,
        });
      } catch (error) {
        return cleanupThenThrow(error, [
          () => {
            if (attributes) koffi.free(attributes);
          },
          () => localFree(descriptor[0]),
        ]);
      }
      return {
        attributes,
        release: () => runCleanups([() => koffi.free(attributes), () => localFree(descriptor[0])]),
      };
    },
    inspect(handle) {
      const owner: unknown[] = [null];
      const dacl: unknown[] = [null];
      const descriptor: unknown[] = [null];
      const code = getSecurityInfo(
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
        if (!descriptorControl(descriptor[0], control, [0])) failed("GetSecurityDescriptorControl");
        const present = [0];
        const defaulted = [0];
        const checkedDacl: unknown[] = [null];
        if (!descriptorDacl(descriptor[0], present, checkedDacl, defaulted))
          failed("GetSecurityDescriptorDacl");
        const aces: WindowsPrivateAce[] = [];
        if (present[0] && checkedDacl[0]) {
          const info = Buffer.alloc(WINDOWS_PRIVATE_SECURITY.ACL_INFORMATION_BYTES);
          if (
            !aclInfo(
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
      }, [() => localFree(descriptor[0])]);
    },
  };
}
