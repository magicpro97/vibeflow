import { timingSafeEqual } from "node:crypto";
import { win32 as windowsPath } from "node:path";
import { cleanupThenThrow, runCleanups } from "./cleanup.js";
import { durabilityError } from "./errors.js";
import { DEFAULT_WINDOWS_FFI_RUNTIME, type WindowsFfiRuntime } from "./windows-ffi-runtime.js";
import { windowsFfiAddressing } from "./windows-ffi-runtime.js";
import { loadWindowsRecordNativeBindingsKoffi } from "./windows-kernel-lock-koffi.js";
import { WINDOWS_FILE_NATIVE } from "./windows-native-contract.js";
import {
  WINDOWS_AUTHORITY_PATH_KIND,
  type WindowsPrivateAuthority,
  createWindowsPrivateAuthority,
} from "./windows-private-authority.js";
import {
  WINDOWS_VOLUME_AUTHORITY,
  type WindowsVolumeNativeBindings,
  loadWindowsVolumeNativeBindings,
} from "./windows-volume-authority.js";

export const WINDOWS_NATIVE_RECORD = Object.freeze({
  ...WINDOWS_VOLUME_AUTHORITY,
  ...WINDOWS_FILE_NATIVE,
  MOVE_REPLACE_EXISTING: 0x1,
  MOVE_WRITE_THROUGH: 0x8,
  LOCKFILE_FAIL_IMMEDIATELY: 0x1,
  LOCKFILE_EXCLUSIVE_LOCK: 0x2,
  // The lock is a single sentinel byte parked far past any record payload.
  //
  // LockFileEx is MANDATORY, unlike POSIX flock which is advisory: a locked byte range cannot be
  // written even by the owning process through a different descriptor. acquireProcessLock holds
  // this lock and then writes the lock record through its own Node fd, so a range covering the
  // record (offset 0) makes the owner's own write fail with EBUSY. Locking one byte at 2^40
  // leaves the record bytes writable while still excluding every other process, which only ever
  // contends for this same byte.
  LOCK_SENTINEL_OFFSET_HIGH: 0x100,
  LOCK_SENTINEL_OFFSET_LOW: 0x0,
  LOCK_SENTINEL_BYTES: 0x1,
} as const);

type Handle = bigint;
type Overlapped = {
  Internal: number;
  InternalHigh: number;
  Offset: number;
  OffsetHigh: number;
  hEvent: null;
};

export interface WindowsRecordNativeBindings extends WindowsVolumeNativeBindings {
  invalidHandle: Handle;
  createFile: (
    path: Buffer,
    access: number,
    share: number,
    security: unknown,
    creation: number,
    flags: number,
    template: null,
  ) => Handle;
  lockFile: (
    handle: Handle,
    flags: number,
    reserved: number,
    low: number,
    high: number,
    overlapped: Overlapped,
  ) => number;
  unlockFile: (
    handle: Handle,
    reserved: number,
    low: number,
    high: number,
    overlapped: Overlapped,
  ) => number;
  moveFileEx: (source: Buffer, target: Buffer, flags: number) => number;
  flushFile: (handle: Handle) => number;
  closeHandle: (handle: Handle) => number;
  fileInfo: (
    handle: Handle,
    informationClass: number,
    output: Buffer,
    outputBytes: number,
  ) => number;
}

export interface WindowsKernelLock {
  assertHeld(): void;
  release(): void;
}
export interface WindowsKernelLockProvider {
  tryAcquire(path: string): WindowsKernelLock | null;
}

function encodeOverlapped(overlapped: Overlapped): Buffer {
  const buffer = Buffer.alloc(32);
  buffer.writeBigUInt64LE(BigInt(overlapped.Internal), 0);
  buffer.writeBigUInt64LE(BigInt(overlapped.InternalHigh), 8);
  buffer.writeUInt32LE(overlapped.Offset, 16);
  buffer.writeUInt32LE(overlapped.OffsetHigh, 20);
  buffer.writeBigUInt64LE(0n, 24);
  return buffer;
}

