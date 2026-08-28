import { createRequire } from "node:module";
import { win32 as windowsPath } from "node:path";
import { durabilityError } from "../durability/errors.js";

export const WINDOWS_VOLUME_AUTHORITY = Object.freeze({
  DRIVE_FIXED: 3,
  FILE_PERSISTENT_ACLS: 0x8,
  DIRECTORY_BUFFER_CHARS: 32_768,
  VOLUME_NAME_CHARS: 261,
  FILESYSTEM_NAME_CHARS: 261,
} as const);

export interface WindowsVolumeNativeBindings {
  driveType(root: Buffer): number;
  volumeInformation(
    root: Buffer,
    volumeName: Buffer,
    volumeChars: number,
    serial: number[],
    componentLength: number[],
    flags: number[],
    filesystemName: Buffer,
    filesystemChars: number,
  ): number;
  windowsDirectory(output: Buffer, outputChars: number): number;
  lastError(): number;
}

interface KoffiRuntime {
  require: (specifier: string) => unknown;
}

export function loadWindowsVolumeNativeBindings(
  runtime: KoffiRuntime = { require: createRequire(import.meta.url) },
): WindowsVolumeNativeBindings {
  const koffi = runtime.require("koffi") as typeof import("koffi").default;
  const kernel = koffi.load("Kernel32.dll");
  const wide = koffi.pointer("char16_t");
  const outputBytes = koffi.out(koffi.pointer("uint8_t"));
  const dwordOut = koffi.out(koffi.pointer("uint32_t"));
  return {
    driveType: kernel.func("__stdcall", "GetDriveTypeW", "uint32_t", [
      wide,
    ]) as WindowsVolumeNativeBindings["driveType"],
    volumeInformation: kernel.func("__stdcall", "GetVolumeInformationW", "int", [
      wide,
      outputBytes,
      "uint32_t",
      dwordOut,
      dwordOut,
      dwordOut,
      outputBytes,
      "uint32_t",
    ]) as WindowsVolumeNativeBindings["volumeInformation"],
    windowsDirectory: kernel.func("__stdcall", "GetWindowsDirectoryW", "uint32_t", [
      outputBytes,
      "uint32_t",
    ]) as WindowsVolumeNativeBindings["windowsDirectory"],
    lastError: kernel.func("__stdcall", "GetLastError", "uint32_t", []) as () => number,
  };
}

const wideString = (value: string): Buffer => Buffer.from(`${value}\0`, "utf16le");

function volumeError(operation: string, binding: WindowsVolumeNativeBindings): Error {
  return new Error(`${operation} failed with Windows error ${binding.lastError()}`);
}

export function assertWindowsLocalRecordPath(
  path: string,
  binding: WindowsVolumeNativeBindings = loadWindowsVolumeNativeBindings(),
): void {
  const root = windowsPath.parse(windowsPath.resolve(path)).root;
  if (
    !/^[A-Za-z]:\\$/u.test(root) ||
    binding.driveType(wideString(root)) !== WINDOWS_VOLUME_AUTHORITY.DRIVE_FIXED
  )
    durabilityError("unsafe_path", "Windows record storage requires a fixed local drive");
  const flags = [0];
  if (
    !binding.volumeInformation(
      wideString(root),
      Buffer.alloc(WINDOWS_VOLUME_AUTHORITY.VOLUME_NAME_CHARS * 2),
      WINDOWS_VOLUME_AUTHORITY.VOLUME_NAME_CHARS,
      [0],
      [0],
      flags,
      Buffer.alloc(WINDOWS_VOLUME_AUTHORITY.FILESYSTEM_NAME_CHARS * 2),
      WINDOWS_VOLUME_AUTHORITY.FILESYSTEM_NAME_CHARS,
    )
  )
    throw volumeError("GetVolumeInformationW", binding);
  if (((flags[0] ?? 0) & WINDOWS_VOLUME_AUTHORITY.FILE_PERSISTENT_ACLS) === 0)
    durabilityError("unsupported", "Windows authority volume lacks persistent ACLs");
}

export function trustedWindowsSystemRoot(
  binding: WindowsVolumeNativeBindings = loadWindowsVolumeNativeBindings(),
): string {
  const output = Buffer.alloc(WINDOWS_VOLUME_AUTHORITY.DIRECTORY_BUFFER_CHARS * 2);
  const length = binding.windowsDirectory(output, WINDOWS_VOLUME_AUTHORITY.DIRECTORY_BUFFER_CHARS);
  if (length < 1 || length >= WINDOWS_VOLUME_AUTHORITY.DIRECTORY_BUFFER_CHARS)
    durabilityError("unsupported", "trusted Windows system directory query failed");
  const root = windowsPath.normalize(output.subarray(0, length * 2).toString("utf16le"));
  assertWindowsLocalRecordPath(root, binding);
  return root;
}
