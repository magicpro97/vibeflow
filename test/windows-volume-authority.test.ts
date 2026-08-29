import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WINDOWS_FFI_RUNTIME,
  type WindowsFfiRuntime,
} from "../src/dispatch/windows-ffi-runtime.js";
import {
  WINDOWS_VOLUME_AUTHORITY,
  assertWindowsLocalRecordPath,
  loadWindowsVolumeNativeBindings,
  trustedWindowsSystemRoot,
} from "../src/dispatch/windows-volume-authority.js";

const WIDE_ROOT = Buffer.from("C:\\\0", "utf16le");

type OutSlot = { [index: number]: number };
type Dispatch = Record<string, (...args: any[]) => unknown>;

interface VolumeState {
  driveType: number;
  volumeResult: number;
  flags: number;
  serial: number;
  component: number;
  directoryResult: string | null;
}

function volumeState() {
  const state: VolumeState = {
    driveType: WINDOWS_VOLUME_AUTHORITY.DRIVE_FIXED,
    volumeResult: 1,
    flags: WINDOWS_VOLUME_AUTHORITY.FILE_PERSISTENT_ACLS,
    serial: 0,
    component: 0,
    directoryResult: "C:\\Windows",
  };
  const calls: string[] = [];
  const dispatch: Dispatch = {
    GetDriveTypeW: (_root: Buffer) => {
      calls.push("drive");
      return state.driveType;
    },
    GetVolumeInformationW: (
      _root: Buffer,
      _volume: Buffer,
      _volumeChars: number,
      outSerial: OutSlot,
      outComponent: OutSlot,
      outFlags: OutSlot,
      _filesystem: Buffer,
      _filesystemChars: number,
    ) => {
      calls.push("volume");
      outSerial[0] = state.serial++;
      outComponent[0] = state.component++;
      outFlags[0] = state.flags;
      return state.volumeResult;
    },
    GetWindowsDirectoryW: (output: Buffer, _chars: number) => {
      calls.push("directory");
      if (state.directoryResult === null) return 0;
      output.write(state.directoryResult, "utf16le");
      return state.directoryResult.length;
    },
    GetLastError: () => 5,
  };
  return {
    calls,
    dispatch,
    setDriveType: (value: number) => {
      state.driveType = value;
    },
    setVolumeResult: (value: number) => {
      state.volumeResult = value;
    },
    setFlags: (value: number) => {
      state.flags = value;
    },
    setDirectoryResult: (value: string | null) => {
      state.directoryResult = value;
    },
  };
}

function fakeKoffi(dispatch: Dispatch): unknown {
  const library = {
    func:
      (_convention: string, name: string, ..._rest: unknown[]) =>
      (...args: unknown[]) =>
        dispatch[name]?.(...args) ?? 1,
  };
  return {
    load: () => library,
    pointer: (value: unknown) => ({ pointer: value }),
    out: (value: unknown) => ({ out: value }),
  };
}

function fakeBunFfi(dispatch: Dispatch): unknown {
  return {
    FFIType: { ptr: 1, u32: 2, i32: 3 },
    dlopen: () => ({
      symbols: Object.fromEntries(
        Object.keys(dispatch).map((name) => [
          name,
          (...args: unknown[]) => dispatch[name]?.(...args) ?? 1,
        ]),
      ),
    }),
  };
}

function commonBranchAssertions(
  runtime: WindowsFfiRuntime,
  state: ReturnType<typeof volumeState>,
  expectedCalls: string[],
) {
  const binding = loadWindowsVolumeNativeBindings(runtime);
  expect(() => assertWindowsLocalRecordPath("C:\\state", binding)).not.toThrow();
  expect(trustedWindowsSystemRoot(binding)).toBe("C:\\Windows");
  expect(state.calls).toEqual(expectedCalls);
  state.setDriveType(4);
  expect(() => assertWindowsLocalRecordPath("C:\\state", binding)).toThrow("fixed local drive");
  state.setDriveType(WINDOWS_VOLUME_AUTHORITY.DRIVE_FIXED);
  state.setVolumeResult(0);
  expect(() => assertWindowsLocalRecordPath("C:\\state", binding)).toThrow(
    "GetVolumeInformationW failed with Windows error 5",
  );
  state.setVolumeResult(1);
  state.setFlags(0);
  expect(() => assertWindowsLocalRecordPath("C:\\state", binding)).toThrow("lacks persistent ACLs");
  state.setFlags(WINDOWS_VOLUME_AUTHORITY.FILE_PERSISTENT_ACLS);
  state.setDirectoryResult(null);
  expect(() => trustedWindowsSystemRoot(binding)).toThrow("query failed");
}

describe("windows volume authority native bindings", () => {
  test("default runtime exposes the current platform beside bun:ffi and koffi loaders", () => {
    expect(DEFAULT_WINDOWS_FFI_RUNTIME.isBun).toBe(true);
    expect(DEFAULT_WINDOWS_FFI_RUNTIME.requireModule).toBeTypeOf("function");
    expect(DEFAULT_WINDOWS_FFI_RUNTIME.requireModule("bun:ffi")).toBeTypeOf("object");
  });

  test("runs fixed-drive ACL checks through the koffi runtime", () => {
    const state = volumeState();
    commonBranchAssertions(
      { isBun: false, requireModule: () => fakeKoffi(state.dispatch) },
      state,
      ["drive", "volume", "directory", "drive", "volume"],
    );
  });

  test("runs fixed-drive ACL checks through the builtin Bun FFI runtime", () => {
    const state = volumeState();
    commonBranchAssertions(
      { isBun: true, requireModule: () => fakeBunFfi(state.dispatch) },
      state,
      ["drive", "volume", "directory", "drive", "volume"],
    );
  });

  test("propagates volume out-parameters through the Bun FFI wrappers", () => {
    const state = volumeState();
    const binding = loadWindowsVolumeNativeBindings({
      isBun: true,
      requireModule: () => fakeBunFfi(state.dispatch),
    });
    expect(binding.driveType(WIDE_ROOT)).toBe(WINDOWS_VOLUME_AUTHORITY.DRIVE_FIXED);
    const serial = [0];
    const component = [0];
    const flags = [0];
    expect(
      binding.volumeInformation(
        WIDE_ROOT,
        Buffer.alloc(WINDOWS_VOLUME_AUTHORITY.VOLUME_NAME_CHARS * 2),
        WINDOWS_VOLUME_AUTHORITY.VOLUME_NAME_CHARS,
        serial,
        component,
        flags,
        Buffer.alloc(WINDOWS_VOLUME_AUTHORITY.FILESYSTEM_NAME_CHARS * 2),
        WINDOWS_VOLUME_AUTHORITY.FILESYSTEM_NAME_CHARS,
      ),
    ).toBe(1);
    expect(serial[0]).toBe(0);
    expect(component[0]).toBe(0);
    expect(flags[0]).toBe(WINDOWS_VOLUME_AUTHORITY.FILE_PERSISTENT_ACLS);
    const output = Buffer.alloc(WINDOWS_VOLUME_AUTHORITY.DIRECTORY_BUFFER_CHARS * 2);
    expect(binding.windowsDirectory(output, WINDOWS_VOLUME_AUTHORITY.DIRECTORY_BUFFER_CHARS)).toBe(
      10,
    );
    expect(output.subarray(0, 20).toString("utf16le")).toBe("C:\\Windows");
    expect(binding.lastError()).toBe(5);
  });
});
