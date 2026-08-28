import { describe, expect, test } from "bun:test";
import { WINDOWS_FILE_NATIVE } from "../src/dispatch/windows-native-contract.js";
import {
  WINDOWS_PATH_AUTHORITY,
  type WindowsPathNativeBindings,
  createNativeWindowsPathAuthority,
  loadWindowsPathNativeBindings,
} from "../src/dispatch/windows-path-authority.js";
import {
  WINDOWS_AUTHORITY_PATH_KIND,
  type WindowsPrivateAuthority,
} from "../src/dispatch/windows-private-authority.js";

interface Entry {
  directory: boolean;
  bytes: Buffer;
  id: Buffer;
  links: number;
  reparse: boolean;
  deletePending: boolean;
}

const identity = (value: bigint): Buffer => {
  const output = Buffer.alloc(WINDOWS_PATH_AUTHORITY.FILE_ID_INFO_BYTES);
  output.writeBigUInt64LE(1n, 0);
  output.writeBigUInt64LE(value, 8);
  output.writeBigUInt64LE(7n, 16);
  return output;
};

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing ${label} fixture`);
  return value;
}

function nativeFixture() {
  const entries = new Map<string, Entry>();
  const handles = new Map<bigint, { path: string; offset: number; deleteOnClose: boolean }>();
  const calls = {
    create: [] as unknown[][],
    close: 0,
    closed: [] as bigint[],
    flush: 0,
    security: [] as unknown[],
  };
  let nextHandle = 10n;
  let nextIdentity = 100n;
  let lastError = 2;
  let mutateAfterRead: (() => void) | undefined;
  let readZero = false;
  let writeFailure = false;
  let writeCalls = 0;
  let dispositionFailure = false;
  let closeFailure = false;
  entries.set("C:\\", {
    directory: true,
    bytes: Buffer.alloc(0),
    id: identity(nextIdentity++),
    links: 1,
    reparse: false,
    deletePending: false,
  });
  const path = (wide: Buffer) =>
    wide
      .toString("utf16le")
      .replace(/\0+$/u, "")
      .replace(/^\\\\\?\\/u, "");
  const binding: WindowsPathNativeBindings = {
    invalidHandle: -1n,
    createFile: (...args) => {
      calls.create.push(args);
      const name = path(args[0]);
      let entry = entries.get(name);
      if (args[4] === WINDOWS_PATH_AUTHORITY.CREATE_NEW) {
        if (entry) {
          lastError = WINDOWS_PATH_AUTHORITY.ERROR_FILE_EXISTS;
          return -1n;
        }
        entry = {
          directory: false,
          bytes: Buffer.alloc(0),
          id: identity(nextIdentity++),
          links: 1,
          reparse: false,
          deletePending: false,
        };
        entries.set(name, entry);
      }
      if (!entry) {
        lastError = WINDOWS_PATH_AUTHORITY.ERROR_FILE_NOT_FOUND;
        return -1n;
      }
      const handle = nextHandle++;
      handles.set(handle, { path: name, offset: 0, deleteOnClose: false });
      return handle;
    },
    createDirectory: (wide, security) => {
      const name = path(wide);
      if (entries.has(name)) {
        lastError = WINDOWS_PATH_AUTHORITY.ERROR_ALREADY_EXISTS;
        return 0;
      }
      calls.security.push(security);
      entries.set(name, {
        directory: true,
        bytes: Buffer.alloc(0),
        id: identity(nextIdentity++),
        links: 1,
        reparse: false,
        deletePending: false,
      });
      return 1;
    },
    fileInfo: (handle, kind, output) => {
      const opened = handles.get(handle);
      const entry = opened && entries.get(opened.path);
      if (!entry) return 0;
      if (kind === WINDOWS_PATH_AUTHORITY.ATTRIBUTE_TAG_CLASS) {
        output.writeUInt32LE(
          (entry.directory ? WINDOWS_PATH_AUTHORITY.FILE_ATTRIBUTE_DIRECTORY : 0) |
            (entry.reparse ? WINDOWS_PATH_AUTHORITY.FILE_ATTRIBUTE_REPARSE_POINT : 0),
          0,
        );
      } else if (kind === WINDOWS_PATH_AUTHORITY.STANDARD_INFO_CLASS) {
        output.writeBigInt64LE(
          BigInt(entry.bytes.length),
          WINDOWS_PATH_AUTHORITY.STANDARD_SIZE_OFFSET,
        );
        output.writeUInt32LE(entry.links, WINDOWS_PATH_AUTHORITY.STANDARD_LINKS_OFFSET);
        output.writeUInt8(
          Number(entry.deletePending),
          WINDOWS_PATH_AUTHORITY.STANDARD_DELETE_PENDING_OFFSET,
        );
        output.writeUInt8(
          Number(entry.directory),
          WINDOWS_PATH_AUTHORITY.STANDARD_DIRECTORY_OFFSET,
        );
      } else if (kind === WINDOWS_PATH_AUTHORITY.FILE_ID_INFO_CLASS) entry.id.copy(output);
      return 1;
    },
    readFile: (handle, output, bytes, read) => {
      const opened = required(handles.get(handle), "opened handle");
      const entry = required(entries.get(opened.path), "opened entry");
      if (readZero) {
        read[0] = 0;
        return 1;
      }
      const count = Math.min(bytes, entry.bytes.length - opened.offset);
      entry.bytes.copy(output, 0, opened.offset, opened.offset + count);
      opened.offset += count;
      read[0] = count;
      mutateAfterRead?.();
      mutateAfterRead = undefined;
      return 1;
    },
    writeFile: (handle, input, bytes, written) => {
      const opened = required(handles.get(handle), "opened handle");
      const entry = required(entries.get(opened.path), "opened entry");
      if (writeFailure) {
        if (writeCalls++ === 0) {
          entry.bytes = Buffer.concat([entry.bytes, Buffer.from(input.subarray(0, 1))]);
          written[0] = 1;
          return 1;
        }
        lastError = 5;
        return 0;
      }
      entry.bytes = Buffer.concat([entry.bytes, Buffer.from(input.subarray(0, bytes))]);
      written[0] = bytes;
      return 1;
    },
    flushFile: () => {
      calls.flush += 1;
      return 1;
    },
    setFileInfo: (handle, kind, input, bytes) => {
      if (dispositionFailure) {
        lastError = 5;
        return 0;
      }
      const opened = required(handles.get(handle), "opened handle");
      expect(kind).toBe(WINDOWS_PATH_AUTHORITY.FILE_DISPOSITION_INFO_CLASS);
      expect(bytes).toBe(WINDOWS_PATH_AUTHORITY.FILE_DISPOSITION_INFO_BYTES);
      opened.deleteOnClose = input.readUInt8(0) === 1;
      return 1;
    },
    closeHandle: (handle) => {
      calls.closed.push(handle);
      if (closeFailure) {
        calls.close += 1;
        lastError = 6;
        return 0;
      }
      const opened = handles.get(handle);
      if (opened?.deleteOnClose) entries.delete(opened.path);
      handles.delete(handle);
      calls.close += 1;
      return 1;
    },
    lastError: () => lastError,
  };
  let verifyFailure: Error | undefined;
  const privacy: WindowsPrivateAuthority = {
    withCreationSecurity: (_kind, create) => create({ tokenUserOnly: true }),
    verifyHandle: (handle, kind) => {
      calls.security.push([handle, kind]);
      if (verifyFailure) throw verifyFailure;
    },
  };
  return {
    authority: createNativeWindowsPathAuthority(binding, privacy),
    binding,
    calls,
    entries,
    handles,
    path,
    privacy,
    addDirectory: (name: string) => {
      const entry: Entry = {
        directory: true,
        bytes: Buffer.alloc(0),
        id: identity(nextIdentity++),
        links: 1,
        reparse: false,
        deletePending: false,
      };
      entries.set(name, entry);
      return entry;
    },
    setMutateAfterRead: (value: () => void) => {
      mutateAfterRead = value;
    },
    setReadZero: () => {
      readZero = true;
    },
    setWriteFailure: (value: boolean) => {
      writeFailure = value;
      writeCalls = 0;
    },
    setDispositionFailure: (value: boolean) => {
      dispositionFailure = value;
    },
    setCloseFailure: (value: boolean) => {
      closeFailure = value;
    },
    setVerifyFailure: (error: Error | undefined) => {
      verifyFailure = error;
    },
  };
}

type DirectoryMutation = (fixture: ReturnType<typeof nativeFixture>, entry: Entry) => void;

const POST_CALLBACK_MUTATIONS: [string, DirectoryMutation, string][] = [
  [
    "identity",
    (_fixture, entry) => {
      entry.id = identity(8_001n);
    },
    "identity",
  ],
  [
    "reparse state",
    (_fixture, entry) => {
      entry.reparse = true;
    },
    "reparse point",
  ],
  [
    "delete state",
    (_fixture, entry) => {
      entry.deletePending = true;
    },
    "link state",
  ],
  [
    "DACL",
    (fixture) => {
      fixture.setVerifyFailure(new Error("post-callback DACL mutation"));
    },
    "post-callback DACL mutation",
  ],
];

describe("native Windows path authority", () => {
  test("uses the shared Win32 file contract as its only constant authority", () => {
    expect(WINDOWS_PATH_AUTHORITY).toBe(WINDOWS_FILE_NATIVE);
  });

  test("creates private directories and durable files through protected native handles", () => {
    const fixture = nativeFixture();
    fixture.authority.createPrivateDirectory("C:\\authority");
    expect(() => fixture.authority.createPrivateDirectory("C:\\authority")).toThrow(
      "Windows error 183",
    );
    expect(fixture.authority.directoryIdentity("C:\\authority", true)?.value).toHaveLength(48);
    fixture.authority.writePrivateFile("C:\\authority\\record", Buffer.from("value"), 10);
    expect(fixture.authority.readPrivateFile("C:\\authority\\record", 10)?.toString()).toBe(
      "value",
    );
    expect(fixture.calls.flush).toBe(1);
    expect(fixture.calls.create.some((call) => call[3] === null)).toBe(true);
    expect(fixture.calls.create.some((call) => call[3] !== null)).toBe(true);
    expect(
      fixture.calls.create.every(
        (call) => ((call[5] as number) & WINDOWS_PATH_AUTHORITY.FILE_FLAG_OPEN_REPARSE_POINT) !== 0,
      ),
    ).toBe(true);
    expect(fixture.calls.close).toBeGreaterThan(5);
  });

  test("distinguishes colliding Number projections with the full ReFS FileIdInfo", () => {
    const fixture = nativeFixture();
    fixture.authority.writePrivateFile("C:\\authority", Buffer.from("x"), 10);
    const entry = required(fixture.entries.get("C:\\authority"), "authority entry");
    const first = 9_007_199_254_740_992n;
    const second = first + 1n;
    expect(Number(first)).toBe(Number(second));
    entry.id = identity(first);
    fixture.setMutateAfterRead(() => {
      entry.id = identity(second);
    });
    expect(() => fixture.authority.readPrivateFile("C:\\authority", 10)).toThrow(
      "changed during read",
    );
  });

  test("fails closed on missing, unsafe, oversized, and short-read paths", () => {
    const fixture = nativeFixture();
    expect(fixture.authority.directoryIdentity("C:\\missing", false)).toBeNull();
    expect(fixture.authority.readPrivateFile("C:\\missing", 1)).toBeNull();
    const denied = createNativeWindowsPathAuthority(
      {
        ...fixture.binding,
        createFile: () => fixture.binding.invalidHandle,
        lastError: () => 5,
      },
      fixture.privacy,
    );
    expect(() => denied.readPrivateFile("C:\\denied", 1)).toThrow(
      "CreateFileW(authority) failed with Windows error 5",
    );
    fixture.authority.writePrivateFile("C:\\record", Buffer.from("value"), 10);
    const entry = required(fixture.entries.get("C:\\record"), "record entry");
    expect(() => fixture.authority.readPrivateFile("C:\\record", 1)).toThrow("oversized");
    entry.reparse = true;
    expect(() => fixture.authority.readPrivateFile("C:\\record", 10)).toThrow("reparse point");
    entry.reparse = false;
    entry.links = 2;
    expect(() => fixture.authority.readPrivateFile("C:\\record", 10)).toThrow("link state");
    entry.links = 1;
    entry.deletePending = true;
    expect(() => fixture.authority.readPrivateFile("C:\\record", 10)).toThrow("link state");
    entry.deletePending = false;
    entry.id.fill(0, 8);
    expect(() => fixture.authority.readPrivateFile("C:\\record", 10)).toThrow(
      "identity is unavailable",
    );
    entry.id = identity(1n);
    fixture.setReadZero();
    expect(() => fixture.authority.readPrivateFile("C:\\record", 10)).toThrow("short");
    expect(() => fixture.authority.writePrivateFile("C:\\large", Buffer.alloc(2), 1)).toThrow(
      "exceeds limit",
    );
  });

  test("rejects permissive handles and preserves the primary verification failure", () => {
    const fixture = nativeFixture();
    fixture.authority.createPrivateDirectory("C:\\private");
    fixture.setVerifyFailure(new Error("permissive DACL primary"));
    expect(() => fixture.authority.directoryIdentity("C:\\private", true)).toThrow(
      "permissive DACL primary",
    );
    expect(fixture.calls.close).toBeGreaterThan(0);
  });

  test("pins every directory prefix without delete sharing for the whole callback", () => {
    const fixture = nativeFixture();
    fixture.addDirectory("C:\\workspace");
    const records = fixture.addDirectory("C:\\workspace\\records");

    const result = fixture.authority.withVerifiedDirectory(
      "C:\\workspace\\records",
      records.id.toString("hex"),
      () => {
        expect([...fixture.handles.values()].map(({ path }) => path).sort()).toEqual([
          "C:\\",
          "C:\\workspace",
          "C:\\workspace\\records",
        ]);
        return "leased";
      },
    );

    expect(result).toBe("leased");
    expect(fixture.handles.size).toBe(0);
    const directoryOpens = fixture.calls.create.filter(
      (call) => ((call[5] as number) & WINDOWS_PATH_AUTHORITY.FILE_FLAG_BACKUP_SEMANTICS) !== 0,
    );
    expect(directoryOpens).toHaveLength(3);
    expect(
      directoryOpens.every(
        (call) => ((call[2] as number) & WINDOWS_PATH_AUTHORITY.FILE_SHARE_DELETE) === 0,
      ),
    ).toBe(true);
  });

  test("rejects an unexpected directory identity before the callback and closes every prefix", () => {
    const fixture = nativeFixture();
    fixture.addDirectory("C:\\workspace");
    fixture.addDirectory("C:\\workspace\\records");
    let ran = false;

    expect(() =>
      fixture.authority.withVerifiedDirectory(
        "C:\\workspace\\records",
        identity(9_999n).toString("hex"),
        () => {
          ran = true;
        },
      ),
    ).toThrow("changed");
    expect(ran).toBe(false);
    expect(fixture.handles.size).toBe(0);
    expect(fixture.calls.close).toBe(3);
  });

  test.each(POST_CALLBACK_MUTATIONS)(
    "rejects a post-callback %s mutation",
    (_label, mutate, expectedMessage) => {
      const fixture = nativeFixture();
      fixture.addDirectory("C:\\workspace");
      const records = fixture.addDirectory("C:\\workspace\\records");
      let ran = 0;

      expect(() =>
        fixture.authority.withVerifiedDirectory(
          "C:\\workspace\\records",
          records.id.toString("hex"),
          () => {
            ran += 1;
            mutate(fixture, records);
          },
        ),
      ).toThrow(expectedMessage);
      expect(ran).toBe(1);
      expect(fixture.handles.size).toBe(0);
    },
  );

  test("keeps a callback error primary when closing every pinned prefix also fails", () => {
    const fixture = nativeFixture();
    fixture.addDirectory("C:\\workspace");
    const records = fixture.addDirectory("C:\\workspace\\records");
    const primary = new Error("callback primary");
    fixture.setCloseFailure(true);
    let failure: unknown;

    try {
      fixture.authority.withVerifiedDirectory(
        "C:\\workspace\\records",
        records.id.toString("hex"),
        () => {
          throw primary;
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBe(primary);
    expect(primary.cause).toBeInstanceOf(AggregateError);
    expect((primary.cause as AggregateError).errors).toHaveLength(3);
    expect(fixture.calls.close).toBe(3);
  });

  test("removes a partial native file before surfacing a write failure", () => {
    const fixture = nativeFixture();
    fixture.setWriteFailure(true);
    expect(() => fixture.authority.writePrivateFile("C:\\retry", Buffer.from("value"), 10)).toThrow(
      "WriteFile failed with Windows error 5",
    );
    expect(fixture.entries.has("C:\\retry")).toBe(false);
    fixture.setWriteFailure(false);
    expect(() =>
      fixture.authority.writePrivateFile("C:\\retry", Buffer.from("value"), 10),
    ).not.toThrow();
  });

  test("keeps the write failure primary and reports every failed native rollback", () => {
    const fixture = nativeFixture();
    fixture.setWriteFailure(true);
    fixture.setDispositionFailure(true);
    fixture.setCloseFailure(true);
    let failure: unknown;
    try {
      fixture.authority.writePrivateFile("C:\\rollback", Buffer.from("value"), 10);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("WriteFile failed with Windows error 5");
    expect((failure as Error).cause).toBeInstanceOf(AggregateError);
    expect(((failure as Error).cause as AggregateError).errors).toHaveLength(2);
  });

  test("constructs every Kernel32 binding through an injectable loader", () => {
    const declarations: string[] = [];
    const library = {
      func: (_convention: string, name: string) => {
        declarations.push(name);
        return () => 1;
      },
    };
    const koffi = {
      load: (name: string) => {
        expect(name).toBe("Kernel32.dll");
        return library;
      },
      opaque: () => ({ opaque: true }),
      pointer: (value: unknown) => ({ pointer: value }),
      out: (value: unknown) => ({ out: value }),
      sizeof: () => 8,
    };
    const binding = loadWindowsPathNativeBindings({ require: () => koffi });
    expect(binding.invalidHandle).toBe(18_446_744_073_709_551_615n);
    expect(declarations).toEqual([
      "CreateFileW",
      "CreateDirectoryW",
      "GetFileInformationByHandleEx",
      "ReadFile",
      "WriteFile",
      "FlushFileBuffers",
      "SetFileInformationByHandle",
      "CloseHandle",
      "GetLastError",
    ]);
  });
});
