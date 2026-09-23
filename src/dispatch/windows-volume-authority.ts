// Re-export from durability — moved to avoid dispatch→durability layer inversion.
export {
  WINDOWS_VOLUME_AUTHORITY,
  type WindowsVolumeNativeBindings,
  loadWindowsVolumeNativeBindings,
  assertWindowsLocalRecordPath,
  trustedWindowsSystemRoot,
} from "../durability/windows-volume-authority.js";
