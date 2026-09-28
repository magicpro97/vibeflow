import { durabilityError } from "../durability/errors.js";
import { WINDOWS_FILE_NATIVE } from "./windows-native-contract.js";

const WINDOWS_PATH_AUTHORITY = WINDOWS_FILE_NATIVE;
import type {
  WindowsNativeHandle,
  WindowsPathNativeBindings,
} from "./windows-path-native-bindings.js";
import {
  WINDOWS_AUTHORITY_PATH_KIND,
  type WindowsAuthorityPathKind,
} from "./windows-private-authority.js";

export interface WindowsPathIdentity {
  value: string;
  size: bigint;
}

export interface WindowsPathNativeInfo extends WindowsPathIdentity {
  /** The FileIdInfo bytes every re-read is compared against, so a replaced object is a different answer. */
  raw: Buffer;
}

type Checked = (binding: WindowsPathNativeBindings, operation: string, result: number) => void;

/** Read one handle's identity, and refuse anything that is not the plain object the caller opened. */
export function queryInfo(
  binding: WindowsPathNativeBindings,
  handle: WindowsNativeHandle,
  expected: WindowsAuthorityPathKind,
  checked: Checked,
): WindowsPathNativeInfo {
  const attributes = Buffer.alloc(WINDOWS_PATH_AUTHORITY.ATTRIBUTE_INFO_BYTES);
  checked(
    binding,
    "GetFileInformationByHandleEx(AttributeTagInfo)",
    binding.fileInfo(
      handle,
      WINDOWS_PATH_AUTHORITY.ATTRIBUTE_TAG_CLASS,
      attributes,
      attributes.length,
    ),
  );
  const flags = attributes.readUInt32LE(0);
  if ((flags & WINDOWS_PATH_AUTHORITY.FILE_ATTRIBUTE_REPARSE_POINT) !== 0)
    durabilityError("unsafe_path", "Windows authority reparse point rejected");
  const standard = Buffer.alloc(WINDOWS_PATH_AUTHORITY.STANDARD_INFO_BYTES);
  checked(
    binding,
    "GetFileInformationByHandleEx(FileStandardInfo)",
    binding.fileInfo(handle, WINDOWS_PATH_AUTHORITY.STANDARD_INFO_CLASS, standard, standard.length),
  );
  const directory =
    (flags & WINDOWS_PATH_AUTHORITY.FILE_ATTRIBUTE_DIRECTORY) !== 0 &&
    standard.readUInt8(WINDOWS_PATH_AUTHORITY.STANDARD_DIRECTORY_OFFSET) !== 0;
  if (directory !== (expected === WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY))
    durabilityError("unsafe_path", "Windows authority path type changed");
  const links = standard.readUInt32LE(WINDOWS_PATH_AUTHORITY.STANDARD_LINKS_OFFSET);
  if (
    links < 1 ||
    (!directory && links !== 1) ||
    standard.readUInt8(WINDOWS_PATH_AUTHORITY.STANDARD_DELETE_PENDING_OFFSET) !== 0
  )
    durabilityError("unsafe_path", "unsafe Windows authority link state");
  const raw = Buffer.alloc(WINDOWS_PATH_AUTHORITY.FILE_ID_INFO_BYTES);
  checked(
    binding,
    "GetFileInformationByHandleEx(FileIdInfo)",
    binding.fileInfo(handle, WINDOWS_PATH_AUTHORITY.FILE_ID_INFO_CLASS, raw, raw.length),
  );
  if (raw.subarray(8).every((byte) => byte === 0))
    durabilityError("unsafe_path", "Windows authority identity is unavailable");
  return {
    raw,
    value: raw.toString("hex"),
    size: standard.readBigInt64LE(WINDOWS_PATH_AUTHORITY.STANDARD_SIZE_OFFSET),
  };
}
