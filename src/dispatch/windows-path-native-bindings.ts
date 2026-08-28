import { createRequire } from "node:module";

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

interface KoffiRuntime {
  require: (specifier: string) => unknown;
}

export function loadWindowsPathNativeBindings(
  runtime: KoffiRuntime = { require: createRequire(import.meta.url) },
): WindowsPathNativeBindings {
  const koffi = runtime.require("koffi") as typeof import("koffi").default;
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