export function loadWindowsRecordNativeBindings(
  runtime: WindowsFfiRuntime = DEFAULT_WINDOWS_FFI_RUNTIME,
): WindowsRecordNativeBindings {
  const volume = loadWindowsVolumeNativeBindings(runtime);
  if (runtime.isBun) {
    const ffi = runtime.requireModule("bun:ffi") as typeof import("bun:ffi");
    const t = ffi.FFIType;
    const { address } = windowsFfiAddressing(ffi);
    // Win32 hands HANDLEs back as plain integers and Bun refuses to coerce an integer into an
    // FFIType.ptr argument, so every handle/pointer argument is declared u64 and addressed.
    const kernel32 = ffi.dlopen("Kernel32.dll", {
      CreateFileW: { args: [t.u64, t.u32, t.u32, t.u64, t.u32, t.u32, t.u64], returns: t.u64 },
      LockFileEx: { args: [t.u64, t.u32, t.u32, t.u32, t.u32, t.u64], returns: t.i32 },
      UnlockFileEx: { args: [t.u64, t.u32, t.u32, t.u32, t.u64], returns: t.i32 },
      MoveFileExW: { args: [t.u64, t.u64, t.u32], returns: t.i32 },
      FlushFileBuffers: { args: [t.u64], returns: t.i32 },
      CloseHandle: { args: [t.u64], returns: t.i32 },
      GetFileInformationByHandleEx: { args: [t.u64, t.i32, t.u64, t.u32], returns: t.i32 },
    });
    return {
      ...volume,
      invalidHandle: 0xffff_ffff_ffff_ffffn,
      createFile: (path, access, share, security, creation, flags, template) =>
        kernel32.symbols.CreateFileW(
          address(path),
          access,
          share,
          address(security),
          creation,
          flags,
          address(template),
        ) as bigint,
      lockFile: (handle, flags, reserved, low, high, overlapped) =>
        kernel32.symbols.LockFileEx(
          address(handle),
          flags,
          reserved,
          low,
          high,
          address(encodeOverlapped(overlapped)),
        ),
      unlockFile: (handle, reserved, low, high, overlapped) =>
        kernel32.symbols.UnlockFileEx(
          address(handle),
          reserved,
          low,
          high,
          address(encodeOverlapped(overlapped)),
        ),
      moveFileEx: (source, target, flags) =>
        kernel32.symbols.MoveFileExW(address(source), address(target), flags),
      flushFile: (handle) => kernel32.symbols.FlushFileBuffers(address(handle)),
      closeHandle: (handle) => kernel32.symbols.CloseHandle(address(handle)),
      fileInfo: (handle, informationClass, output, outputBytes) =>
        kernel32.symbols.GetFileInformationByHandleEx(
          address(handle),
          informationClass,
          address(output),
          outputBytes,
        ),
    };
  }
  return loadWindowsRecordNativeBindingsKoffi(runtime, volume);
}

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

function checked(binding: WindowsRecordNativeBindings, operation: string, result: number): void {
  if (result === 0) throw nativeError(operation, binding.lastError());
}

