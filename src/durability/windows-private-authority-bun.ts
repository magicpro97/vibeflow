import { type WindowsFfiRuntime, windowsFfiAddressing } from "./windows-ffi-runtime.js";
import type {
  WindowsCreationSecurity,
  WindowsSecurityNativeRuntime,
} from "./windows-private-authority.js";

export function loadWindowsPrivateAuthorityBun(
  runtime: WindowsFfiRuntime,
): WindowsSecurityNativeRuntime {
  const ffi = runtime.requireModule("bun:ffi") as typeof import("bun:ffi");
  // Win32 HANDLE/PSID/PACL/PSECURITY_DESCRIPTOR values travel as plain integers, and Bun's FFI
  // refuses to coerce an integer into an FFIType.ptr argument ("Unable to convert 888 to a
  // pointer"). Declare every such argument as u64 and pass an address instead.
  const word = ffi.FFIType.u64;
  const kernel = ffi.dlopen("Kernel32.dll", {
    GetCurrentProcess: { args: [], returns: word },
    CloseHandle: { args: [word], returns: ffi.FFIType.i32 },
    LocalFree: { args: [word], returns: word },
    GetLastError: { args: [], returns: ffi.FFIType.u32 },
  });
  const advapi = ffi.dlopen("Advapi32.dll", {
    OpenProcessToken: {
      args: [word, ffi.FFIType.u32, word],
      returns: ffi.FFIType.i32,
    },
    GetTokenInformation: {
      args: [word, ffi.FFIType.i32, word, ffi.FFIType.u32, word],
      returns: ffi.FFIType.i32,
    },
    IsValidSid: { args: [word], returns: ffi.FFIType.i32 },
    GetLengthSid: { args: [word], returns: ffi.FFIType.u32 },
    ConvertSidToStringSidW: {
      args: [word, word],
      returns: ffi.FFIType.i32,
    },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: {
      args: [word, ffi.FFIType.u32, word, word],
      returns: ffi.FFIType.i32,
    },
    GetSecurityInfo: {
      args: [word, ffi.FFIType.i32, ffi.FFIType.u32, word, word, word, word, word],
      returns: ffi.FFIType.u32,
    },
    GetSecurityDescriptorControl: {
      args: [word, word, word],
      returns: ffi.FFIType.i32,
    },
    GetSecurityDescriptorDacl: {
      args: [word, word, word, word],
      returns: ffi.FFIType.i32,
    },
    GetAclInformation: {
      args: [word, word, ffi.FFIType.u32, ffi.FFIType.i32],
      returns: ffi.FFIType.i32,
    },
  });

  const { address, view } = windowsFfiAddressing(ffi);

  const wideString = (text: unknown): string => {
    const buffer = Buffer.from(view(text, 1024));
    let end = 0;
    while (end + 2 <= buffer.length && buffer.readUInt16LE(end) !== 0) end += 2;
    return buffer.subarray(0, end).toString("utf16le");
  };
  return {
    getCurrentProcess: () => kernel.symbols.GetCurrentProcess() as bigint,
    closeHandle: (handle) => kernel.symbols.CloseHandle(address(handle)),
    localFree: (value) => kernel.symbols.LocalFree(address(value)),
    lastError: () => kernel.symbols.GetLastError(),
    openToken: (process, access, token) => {
      const tokenOut = new BigUint64Array(1);
      const result = advapi.symbols.OpenProcessToken(address(process), access, address(tokenOut));
      token[0] = tokenOut[0] ?? 0n;
      return result;
    },
    tokenInfo: (token, kind, output, bytes, needed) => {
      const neededOut = new Uint32Array(1);
      const result = advapi.symbols.GetTokenInformation(
        address(token),
        kind,
        address(output),
        bytes,
        address(neededOut),
      );
      needed[0] = neededOut[0] ?? 0;
      return result;
    },
    tokenUserSid: (output) => output.readBigUInt64LE(0),
    validSid: (sid) => advapi.symbols.IsValidSid(address(sid)),
    sidLength: (sid) => advapi.symbols.GetLengthSid(address(sid)),
    sidToString: (sid, output) => {
      const textOut = new BigUint64Array(1);
      const result = advapi.symbols.ConvertSidToStringSidW(address(sid), address(textOut));
      output[0] = textOut[0] ?? 0n;
      return result;
    },
    wideString,
    convertDescriptor: (sddl, revision, descriptor, bytes) => {
      const descriptorOut = new BigUint64Array(1);
      const bytesOut = new Uint32Array(1);
      const result = advapi.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(
        address(sddl),
        revision,
        address(descriptorOut),
        address(bytesOut),
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
        address(handle),
        type,
        info,
        address(ownerOut),
        address(groupOut),
        address(daclOut),
        address(saclOut),
        address(descriptorOut),
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
        address(descriptor),
        address(controlOut),
        address(revisionOut),
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
        address(descriptor),
        address(presentOut),
        address(daclOut),
        address(defaultedOut),
      );
      present[0] = presentOut[0] ?? 0;
      dacl[0] = daclOut[0] ?? 0n;
      defaulted[0] = defaultedOut[0] ?? 0;
      return result;
    },
    aclInfo: (acl, output, bytes, kind) =>
      advapi.symbols.GetAclInformation(address(acl), address(output), bytes, kind),
    bytesAt: (value, length) => view(value, length),
    createSecurityAttributes(descriptor): WindowsCreationSecurity {
      const attributes = Buffer.alloc(24);
      attributes.writeUInt32LE(24, 0);
      attributes.writeBigUInt64LE(address(descriptor), 8);
      attributes.writeUInt32LE(0, 16);
      return { attributes, release: () => undefined };
    },
  };
}
