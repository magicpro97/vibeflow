import { win32 as windowsPath } from "node:path";
import { runCleanups, withCleanup } from "../durability/cleanup.js";
import { durabilityError } from "../durability/errors.js";
import { WINDOWS_FILE_NATIVE } from "./windows-native-contract.js";
import {
  type WindowsNativeHandle,
  type WindowsPathNativeBindings,
  loadWindowsPathNativeBindings,
} from "./windows-path-native-bindings.js";
import {
  WINDOWS_AUTHORITY_PATH_KIND,
  type WindowsAuthorityPathKind,
  type WindowsPrivateAuthority,
  createWindowsPrivateAuthority,
} from "./windows-private-authority.js";

export const WINDOWS_PATH_AUTHORITY = WINDOWS_FILE_NATIVE;
export { loadWindowsPathNativeBindings } from "./windows-path-native-bindings.js";
export type { WindowsPathNativeBindings } from "./windows-path-native-bindings.js";

export interface WindowsPathIdentity {
  value: string;
  size: bigint;
}

export interface WindowsPathAuthority {
  withVerifiedDirectory<T>(path: string, expectedIdentity: string, operation: () => T): T;
  directoryIdentity(path: string, verifyPrivate: boolean): WindowsPathIdentity | null;
  createPrivateDirectory(path: string): void;
  readPrivateFile(path: string, maxBytes: number): Buffer | null;
  writePrivateFile(path: string, bytes: Uint8Array, maxBytes: number): void;
}

interface NativeInfo extends WindowsPathIdentity {
  raw: Buffer;
}

interface OpenedPath {
  handle: WindowsNativeHandle;
  info: NativeInfo;
}

type DirectoryChainResult<T> = { found: true; value: T } | { found: false };

function absoluteDrivePath(path: string): string {
  const absolute = windowsPath.normalize(path);
  if (!windowsPath.isAbsolute(absolute) || !/^[A-Za-z]:\\/u.test(absolute))
    durabilityError("unsafe_path", "Windows authority path must be drive-qualified");
  return absolute;
}

function directoryPrefixes(path: string): string[] {
  const absolute = absoluteDrivePath(path);
  const root = windowsPath.parse(absolute).root;
  const prefixes = [root];
  let cursor = root;
  for (const part of absolute.slice(root.length).split("\\").filter(Boolean)) {
    cursor = windowsPath.join(cursor, part);
    prefixes.push(cursor);
  }
  return prefixes;
}

function widePath(path: string): Buffer {
  return Buffer.from(`\\\\?\\${absoluteDrivePath(path)}\0`, "utf16le");
}

function nativeError(operation: string, code: number): NodeJS.ErrnoException {
  const error = new Error(
    `${operation} failed with Windows error ${code}`,
  ) as NodeJS.ErrnoException;
  error.code =
    code === WINDOWS_PATH_AUTHORITY.ERROR_FILE_NOT_FOUND ||
    code === WINDOWS_PATH_AUTHORITY.ERROR_PATH_NOT_FOUND
      ? "ENOENT"
      : code === WINDOWS_PATH_AUTHORITY.ERROR_FILE_EXISTS ||
          code === WINDOWS_PATH_AUTHORITY.ERROR_ALREADY_EXISTS
        ? "EEXIST"
        : "EACCES";
  return error;
}

function checked(binding: WindowsPathNativeBindings, operation: string, result: number): void {
  if (!result) throw nativeError(operation, binding.lastError());
}

function rollbackThenThrow(primary: unknown, cleanups: readonly (() => void)[]): never {
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (primary instanceof Error && primary.cause === undefined && failures.length > 0)
    primary.cause =
      failures.length === 1 ? failures[0] : new AggregateError(failures, "Windows rollback failed");
  throw primary;
}

