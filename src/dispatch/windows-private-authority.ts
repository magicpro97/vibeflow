// Re-export from durability — moved to avoid dispatch→durability layer inversion.
export {
  WINDOWS_AUTHORITY_PATH_KIND,
  WINDOWS_PRIVATE_SECURITY,
  type WindowsAuthorityPathKind,
  type WindowsPrivateAce,
  type WindowsPrivateDescriptorView,
  type WindowsCreationSecurity,
  type WindowsPrivateAuthorityBindings,
  type WindowsPrivateAuthority,
  type WindowsSecurityNativeRuntime,
  createWindowsPrivateAuthority,
  descriptorAllowsForeignWrite,
  foreignWriteAce,
  formatWindowsSid,
  loadWindowsPrivateAuthorityBindings,
} from "../durability/windows-private-authority.js";