function fileIdentity(binding: WindowsRecordNativeBindings, handle: Handle): Buffer {
  const attributes = Buffer.alloc(WINDOWS_NATIVE_RECORD.ATTRIBUTE_INFO_BYTES);
  checked(
    binding,
    "GetFileInformationByHandleEx(AttributeTagInfo)",
    binding.fileInfo(
      handle,
      WINDOWS_NATIVE_RECORD.ATTRIBUTE_TAG_CLASS,
      attributes,
      attributes.length,
    ),
  );
  const flags = attributes.readUInt32LE(0);
  if (
    (flags & WINDOWS_NATIVE_RECORD.FILE_ATTRIBUTE_DIRECTORY) !== 0 ||
    (flags & WINDOWS_NATIVE_RECORD.FILE_ATTRIBUTE_REPARSE_POINT) !== 0
  )
    durabilityError("unsafe_path", "unsafe Windows kernel lock file");
  const identity = Buffer.alloc(WINDOWS_NATIVE_RECORD.FILE_ID_INFO_BYTES);
  checked(
    binding,
    "GetFileInformationByHandleEx(FileIdInfo)",
    binding.fileInfo(handle, WINDOWS_NATIVE_RECORD.FILE_ID_INFO_CLASS, identity, identity.length),
  );
  const standard = Buffer.alloc(WINDOWS_NATIVE_RECORD.STANDARD_INFO_BYTES);
  checked(
    binding,
    "GetFileInformationByHandleEx(FileStandardInfo)",
    binding.fileInfo(handle, WINDOWS_NATIVE_RECORD.STANDARD_INFO_CLASS, standard, standard.length),
  );
  if (standard.readUInt32LE(WINDOWS_NATIVE_RECORD.STANDARD_LINKS_OFFSET) !== 1)
    durabilityError("unsafe_path", "multiply-linked Windows kernel lock file");
  if (standard.readUInt8(WINDOWS_NATIVE_RECORD.STANDARD_DELETE_PENDING_OFFSET) !== 0)
    durabilityError("unsafe_path", "delete-pending Windows kernel lock file");
  if (identity.subarray(8).every((byte) => byte === 0))
    durabilityError("unsafe_path", "Windows kernel lock file identity is unavailable");
  return identity;
}

const newOverlapped = (): Overlapped => ({
  Internal: 0,
  InternalHigh: 0,
  Offset: WINDOWS_NATIVE_RECORD.LOCK_SENTINEL_OFFSET_LOW,
  OffsetHigh: WINDOWS_NATIVE_RECORD.LOCK_SENTINEL_OFFSET_HIGH,
  hEvent: null,
});

export function createWindowsKernelLockProvider(
  binding: WindowsRecordNativeBindings = loadWindowsRecordNativeBindings(),
  privateAuthority: WindowsPrivateAuthority | null | undefined = null,
): WindowsKernelLockProvider {
  // Migration is by path: SetNamedSecurityInfoW replaces the DACL, while SetSecurityInfo on a
  // READ_CONTROL|WRITE_DAC handle returns success and changes nothing (measured on Windows 11).
  const migrateIfNeeded = (path: string): void => {
    if (!privateAuthority) return;
    privateAuthority.migrateToOwnerOnly(path, WINDOWS_AUTHORITY_PATH_KIND.FILE);
  };
  // A lock file is held to the weaker policy: it may keep the DACL it inherited from the profile
  // directory (SYSTEM, Administrators, owner), which is what a POSIX 0755 lock directory grants
  // too. verifyHandle's owner-only rule stays on the data files whose contents are the boundary —
  // applying it here rejects every pre-existing install on the first CreateFileW that opens an
  // existing lock instead of creating one (see #807).
  return {
    tryAcquire(path) {
      const create = (security: unknown) => {
        const created = binding.createFile(
          widePath(path),
          (WINDOWS_NATIVE_RECORD.GENERIC_READ | WINDOWS_NATIVE_RECORD.GENERIC_WRITE) >>> 0,
          WINDOWS_NATIVE_RECORD.FILE_SHARE_READ | WINDOWS_NATIVE_RECORD.FILE_SHARE_WRITE,
          security,
          WINDOWS_NATIVE_RECORD.OPEN_ALWAYS,
          (WINDOWS_NATIVE_RECORD.FILE_ATTRIBUTE_NORMAL |
            WINDOWS_NATIVE_RECORD.FILE_FLAG_OPEN_REPARSE_POINT |
            WINDOWS_NATIVE_RECORD.FILE_FLAG_WRITE_THROUGH) >>>
            0,
          null,
        );
        if (created === binding.invalidHandle)
          throw nativeError("CreateFileW", binding.lastError());
        return created;
      };
      let closed = false;
      const handle = privateAuthority
        ? privateAuthority.withCreationSecurity(WINDOWS_AUTHORITY_PATH_KIND.FILE, create)
        : create(null);
      if (privateAuthority) {
        try {
          privateAuthority.verifyNoForeignWrite(handle);
        } catch (verifyError) {
          closed = true;
          // The rewrite below is by path and an open handle does not hold the name (measured: a
          // rename and a delete both succeed with it), so the object is pinned first (issue #811).
          let pinned: Buffer | null = null;
          try {
            pinned = fileIdentity(binding, handle);
          } catch {
            /* An object the handle cannot identify is not one to repair. */
          }
          try {
            binding.closeHandle(handle);
          } catch {
            /* non-fatal */
          }
          const msg = verifyError instanceof Error ? verifyError.message : String(verifyError);
          if (!msg.includes("permissive Windows authority DACL rejected")) throw verifyError;
          if (pinned === null) throw verifyError;
          // A lock file that does grant write to another principal is repaired in place, then
          // re-checked: the owner-only migration is a superset of the policy it has to satisfy.
          migrateIfNeeded(path);
          const final = create(null);
          try {
            // A substitute has no pin, so a repair that landed elsewhere is refused, not accepted.
            if (!timingSafeEqual(pinned, fileIdentity(binding, final)))
              durabilityError("unsafe_path", "Windows kernel lock identity changed mid-migration");
            privateAuthority.verifyNoForeignWrite(final);
          } catch {
            try {
              binding.closeHandle(final);
            } catch {
              /* ignore */
            }
            throw verifyError;
          }
          return acquireVerifiedHandle(final, binding);
        }
      }
      return acquireVerifiedHandle(handle, binding);
    },
  };
}

