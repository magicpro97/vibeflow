import type { WindowsFfiRuntime } from "./windows-ffi-runtime.js";
import type {
  WindowsCreationSecurity,
  WindowsSecurityNativeRuntime,
} from "./windows-private-authority.js";

export function loadWindowsPrivateAuthorityBun(
  runtime: WindowsFfiRuntime,
): WindowsSecurityNativeRuntime {
  const ffi = runtime.requireModule("bun:ffi") as typeof import("bun:ffi");
  const pointerType = ffi.FFIType.ptr;
  const kernel = ffi.dlopen("Kernel32.dll", {
    GetCurrentProcess: { args: [], returns: pointerType },
    CloseHandle: { args: [pointerType], returns: ffi.FFIType.i32 },
    LocalFree: { args: [pointerType], returns: pointerType },
    GetLastError: { args: [], returns: ffi.FFIType.u32 },
  });
  const advapi = ffi.dlopen("Advapi32.dll", {
    OpenProcessToken: {
      args: [pointerType, ffi.FFIType.u32, pointerType],
      returns: ffi.FFIType.i32,
    },
    GetTokenInformation: {
      args: [pointerType, ffi.FFIType.i32, pointerType, ffi.FFIType.u32, pointerType],
      returns: ffi.FFIType.i32,
    },
    IsValidSid: { args: [pointerType], returns: ffi.FFIType.i32 },
    GetLengthSid: { args: [pointerType], returns: ffi.FFIType.u32 },
    ConvertSidToStringSidW: {
      args: [pointerType, pointerType],
      returns: ffi.FFIType.i32,
    },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: {
      args: [pointerType, ffi.FFIType.u32, pointerType, pointerType],
      returns: ffi.FFIType.i32,
    },
    GetSecurityInfo: {
      args: [
        pointerType,
        ffi.FFIType.i32,
        ffi.FFIType.u32,
        pointerType,
        pointerType,
        pointerType,
        pointerType,
        pointerType,
      ],
      returns: ffi.FFIType.u32,
    },
    GetSecurityDescriptorControl: {
      args: [pointerType, pointerType, pointerType],
      returns: ffi.FFIType.i32,
    },
    GetSecurityDescriptorDacl: {
      args: [pointerType, pointerType, pointerType, pointerType],
      returns: ffi.FFIType.i32,
    },
    GetAclInformation: {
      args: [pointerType, pointerType, ffi.FFIType.u32, ffi.FFIType.i32],
      returns: ffi.FFIType.i32,
    },
  });
  const wideString = (text: unknown): string => {
    const buffer = Buffer.from(ffi.toArrayBuffer(text as bigint, 0, 1024));
    let end = 0;
    while (end + 2 <= buffer.length && buffer.readUInt16LE(end) !== 0) end += 2;
    return buffer.subarray(0, end).toString("utf16le");
  };
  return {
    getCurrentProcess: () => kernel.symbols.GetCurrentProcess() as bigint,
    closeHandle: (handle) => kernel.symbols.CloseHandle(handle),
    localFree: (value) => kernel.symbols.LocalFree(value as bigint),
    lastError: () => kernel.symbols.GetLastError(),
    openToken: (process, access, token) => {
      const tokenOut = new BigUint64Array(1);
      const result = advapi.symbols.OpenProcessToken(process, access, tokenOut);
      token[0] = tokenOut[0] ?? 0n;
      return result;
    },
    tokenInfo: (token, kind, output, bytes, needed) => {
      const neededOut = new Uint32Array(1);
      const result = advapi.symbols.GetTokenInformation(
        token,
        kind,
        output as Buffer | null,
        bytes,
        neededOut,
      );
      needed[0] = neededOut[0] ?? 0;
      return result;
    },
    tokenUserSid: (output) => output.readBigUInt64LE(0),
    validSid: (sid) => advapi.symbols.IsValidSid(sid as Buffer | bigint | null),
    sidLength: (sid) => advapi.symbols.GetLengthSid(sid as Buffer | bigint | null),
    sidToString: (sid, output) => {
      const textOut = new BigUint64Array(1);
      const result = advapi.symbols.ConvertSidToStringSidW(sid as Buffer | bigint | null, textOut);
      output[0] = textOut[0] ?? 0n;
      return result;
    },
    wideString,
    convertDescriptor: (sddl, revision, descriptor, bytes) => {
      const descriptorOut = new BigUint64Array(1);
      const bytesOut = new Uint32Array(1);
      const result = advapi.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(
        sddl,
        revision,
        descriptorOut,
        bytesOut,
      );
      descriptor[0] = descriptorOut[0] ?? 0n;
      bytes[0] = bytesOut[0] ?? 0;
      return result;
    },
    getSecurityInfo: (handle, type, info, owner, _group, dacl, _sacl, descriptor) => {
      const ownerOut = new BigUint64Array(1);
      const groupOut = new BigUint64Array(1);
      const daclOut = new BigUint64Array(1);
      const saclOut = new BigUint64Array(1);
      const descriptorOut = new BigUint64Array(1);
      const result = advapi.symbols.GetSecurityInfo(
        handle,
        type,
        info,
        ownerOut,
        groupOut,
        daclOut,
        saclOut,
        descriptorOut,
      );
      owner[0] = ownerOut[0] ?? 0n;
      _group[0] = groupOut[0] ?? 0n;
      dacl[0] = daclOut[0] ?? 0n;
      _sacl[0] = saclOut[0] ?? 0n;
      descriptor[0] = descriptorOut[0] ?? 0n;
      return result;
    },
    descriptorControl: (descriptor, control, revision) => {
      const controlOut = new Uint16Array(1);
      const revisionOut = new Uint32Array(1);
      const result = advapi.symbols.GetSecurityDescriptorControl(
        descriptor as bigint,
        controlOut,
        revisionOut,
      );
      control[0] = controlOut[0] ?? 0;
      revision[0] = revisionOut[0] ?? 0;
      return result;
    },
    descriptorDacl: (descriptor, present, dacl, defaulted) => {
      const presentOut = new Int32Array(1);
      const daclOut = new BigUint64Array(1);
      const defaultedOut = new Int32Array(1);
      const result = advapi.symbols.GetSecurityDescriptorDacl(
        descriptor as bigint,
        presentOut,
        daclOut,
        defaultedOut,
      );
      present[0] = presentOut[0] ?? 0;
      dacl[0] = daclOut[0] ?? 0n;
      defaulted[0] = defaultedOut[0] ?? 0;
      return result;
    },
    aclInfo: (acl, output, bytes, kind) =>
      advapi.symbols.GetAclInformation(acl as bigint, output, bytes, kind),
    bytesAt: (value, length) => new Uint8Array(ffi.toArrayBuffer(value as bigint, 0, length)),
    createSecurityAttributes(descriptor): WindowsCreationSecurity {
      const attributes = Buffer.alloc(24);
      attributes.writeUInt32LE(24, 0);
      attributes.writeBigUInt64LE(descriptor as bigint, 8);
      attributes.writeUInt32LE(0, 16);
      return { attributes, release: () => undefined };
    },
  };
}
