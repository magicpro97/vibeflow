import { describe, expect, test } from "bun:test";
import {
  WINDOWS_AUTHORITY_PATH_KIND,
  windowsApplyOwnerAcl,
  windowsHasNoForeignWrite,
  windowsVerifyPathAcl,
} from "../../src/durability/windows-acl-ops.js";
import type { WindowsFfiRuntime } from "../../src/durability/windows-ffi-runtime.js";
import {
  WINDOWS_NATIVE_RECORD,
  type WindowsRecordNativeBindings,
} from "../../src/durability/windows-kernel-lock.js";
import {
  WINDOWS_PRIVATE_SECURITY,
  type WindowsAuthorityPathKind,
  type WindowsPrivateAce,
  type WindowsPrivateAuthority,
  type WindowsPrivateDescriptorView,
} from "../../src/durability/windows-private-authority.js";

const INVALID_HANDLE = 18_446_744_073_709_551_615n;
const HANDLE = 42n;

const SYSTEM_SID = Buffer.from([0x01, 0x01, 0, 0, 0, 0, 0, 5, 0x12, 0, 0, 0]);
const ADMINS_SID = Buffer.from([0x01, 0x02, 0, 0, 0, 0, 0, 5, 0x20, 0, 0, 0, 0x20, 0x02, 0, 0]);
const OWNER_SID = Buffer.from([0x01, 0x01, 0, 0, 0, 0, 0, 5, 0x15, 0, 0, 0]);
const OTHER_SID = Buffer.from([0x01, 0x02, 0, 0, 0, 0, 0, 5, 0x20, 0, 0, 0, 0x2a, 0x02, 0, 0]);

// Canonical Win32 generic mappings. Both carry SYNCHRONIZE and STANDARD_RIGHTS_READ but no modify
// right, which is what a POSIX group/other read bit maps to — a check built on FILE_GENERIC_WRITE
// would call these a foreign write, which is exactly the bug these cases pin down.
const FILE_GENERIC_READ = 0x0012_0089;
const FILE_GENERIC_EXECUTE = 0x0012_00a0;

// Every test drives the module through its injection seam, so the suite runs identically on a Linux
// CI runner and on Windows. The real Win32 round trip is covered by windows-owner-acl.test.ts.
function fakeBinding(overrides: Partial<Record<string, unknown>> = {}) {
  const calls = { closeHandle: 0, paths: [] as string[] };
  const binding = {
    invalidHandle: INVALID_HANDLE,
    createFile: (path: Buffer) => {
      calls.paths.push(path.toString("utf16le"));
      return HANDLE;
    },
    closeHandle: () => {
      calls.closeHandle += 1;
      return 1;
    },
    ...overrides,
  } as unknown as WindowsRecordNativeBindings;
  return { binding, calls };
}

function fakeAuthority(
  descriptor: WindowsPrivateDescriptorView | (() => WindowsPrivateDescriptorView),
  overrides: Partial<Record<string, unknown>> = {},
) {
  const calls = {
    verifyHandle: [] as [bigint, WindowsAuthorityPathKind][],
    migrated: [] as string[],
  };
  const authority = {
    inspect: typeof descriptor === "function" ? descriptor : () => descriptor,
    currentUserId: () => OWNER_SID,
    verifyHandle: (handle: bigint, kind: WindowsAuthorityPathKind) => {
      calls.verifyHandle.push([handle, kind]);
    },
    migrateToOwnerOnly: (path: string) => {
      calls.migrated.push(path);
    },
    ...overrides,
  } as unknown as WindowsPrivateAuthority;
  return { authority, calls };
}

function descriptor(
  aces: readonly WindowsPrivateAce[],
  overrides: Partial<WindowsPrivateDescriptorView> = {},
): WindowsPrivateDescriptorView {
  return {
    control: 0,
    owner: OWNER_SID,
    daclPresent: true,
    daclDefaulted: false,
    aces,
    ...overrides,
  };
}

function ace(
  mask: number,
  sid: Buffer,
  type: number = WINDOWS_PRIVATE_SECURITY.ACCESS_ALLOWED_ACE_TYPE,
) {
  return { type, flags: 0, mask, sid } as WindowsPrivateAce;
}

