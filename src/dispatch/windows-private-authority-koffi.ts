import { cleanupThenThrow, runCleanups } from "../durability/cleanup.js";
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
  return {
    getCurrentProcess: () => getCurrentProcess(),
    closeHandle,
    localFree: (value) => localFree(value),
    lastError: () => lastError(),
    openToken,
    tokenInfo,
    tokenUserSid: (output) =>
      (koffi.decode(output, tokenUser) as { User: { Sid: unknown } }).User.Sid,
    validSid,
    sidLength,
    sidToString,
    wideString: (text) => koffi.decode(text, "char16_t *") as string,
    convertDescriptor,
    getSecurityInfo,
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