function queryInfo(
  binding: WindowsPathNativeBindings,
  handle: WindowsNativeHandle,
  expected: WindowsAuthorityPathKind,
): NativeInfo {
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

function flags(kind: WindowsAuthorityPathKind, writeThrough = false): number {
  return (
    (WINDOWS_PATH_AUTHORITY.FILE_FLAG_OPEN_REPARSE_POINT |
      (kind === WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY
        ? WINDOWS_PATH_AUTHORITY.FILE_FLAG_BACKUP_SEMANTICS
        : WINDOWS_PATH_AUTHORITY.FILE_ATTRIBUTE_NORMAL) |
      (writeThrough ? WINDOWS_PATH_AUTHORITY.FILE_FLAG_WRITE_THROUGH : 0)) >>>
    0
  );
}

export function createNativeWindowsPathAuthority(
  binding: WindowsPathNativeBindings = loadWindowsPathNativeBindings(),
  privacy: WindowsPrivateAuthority = createWindowsPrivateAuthority(),
): WindowsPathAuthority {
  const close = (handle: WindowsNativeHandle) =>
    checked(binding, "CloseHandle", binding.closeHandle(handle));
  const open = (
    path: string,
    kind: WindowsAuthorityPathKind,
    verifyPrivate: boolean,
  ): OpenedPath | null => {
    const access =
      kind === WINDOWS_AUTHORITY_PATH_KIND.FILE
        ? WINDOWS_PATH_AUTHORITY.GENERIC_READ >>> 0
        : (WINDOWS_PATH_AUTHORITY.FILE_READ_ATTRIBUTES |
            (verifyPrivate ? WINDOWS_PATH_AUTHORITY.READ_CONTROL : 0)) >>>
          0;
    const handle = binding.createFile(
      widePath(path),
      access,
      kind === WINDOWS_AUTHORITY_PATH_KIND.FILE
        ? WINDOWS_PATH_AUTHORITY.FILE_SHARE_READ
        : WINDOWS_PATH_AUTHORITY.FILE_SHARE_READ | WINDOWS_PATH_AUTHORITY.FILE_SHARE_WRITE,
      null,
      WINDOWS_PATH_AUTHORITY.OPEN_EXISTING,
      flags(kind),
      null,
    );
    if (handle === binding.invalidHandle) {
      const code = binding.lastError();
      if (
        code === WINDOWS_PATH_AUTHORITY.ERROR_FILE_NOT_FOUND ||
        code === WINDOWS_PATH_AUTHORITY.ERROR_PATH_NOT_FOUND
      )
        return null;
      throw nativeError("CreateFileW(authority)", code);
    }
    try {
      const info = queryInfo(binding, handle, kind);
      if (verifyPrivate) privacy.verifyHandle(handle, kind);
      return { handle, info };
    } catch (error) {
      return rollbackThenThrow(error, [() => close(handle)]);
    }
  };
  const withDirectoryChain = <T>(
    path: string,
    verifyFinal: boolean,
    expectedIdentity: string | null,
    operation: (identity: NativeInfo) => T,
  ): DirectoryChainResult<T> => {
    const prefixes = directoryPrefixes(path);
    const held: OpenedPath[] = [];
    const cleanups = () =>
      [...held].reverse().map(
        ({ handle }) =>
          () =>
            close(handle),
      );
    let result: T;
    try {
      for (const [index, prefix] of prefixes.entries()) {
        const opened = open(
          prefix,
          WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY,
          verifyFinal && index === prefixes.length - 1,
        );
        if (!opened) {
          const missingCleanups = cleanups();
          held.length = 0;
          runCleanups(missingCleanups);
          return { found: false };
        }
        held.push(opened);
      }
      const final = held[held.length - 1] as OpenedPath;
      if (expectedIdentity !== null && final.info.value !== expectedIdentity)
        durabilityError("unsafe_path", `storage directory changed: ${path}`);
      result = operation(final.info);
      for (const opened of held) {
        const after = queryInfo(binding, opened.handle, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY);
        if (!after.raw.equals(opened.info.raw))
          durabilityError("unsafe_path", "Windows authority ancestor identity changed");
      }
      const reopened: OpenedPath[] = [];
      try {
        for (const [index, prefix] of prefixes.entries()) {
          const opened = open(prefix, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, false);
          const fresh =
            opened && queryInfo(binding, opened.handle, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY);
          if (!fresh || !fresh.raw.equals((held[index] as OpenedPath).info.raw))
            durabilityError("unsafe_path", `Windows authority path changed: ${prefix}`);
          reopened.push(opened as OpenedPath);
        }
      } finally {
        for (const { handle } of reopened.reverse()) close(handle);
      }
      if (verifyFinal) privacy.verifyHandle(final.handle, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY);
    } catch (error) {
      return rollbackThenThrow(error, cleanups());
    }
    runCleanups(cleanups());
    return { found: true, value: result };
  };
  const requireParent = <T>(path: string, operation: () => T): T => {
    const result = withDirectoryChain(windowsPath.dirname(path), false, null, operation);
    if (!result.found) durabilityError("unsafe_path", `Windows authority parent vanished: ${path}`);
    return result.value;
  };
  const readOpenedFile = (path: string, maxBytes: number): Buffer | null => {
    const opened = open(path, WINDOWS_AUTHORITY_PATH_KIND.FILE, true);
    if (!opened) return null;
    return withCleanup(() => {
      if (opened.info.size < 0n || opened.info.size > BigInt(maxBytes))
        durabilityError("unsafe_path", `unsafe or oversized Windows record: ${path}`);
      const output = Buffer.alloc(Number(opened.info.size));
      for (let offset = 0; offset < output.length; ) {
        const count = [0];
        checked(
          binding,
          "ReadFile",
          binding.readFile(
            opened.handle,
            output.subarray(offset),
            output.length - offset,
            count,
            null,
          ),
        );
        if ((count[0] ?? 0) < 1) durabilityError("corrupt", "short Windows authority read");
        offset += count[0] ?? 0;
      }
      const after = queryInfo(binding, opened.handle, WINDOWS_AUTHORITY_PATH_KIND.FILE);
      if (!after.raw.equals(opened.info.raw) || after.size !== opened.info.size)
        durabilityError("unsafe_path", "Windows authority changed during read");
      privacy.verifyHandle(opened.handle, WINDOWS_AUTHORITY_PATH_KIND.FILE);
      return output;
    }, [() => close(opened.handle)]);
  };
  return {
    withVerifiedDirectory(path, expectedIdentity, operation) {
      const result = withDirectoryChain(path, true, expectedIdentity, () => operation());
      if (!result.found) durabilityError("unsafe_path", `storage directory disappeared: ${path}`);
      return result.value;
    },
    directoryIdentity(path, verifyPrivate) {
      const result = withDirectoryChain(path, verifyPrivate, null, (identity) => identity);
      return result.found ? result.value : null;
    },
    createPrivateDirectory(path) {
      requireParent(path, () => {
        privacy.withCreationSecurity(WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, (security) => {
          checked(binding, "CreateDirectoryW", binding.createDirectory(widePath(path), security));
        });
        const created = open(path, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, true);
        if (!created)
          durabilityError("unsafe_path", "created Windows authority directory vanished");
        withCleanup(() => {
          const after = queryInfo(binding, created.handle, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY);
          if (!after.raw.equals(created.info.raw))
            durabilityError("unsafe_path", "created Windows authority directory changed");
          privacy.verifyHandle(created.handle, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY);
        }, [() => close(created.handle)]);
      });
    },
    readPrivateFile(path, maxBytes) {
      return requireParent(path, () => readOpenedFile(path, maxBytes));
    },
    writePrivateFile(path, bytes, maxBytes) {
      if (bytes.length > maxBytes)
        durabilityError("bounds", "Windows authority value exceeds limit");
      requireParent(path, () => {
        privacy.withCreationSecurity(WINDOWS_AUTHORITY_PATH_KIND.FILE, (security) => {
          const handle = binding.createFile(
            widePath(path),
            (WINDOWS_PATH_AUTHORITY.DELETE_ACCESS |
              WINDOWS_PATH_AUTHORITY.GENERIC_READ |
              WINDOWS_PATH_AUTHORITY.GENERIC_WRITE) >>>
              0,
            WINDOWS_PATH_AUTHORITY.FILE_SHARE_NONE,
            security,
            WINDOWS_PATH_AUTHORITY.CREATE_NEW,
            flags(WINDOWS_AUTHORITY_PATH_KIND.FILE, true),
            null,
          );
          if (handle === binding.invalidHandle)
            throw nativeError("CreateFileW(create authority)", binding.lastError());
          try {
            privacy.verifyHandle(handle, WINDOWS_AUTHORITY_PATH_KIND.FILE);
            const created = queryInfo(binding, handle, WINDOWS_AUTHORITY_PATH_KIND.FILE);
            for (let offset = 0; offset < bytes.length; ) {
              const count = [0];
              checked(
                binding,
                "WriteFile",
                binding.writeFile(
                  handle,
                  bytes.subarray(offset),
                  bytes.length - offset,
                  count,
                  null,
                ),
              );
              if ((count[0] ?? 0) < 1)
                durabilityError("corrupt", "Windows authority write made no progress");
              offset += count[0] ?? 0;
            }
            checked(binding, "FlushFileBuffers", binding.flushFile(handle));
            const after = queryInfo(binding, handle, WINDOWS_AUTHORITY_PATH_KIND.FILE);
            if (!after.raw.equals(created.raw) || after.size !== BigInt(bytes.length))
              durabilityError("corrupt", "Windows authority durable write changed");
          } catch (primary) {
            const disposition = Buffer.alloc(WINDOWS_PATH_AUTHORITY.FILE_DISPOSITION_INFO_BYTES, 1);
            return rollbackThenThrow(primary, [
              () =>
                checked(
                  binding,
                  "SetFileInformationByHandle(FileDispositionInfo)",
                  binding.setFileInfo(
                    handle,
                    WINDOWS_PATH_AUTHORITY.FILE_DISPOSITION_INFO_CLASS,
                    disposition,
                    disposition.length,
                  ),
                ),
              () => close(handle),
            ]);
          }
          close(handle);
        });
        if (!readOpenedFile(path, maxBytes)?.equals(bytes))
          durabilityError("corrupt", "Windows durable staging verification failed");
      });
    },
  };
}
