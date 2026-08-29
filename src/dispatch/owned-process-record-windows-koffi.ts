import type { WindowsRecordNativeBindings } from "./owned-process-record-windows-native.js";
import type { WindowsFfiRuntime } from "./windows-ffi-runtime.js";
import type { WindowsVolumeNativeBindings } from "./windows-volume-authority.js";

export function loadWindowsRecordNativeBindingsKoffi(
  runtime: WindowsFfiRuntime,
  volume: WindowsVolumeNativeBindings,
): WindowsRecordNativeBindings {
  const koffi = runtime.requireModule("koffi") as typeof import("koffi").default;
  const kernel32 = koffi.load("Kernel32.dll");
  const handle = koffi.pointer(koffi.opaque());
  const wide = koffi.pointer("char16_t");
  const overlapped = koffi.struct({
    Internal: "uintptr_t",
    InternalHigh: "uintptr_t",
    Offset: "uint32_t",
    OffsetHigh: "uint32_t",
    hEvent: handle,
  });
  const overlappedInOut = koffi.inout(koffi.pointer(overlapped));
  const outputBytes = koffi.out(koffi.pointer("uint8_t"));
  return {
    ...volume,
    invalidHandle: BigInt.asUintN(koffi.sizeof(handle) * 8, -1n),
    createFile: kernel32.func("__stdcall", "CreateFileW", handle, [
      wide,
      "uint32_t",
      "uint32_t",
      "void *",
      "uint32_t",
      "uint32_t",
      handle,
    ]) as WindowsRecordNativeBindings["createFile"],
    lockFile: kernel32.func("__stdcall", "LockFileEx", "int", [
      handle,
      "uint32_t",
      "uint32_t",
      "uint32_t",
      "uint32_t",
      overlappedInOut,
    ]) as WindowsRecordNativeBindings["lockFile"],
    unlockFile: kernel32.func("__stdcall", "UnlockFileEx", "int", [
      handle,
      "uint32_t",
      "uint32_t",
      "uint32_t",
      overlappedInOut,
    ]) as WindowsRecordNativeBindings["unlockFile"],
    moveFileEx: kernel32.func("__stdcall", "MoveFileExW", "int", [
      wide,
      wide,
      "uint32_t",
    ]) as WindowsRecordNativeBindings["moveFileEx"],
    flushFile: kernel32.func("__stdcall", "FlushFileBuffers", "int", [
      handle,
    ]) as WindowsRecordNativeBindings["flushFile"],
    closeHandle: kernel32.func("__stdcall", "CloseHandle", "int", [
      handle,
    ]) as WindowsRecordNativeBindings["closeHandle"],
    fileInfo: kernel32.func("__stdcall", "GetFileInformationByHandleEx", "int", [
      handle,
      "int",
      outputBytes,
      "uint32_t",
    ]) as WindowsRecordNativeBindings["fileInfo"],
  };
}