// A host with no Win32 security APIs: the loader reaches for a module that cannot provide them.
const unrunnableRuntime = (specifier: "bun:ffi" | "koffi"): WindowsFfiRuntime => ({
  isBun: specifier === "bun:ffi",
  requireModule: () => {
    throw new Error(`${specifier} is unavailable on this host`);
  },
});

describe("windows acl ops", () => {
  test("verifies a handle and always closes it", () => {
    const { binding, calls } = fakeBinding();
    const { authority, calls: authorityCalls } = fakeAuthority(descriptor([]));
    expect(
      windowsVerifyPathAcl("C:\\tmp\\file", WINDOWS_AUTHORITY_PATH_KIND.FILE, {
        binding,
        authority,
      }),
    ).toBe(true);
    expect(authorityCalls.verifyHandle).toEqual([[HANDLE, WINDOWS_AUTHORITY_PATH_KIND.FILE]]);
    expect(calls.closeHandle).toBe(1);
  });

  test("passes the directory flag through to CreateFileW", () => {
    const { binding, calls } = fakeBinding();
    const { authority } = fakeAuthority(descriptor([]));
    windowsVerifyPathAcl("C:\\tmp\\dir", WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, {
      binding,
      authority,
    });
    expect(calls.paths[0]?.startsWith("\\\\?\\C:\\tmp\\dir")).toBe(true);
  });

  test("reports no verification when the handle cannot be opened", () => {
    const { binding, calls } = fakeBinding({ createFile: () => INVALID_HANDLE });
    const { authority, calls: authorityCalls } = fakeAuthority(descriptor([]));
    expect(
      windowsVerifyPathAcl("C:\\tmp\\file", WINDOWS_AUTHORITY_PATH_KIND.FILE, {
        binding,
        authority,
      }),
    ).toBe(false);
    expect(authorityCalls.verifyHandle).toHaveLength(0);
    expect(calls.closeHandle).toBe(0);
  });

  test("reports no verification when verifyHandle rejects the handle", () => {
    const { binding, calls } = fakeBinding();
    const { authority } = fakeAuthority(descriptor([]), {
      verifyHandle: () => {
        throw new Error("acl is not owner only");
      },
    });
    expect(
      windowsVerifyPathAcl("C:\\tmp\\file", WINDOWS_AUTHORITY_PATH_KIND.FILE, {
        binding,
        authority,
      }),
    ).toBe(false);
    expect(calls.closeHandle).toBe(1);
  });

  test("a failed close does not change the verdict", () => {
    const { binding } = fakeBinding({
      closeHandle: () => {
        throw new Error("handle already closed");
      },
    });
    const { authority } = fakeAuthority(descriptor([]));
    expect(
      windowsVerifyPathAcl("C:\\tmp\\file", WINDOWS_AUTHORITY_PATH_KIND.FILE, {
        binding,
        authority,
      }),
    ).toBe(true);
  });

  test("fails closed when the Win32 security bindings cannot be loaded", () => {
    // The predicates must answer "no" and the mutator must report its failure, rather than letting
    // a host without Win32 security APIs turn into an unexpected exception at the call site.
    for (const specifier of ["koffi", "bun:ffi"] as const) {
      const runtime = unrunnableRuntime(specifier);
      expect(
        windowsVerifyPathAcl("C:\\tmp\\file", WINDOWS_AUTHORITY_PATH_KIND.FILE, { runtime }),
      ).toBe(false);
      expect(
        windowsHasNoForeignWrite("C:\\tmp\\dir", WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, {
          runtime,
        }),
      ).toBe(false);
      expect(() =>
        windowsApplyOwnerAcl("C:\\tmp\\dir", WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, { runtime }),
      ).toThrow(specifier);
    }
  });

  test("an inherited SYSTEM/Administrators/owner DACL is not a foreign write", () => {
    const { binding, calls } = fakeBinding();
    const { authority } = fakeAuthority(
      descriptor([
        ace(WINDOWS_PRIVATE_SECURITY.FILE_ALL_ACCESS, SYSTEM_SID),
        ace(WINDOWS_PRIVATE_SECURITY.FILE_ALL_ACCESS, ADMINS_SID),
        ace(WINDOWS_PRIVATE_SECURITY.FILE_ALL_ACCESS, OWNER_SID),
      ]),
    );
    expect(
      windowsHasNoForeignWrite("C:\\tmp\\dir", WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, {
        binding,
        authority,
      }),
    ).toBe(true);
    expect(calls.closeHandle).toBe(1);
  });

  test("a read-only grant to another principal is not a foreign write", () => {
    const { binding } = fakeBinding();
    const { authority } = fakeAuthority(
      descriptor([ace(FILE_GENERIC_READ, OTHER_SID), ace(FILE_GENERIC_EXECUTE, OTHER_SID)]),
    );
    expect(
      windowsHasNoForeignWrite("C:\\tmp\\dir", WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, {
        binding,
        authority,
      }),
    ).toBe(true);
  });

  test("a modifying grant to another principal is a foreign write", () => {
    const { binding } = fakeBinding();
    for (const mask of [
      WINDOWS_NATIVE_RECORD.FILE_WRITE_DATA,
      WINDOWS_NATIVE_RECORD.FILE_APPEND_DATA,
      WINDOWS_NATIVE_RECORD.FILE_WRITE_EA,
      WINDOWS_NATIVE_RECORD.FILE_WRITE_ATTRIBUTES,
      WINDOWS_NATIVE_RECORD.DELETE_ACCESS,
      WINDOWS_NATIVE_RECORD.WRITE_DAC,
      WINDOWS_NATIVE_RECORD.WRITE_OWNER,
    ]) {
      const { authority } = fakeAuthority(descriptor([ace(mask, OTHER_SID)]));
      expect(
        windowsHasNoForeignWrite("C:\\tmp\\dir", WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, {
          binding,
          authority,
        }),
      ).toBe(false);
    }
  });

  test("a deny ACE does not count as a foreign write", () => {
    const { binding } = fakeBinding();
    const { authority } = fakeAuthority(
      descriptor([ace(WINDOWS_PRIVATE_SECURITY.FILE_ALL_ACCESS, OTHER_SID, 1)]),
    );
    expect(
      windowsHasNoForeignWrite("C:\\tmp\\dir", WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, {
        binding,
        authority,
      }),
    ).toBe(true);
  });

  test("a NULL DACL grants everyone write", () => {
    const { binding } = fakeBinding();
    const { authority } = fakeAuthority(descriptor([], { daclPresent: false }));
    expect(
      windowsHasNoForeignWrite("C:\\tmp\\dir", WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, {
        binding,
        authority,
      }),
    ).toBe(false);
  });

  test("reports a foreign write when the handle cannot be opened or inspected", () => {
    const absent = fakeBinding({ createFile: () => INVALID_HANDLE });
    const { authority, calls } = fakeAuthority(descriptor([]));
    expect(
      windowsHasNoForeignWrite("C:\\tmp\\dir", WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, {
        binding: absent.binding,
        authority,
      }),
    ).toBe(false);
    expect(calls.verifyHandle).toHaveLength(0);

    const inspecting = fakeBinding();
    const throwing = fakeAuthority(() => {
      throw new Error("GetSecurityInfo failed");
    });
    expect(
      windowsHasNoForeignWrite("C:\\tmp\\dir", WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, {
        binding: inspecting.binding,
        authority: throwing.authority,
      }),
    ).toBe(false);
    expect(inspecting.calls.closeHandle).toBe(1);
  });

  test("applies an owner-only DACL by path", () => {
    const { authority, calls } = fakeAuthority(descriptor([]));
    windowsApplyOwnerAcl("C:\\tmp\\dir", WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, { authority });
    expect(calls.migrated).toEqual(["C:\\tmp\\dir"]);
  });

  test("surfaces a migrate failure to the caller", () => {
    const { authority } = fakeAuthority(descriptor([]), {
      migrateToOwnerOnly: () => {
        throw new Error("SetNamedSecurityInfoW failed");
      },
    });
    expect(() =>
      windowsApplyOwnerAcl("C:\\tmp\\dir", WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, { authority }),
    ).toThrow("SetNamedSecurityInfoW failed");
  });
});
