import {
  DEFAULT_WINDOWS_FFI_RUNTIME,
  type WindowsFfiRuntime,
  windowsFfiAddressing,
} from "./windows-ffi-runtime.js";

export type WindowsNativeHandle = bigint;

export interface WindowsPathNativeBindings {
  invalidHandle: WindowsNativeHandle;
  createFile(
    path: Buffer,
    access: number,
    share: number,
    security: unknown,
    creation: number,
    flags: number,
    template: null,
  ): WindowsNativeHandle;
  createDirectory(path: Buffer, security: unknown): number;
  fileInfo(handle: WindowsNativeHandle, kind: number, output: Buffer, bytes: number): number;
  readFile(
    handle: WindowsNativeHandle,
    output: Buffer,
    bytes: number,
    read: number[],
    overlapped: null,
  ): number;
  writeFile(
    handle: WindowsNativeHandle,
    input: Uint8Array,
    bytes: number,
    written: number[],
    overlapped: null,
  ): number;
  flushFile(handle: WindowsNativeHandle): number;
  setFileInfo(handle: WindowsNativeHandle, kind: number, input: Buffer, bytes: number): number;
  closeHandle(handle: WindowsNativeHandle): number;
  lastError(): number;
}

export function loadWindowsPathNativeBindings(
  runtime: WindowsFfiRuntime = DEFAULT_WINDOWS_FFI_RUNTIME,
): WindowsPathNativeBindings {
  if (runtime.isBun) {
    const ffi = runtime.requireModule("bun:ffi") as typeof import("bun:ffi");
    const { address } = windowsFfiAddressing(ffi);
    // Win32 HANDLEs are plain integers; Bun's FFI rejects them in FFIType.ptr arguments, so
    // handle and buffer arguments alike are declared u64 and routed through `address`.
    const word = ffi.FFIType.u64;
    const kernel = ffi.dlopen("Kernel32.dll", {
      CreateFileW: {
        args: [
          word,
          ffi.FFIType.u32,
          ffi.FFIType.u32,
          word,
          ffi.FFIType.u32,
          ffi.FFIType.u32,
          word,
        ],
        returns: word,
      },
      CreateDirectoryW: { args: [word, word], returns: ffi.FFIType.i32 },
      GetFileInformationByHandleEx: {
        args: [word, ffi.FFIType.i32, word, ffi.FFIType.u32],
        returns: ffi.FFIType.i32,
      },
      ReadFile: {
        args: [word, word, ffi.FFIType.u32, word, word],
        returns: ffi.FFIType.i32,
      },
      WriteFile: {
        args: [word, word, ffi.FFIType.u32, word, word],
        returns: ffi.FFIType.i32,
      },
      FlushFileBuffers: { args: [word], returns: ffi.FFIType.i32 },
      SetFileInformationByHandle: {
        args: [word, ffi.FFIType.i32, word, ffi.FFIType.u32],
        returns: ffi.FFIType.i32,
      },
      CloseHandle: { args: [word], returns: ffi.FFIType.i32 },
      GetLastError: { args: [], returns: ffi.FFIType.u32 },
    });
    return {
      invalidHandle: 0xffff_ffff_ffff_ffffn,
      createFile: (path, access, share, security, creation, flags, template) =>
        kernel.symbols.CreateFileW(
          address(path),
          access,
          share,
          address(security),
          creation,
          flags,
          address(template),
        ) as bigint,
      createDirectory: (path, security) =>
        kernel.symbols.CreateDirectoryW(address(path), address(security)),
      fileInfo: (handle, kind, output, bytes) =>
        kernel.symbols.GetFileInformationByHandleEx(address(handle), kind, address(output), bytes),
      readFile: (handle, output, bytes, read, overlapped) => {
        const readOut = new Uint32Array(1);
        const result = kernel.symbols.ReadFile(
          address(handle),
          address(output),
          bytes,
          address(readOut),
          address(overlapped),
        );
        read[0] = readOut[0] ?? 0;
        return result;
      },
      writeFile: (handle, input, bytes, written, overlapped) => {
        const writtenOut = new Uint32Array(1);
        const result = kernel.symbols.WriteFile(
          address(handle),
          address(input),
          bytes,
          address(writtenOut),
          address(overlapped),
        );
        written[0] = writtenOut[0] ?? 0;
        return result;
      },
      flushFile: (handle) => kernel.symbols.FlushFileBuffers(address(handle)),
      setFileInfo: (handle, kind, input, bytes) =>
        kernel.symbols.SetFileInformationByHandle(address(handle), kind, address(input), bytes),
      closeHandle: (handle) => kernel.symbols.CloseHandle(address(handle)),
      lastError: () => kernel.symbols.GetLastError(),
    };
  }
  const koffi = runtime.requireModule("koffi") as typeof import("koffi").default;
  const kernel = koffi.load("Kernel32.dll");
  const handle = koffi.pointer(koffi.opaque());
  const wide = koffi.pointer("char16_t");
  const bytesOut = koffi.out(koffi.pointer("uint8_t"));
  const dwordOut = koffi.out(koffi.pointer("uint32_t"));
  return {
    invalidHandle: BigInt.asUintN(koffi.sizeof(handle) * 8, -1n),
    createFile: kernel.func("__stdcall", "CreateFileW", handle, [
      wide,
      "uint32_t",
      "uint32_t",
      "void *",
      "uint32_t",
      "uint32_t",
      handle,
    ]) as WindowsPathNativeBindings["createFile"],
    createDirectory: kernel.func("__stdcall", "CreateDirectoryW", "int", [
      wide,
      "void *",
    ]) as WindowsPathNativeBindings["createDirectory"],
    fileInfo: kernel.func("__stdcall", "GetFileInformationByHandleEx", "int", [
      handle,
      "int",
      bytesOut,
      "uint32_t",
    ]) as WindowsPathNativeBindings["fileInfo"],
    readFile: kernel.func("__stdcall", "ReadFile", "int", [
      handle,
      bytesOut,
      "uint32_t",
      dwordOut,
      "void *",
    ]) as WindowsPathNativeBindings["readFile"],
    writeFile: kernel.func("__stdcall", "WriteFile", "int", [
      handle,
      koffi.pointer("uint8_t"),
      "uint32_t",
      dwordOut,
      "void *",
    ]) as WindowsPathNativeBindings["writeFile"],
    flushFile: kernel.func("__stdcall", "FlushFileBuffers", "int", [
      handle,
    ]) as WindowsPathNativeBindings["flushFile"],
    setFileInfo: kernel.func("__stdcall", "SetFileInformationByHandle", "int", [
      handle,
      "int",
      koffi.pointer("uint8_t"),
      "uint32_t",
    ]) as WindowsPathNativeBindings["setFileInfo"],
    closeHandle: kernel.func("__stdcall", "CloseHandle", "int", [
      handle,
    ]) as WindowsPathNativeBindings["closeHandle"],
    lastError: kernel.func(
      "__stdcall",
      "GetLastError",
      "uint32_t",
      [],
    ) as WindowsPathNativeBindings["lastError"],
  };
}
