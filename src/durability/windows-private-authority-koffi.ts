import { cleanupThenThrow, runCleanups } from "./cleanup.js";
import type { WindowsFfiRuntime } from "./windows-ffi-runtime.js";
import type {
  WindowsCreationSecurity,
  WindowsSecurityNativeRuntime,
} from "./windows-private-authority.js";

export function loadWindowsPrivateAuthorityKoffi(
  runtime: WindowsFfiRuntime,
): WindowsSecurityNativeRuntime {
  const koffi = runtime.requireModule("koffi") as typeof import("koffi").default;
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
  const setSecurityInfo = advapi.func("__stdcall", "SetSecurityInfo", "uint32_t", [
    pointer,
    "int",
    "uint32_t",
    pointer,
    pointer,
    pointer,
    pointer,
  ]) as (
    handle: bigint,
    type: number,
    info: number,
    owner: unknown,
    group: unknown,
    dacl: unknown,
    sacl: unknown,
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
  return {
    getCurrentProcess: () => getCurrentProcess(),
    closeHandle,
    localFree: (value) => localFree(value),
    lastError: () => lastError(),
    openToken,
    tokenInfo,
    // TOKEN_USER is SID_AND_ATTRIBUTES and TOKEN_OWNER is a bare PSID, but both begin with the
    // SID pointer, so read that pointer instead of decoding a struct: koffi would read the
    // 16-byte TOKEN_USER layout out of TOKEN_OWNER's 8-byte buffer.
    tokenUserSid: (output) => koffi.decode(output, pointer) as unknown,
    validSid,
    sidLength,
    sidToString,
    // Decode as a NUL-terminated wide string. "char16_t *" (and "str16") segfault here: the
    // out-parameter arrives as a raw BigInt address, and koffi dereferences those two forms as
    // pointer-to-pointer. Measured on Windows 11 — this form is the one that returns the string.
    wideString: (text) => koffi.decode(text, "char16_t", -1) as string,
    convertDescriptor,
    getSecurityInfo,
    setSecurityInfo,
    descriptorControl,
    descriptorDacl,
    aclInfo,
    bytesAt: (value, length) => new Uint8Array(koffi.view(value, length)),
    createSecurityAttributes(descriptor): WindowsCreationSecurity {
      let attributes: unknown;
      try {
        attributes = koffi.alloc(securityAttributes, 1);
        koffi.encode(attributes, securityAttributes, {
          nLength: koffi.sizeof(securityAttributes),
          lpSecurityDescriptor: descriptor,
          bInheritHandle: 0,
        });
      } catch (error) {
        return cleanupThenThrow(error, [
          () => {
            if (attributes) koffi.free(attributes);
          },
        ]);
      }
      return {
        attributes,
        release: () => runCleanups([() => koffi.free(attributes)]),
      };
    },
  };
}
