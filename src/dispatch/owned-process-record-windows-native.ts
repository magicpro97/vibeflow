// Re-export from durability — moved to avoid dispatch→durability layer inversion.
export {
  assertWindowsLocalRecordPath,
  trustedWindowsSystemRoot,
} from "../durability/windows-volume-authority.js";
export {
  WINDOWS_NATIVE_RECORD,
  type WindowsRecordNativeBindings,
  type WindowsKernelLock,
  type WindowsKernelLockProvider,
  loadWindowsRecordNativeBindings,
  createWindowsKernelLockProvider,
} from "../durability/windows-kernel-lock.js";

// These interfaces/types are still needed by other dispatch consumers.
export type {
  WindowsRecordRenameOptions,
  WindowsRecordRename,
} from "./owned-process-record-windows-rename.js";
export { createWindowsWriteThroughRename } from "./owned-process-record-windows-rename.js";