function acquireVerifiedHandle(
  handle: bigint,
  binding: WindowsRecordNativeBindings,
): WindowsKernelLock | null {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    checked(binding, "CloseHandle", binding.closeHandle(handle));
  };
  try {
    const identity = fileIdentity(binding, handle);
    checked(binding, "FlushFileBuffers", binding.flushFile(handle));
    const overlapped = newOverlapped();
    if (
      binding.lockFile(
        handle,
        WINDOWS_NATIVE_RECORD.LOCKFILE_EXCLUSIVE_LOCK |
          WINDOWS_NATIVE_RECORD.LOCKFILE_FAIL_IMMEDIATELY,
        0,
        WINDOWS_NATIVE_RECORD.LOCK_SENTINEL_BYTES,
        0,
        overlapped,
      ) === 0
    ) {
      const code = binding.lastError();
      const primary = nativeError("LockFileEx", code);
      if (code === WINDOWS_NATIVE_RECORD.ERROR_LOCK_VIOLATION) {
        close();
        return null;
      }
      return cleanupThenThrow(primary, [close]);
    }
    let released = false;
    return {
      assertHeld() {
        if (released || !timingSafeEqual(identity, fileIdentity(binding, handle)))
          durabilityError("lock_lost", "Windows kernel lock ownership lost");
      },
      release() {
        if (released) durabilityError("lock_lost", "Windows kernel lock is released");
        released = true;
        runCleanups([
          () => checked(binding, "FlushFileBuffers", binding.flushFile(handle)),
          () =>
            checked(
              binding,
              "UnlockFileEx",
              binding.unlockFile(
                handle,
                0,
                WINDOWS_NATIVE_RECORD.LOCK_SENTINEL_BYTES,
                0,
                overlapped,
              ),
            ),
          close,
        ]);
      },
    };
  } catch (error) {
    if (!closed) {
      try {
        close();
      } catch {
        /* Preserve the primary native failure. */
      }
    }
    throw error;
  }
}
