import { win32 as windowsPath } from "node:path";
import { durabilityError } from "../durability/errors.js";
import {
  WINDOWS_NATIVE_RECORD,
  type WindowsRecordNativeBindings,
  loadWindowsRecordNativeBindings,
} from "../durability/windows-kernel-lock.js";

export interface WindowsRecordRenameOptions {
  replace: boolean;
  writeThrough: true;
}
export type WindowsRecordRename = (
  source: string,
  target: string,
  options: WindowsRecordRenameOptions,
) => void;

function widePath(path: string): Buffer {
  const absolute = windowsPath.resolve(path);
  const extended = absolute.startsWith("\\\\")
    ? `\\\\?\\UNC\\${absolute.slice(2)}`
    : `\\\\?\\${absolute}`;
  return Buffer.from(`${extended}\0`, "utf16le");
}

function nativeError(operation: string, nativeCode: number): NodeJS.ErrnoException {
  const error = new Error(
    `${operation} failed with Windows error ${nativeCode}`,
  ) as NodeJS.ErrnoException;
  error.code =
    nativeCode === WINDOWS_NATIVE_RECORD.ERROR_FILE_NOT_FOUND ||
    nativeCode === WINDOWS_NATIVE_RECORD.ERROR_PATH_NOT_FOUND
      ? "ENOENT"
      : nativeCode === WINDOWS_NATIVE_RECORD.ERROR_FILE_EXISTS ||
          nativeCode === WINDOWS_NATIVE_RECORD.ERROR_ALREADY_EXISTS
        ? "EEXIST"
        : nativeCode === WINDOWS_NATIVE_RECORD.ERROR_SHARING_VIOLATION
          ? "EBUSY"
          : "EACCES";
  return error;
}

export function createWindowsWriteThroughRename(
  binding: WindowsRecordNativeBindings = loadWindowsRecordNativeBindings(),
): WindowsRecordRename {
  return (source, target, options) => {
    if (!options.writeThrough)
      durabilityError("invalid_value", "Windows rename must be write-through");
    const flags =
      WINDOWS_NATIVE_RECORD.MOVE_WRITE_THROUGH |
      (options.replace ? WINDOWS_NATIVE_RECORD.MOVE_REPLACE_EXISTING : 0);
    if (binding.moveFileEx(widePath(source), widePath(target), flags) === 0)
      throw nativeError("MoveFileExW", binding.lastError());
  };
}
