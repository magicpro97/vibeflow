import { describe, expect, test } from "bun:test";
import {
  WINDOWS_AUTHORITY_PATH_KIND,
  windowsEnsureNoForeignWrite,
  windowsEnsurePrivateAcl,
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
// CI runner and on Windows. The real Win32 round trip is covered by windows-owner-acl.test.ts and
// windows-acl-identity.test.ts.
const IDENTITY_DEV = 7n;
const IDENTITY_INO = 11n;
const identity = { dev: IDENTITY_DEV, ino: IDENTITY_INO };

// FILE_ID_INFO as the identity gate reads it: the volume serial number, then the file id at offset 8.
function fileIdInfo(dev: bigint, ino: bigint) {
  return (_handle: bigint, informationClass: number, output: Buffer): number => {
    if (informationClass !== WINDOWS_NATIVE_RECORD.FILE_ID_INFO_CLASS) return 0;
    output.writeUInt32LE(Number(dev), 0);
    output.writeBigUInt64LE(ino, 8);
    return 1;
  };
}

function fakeBinding(overrides: Partial<Record<string, unknown>> = {}) {
  const calls = { closeHandle: 0, paths: [] as string[], access: [] as number[] };
  const binding = {
    invalidHandle: INVALID_HANDLE,
    createFile: (path: Buffer, access: number) => {
      calls.paths.push(path.toString("utf16le"));
      calls.access.push(access);
      return HANDLE;
    },
    closeHandle: () => {
      calls.closeHandle += 1;
      return 1;
    },
    fileInfo: fileIdInfo(IDENTITY_DEV, IDENTITY_INO),
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
    migrated: [] as [bigint, WindowsAuthorityPathKind][],
  };
  const authority = {
    inspect: typeof descriptor === "function" ? descriptor : () => descriptor,
    currentUserId: () => OWNER_SID,
    verifyHandle: (handle: bigint, kind: WindowsAuthorityPathKind) => {
      calls.verifyHandle.push([handle, kind]);
    },
    migrateHandle: (handle: bigint, kind: WindowsAuthorityPathKind) => {
      calls.migrated.push([handle, kind]);
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
    // Every entry point answers "no" rather than letting a host without Win32 security APIs turn
    // into an unexpected exception at the call site, and none of them writes without an identity.
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
      expect(
        windowsEnsurePrivateAcl("C:\\tmp\\file", WINDOWS_AUTHORITY_PATH_KIND.FILE, {
          runtime,
          identity,
        }),
      ).toBe(false);
      expect(
        windowsEnsureNoForeignWrite("C:\\tmp\\file", WINDOWS_AUTHORITY_PATH_KIND.FILE, {
          runtime,
          identity,
        }),
      ).toBe(false);
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

  test("repairs a path whose DACL grants a foreign write before answering", () => {
    const { binding } = fakeBinding();
    let inspected = 0;
    const permissive = descriptor([ace(WINDOWS_PRIVATE_SECURITY.FILE_ALL_ACCESS, OTHER_SID)]);
    const repaired = descriptor([ace(WINDOWS_PRIVATE_SECURITY.FILE_ALL_ACCESS, OWNER_SID)]);
    const { authority, calls } = fakeAuthority(() => (inspected++ === 0 ? permissive : repaired));
    expect(
      windowsEnsureNoForeignWrite("C:\\tmp\\dir", WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, {
        binding,
        authority,
        identity,
      }),
    ).toBe(true);
    // The repair is written through the handle that was verified, never through the path.
    expect(calls.migrated).toEqual([[HANDLE, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY]]);
  });

  test("repairs a path that is not owner-only before answering", () => {
    const { binding } = fakeBinding();
    let checks = 0;
    const { authority, calls } = fakeAuthority(
      descriptor([ace(WINDOWS_PRIVATE_SECURITY.FILE_ALL_ACCESS, OWNER_SID)]),
      {
        verifyHandle: () => {
          if (checks++ === 0) throw new Error("permissive Windows authority DACL rejected");
        },
      },
    );
    expect(
      windowsEnsurePrivateAcl("C:\\tmp\\dir", WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, {
        binding,
        authority,
        identity,
      }),
    ).toBe(true);
    expect(calls.migrated).toEqual([[HANDLE, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY]]);
  });

  test("asks for the accesses the repair write needs, and no more", () => {
    const { binding, calls } = fakeBinding();
    let checks = 0;
    const { authority, calls: authorityCalls } = fakeAuthority(descriptor([]), {
      verifyHandle: () => {
        if (checks++ === 0) throw new Error("permissive Windows authority DACL rejected");
      },
    });
    expect(
      windowsEnsurePrivateAcl("C:\\tmp\\dir", WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, {
        binding,
        authority,
        identity,
      }),
    ).toBe(true);
    // The repair replaces the descriptor's owner as well as its DACL through this handle, so the open
    // has to carry WRITE_OWNER: without it SetSecurityInfo leaves the owner an elevated token gave the
    // object in place and the verdict refuses a path this process just created.
    expect(calls.access).toEqual([
      (WINDOWS_NATIVE_RECORD.READ_CONTROL |
        WINDOWS_NATIVE_RECORD.WRITE_DAC |
        WINDOWS_NATIVE_RECORD.WRITE_OWNER) >>>
        0,
    ]);
    expect(authorityCalls.migrated).toEqual([[HANDLE, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY]]);
    // A verdict writes nothing, so it asks for nothing but the read the policy is answered from.
    expect(
      windowsVerifyPathAcl("C:\\tmp\\dir", WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, {
        binding,
        authority,
        identity,
      }),
    ).toBe(true);
    expect(calls.access.at(-1)).toBe(WINDOWS_NATIVE_RECORD.READ_CONTROL >>> 0);
  });

  test("answers false when the DACL cannot be repaired", () => {
    const { binding } = fakeBinding();
    const foreign = descriptor([ace(WINDOWS_PRIVATE_SECURITY.FILE_ALL_ACCESS, OTHER_SID)]);
    const denied = {
      migrateHandle: () => {
        throw new Error("access denied");
      },
    };
    const weak = fakeAuthority(foreign, denied);
    expect(
      windowsEnsureNoForeignWrite("C:\\tmp\\dir", WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, {
        binding,
        authority: weak.authority,
      }),
    ).toBe(false);
    const strict = fakeAuthority(foreign, {
      ...denied,
      verifyHandle: () => {
        throw new Error("permissive Windows authority DACL rejected");
      },
    });
    expect(
      windowsEnsurePrivateAcl("C:\\tmp\\dir", WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, {
        binding,
        authority: strict.authority,
      }),
    ).toBe(false);
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

  test("refuses to repair without the identity of the object the repair is for", () => {
    const { binding, calls } = fakeBinding();
    const { authority, calls: authorityCalls } = fakeAuthority(descriptor([]), {
      verifyHandle: () => {
        throw new Error("permissive Windows authority DACL rejected");
      },
    });
    // A caller that cannot say which object it measured gets no write at all: repairing whatever the
    // name holds is the substitution the identity gate exists to refuse.
    expect(
      windowsEnsurePrivateAcl("C:\\tmp\\file", WINDOWS_AUTHORITY_PATH_KIND.FILE, {
        binding,
        authority,
      }),
    ).toBe(false);
    expect(
      windowsEnsureNoForeignWrite("C:\\tmp\\dir", WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, {
        binding,
        authority,
      }),
    ).toBe(false);
    expect(authorityCalls.migrated).toHaveLength(0);
    // Not even opened: the refusal is before the path is touched.
    expect(calls.paths).toHaveLength(0);
    expect(calls.closeHandle).toBe(0);
  });

  test("answers false when the path cannot be opened for the repair", () => {
    const { binding, calls } = fakeBinding({ createFile: () => INVALID_HANDLE });
    const { authority, calls: authorityCalls } = fakeAuthority(descriptor([]));
    expect(
      windowsEnsurePrivateAcl("C:\\tmp\\file", WINDOWS_AUTHORITY_PATH_KIND.FILE, {
        binding,
        authority,
        identity,
      }),
    ).toBe(false);
    expect(authorityCalls.migrated).toHaveLength(0);
    expect(calls.closeHandle).toBe(0);
  });

  test("answers false when the repair itself fails", () => {
    const { binding, calls } = fakeBinding();
    const { authority } = fakeAuthority(descriptor([]), {
      verifyHandle: () => {
        throw new Error("permissive Windows authority DACL rejected");
      },
      migrateHandle: () => {
        throw new Error("SetSecurityInfo failed with Windows error 5");
      },
    });
    expect(
      windowsEnsurePrivateAcl("C:\\tmp\\file", WINDOWS_AUTHORITY_PATH_KIND.FILE, {
        binding,
        authority,
        identity,
      }),
    ).toBe(false);
    expect(calls.closeHandle).toBe(1);
  });
});

describe("windows acl ops identity gate", () => {
  test("accepts a handle that reproduces the identity of the object the caller stat'ed", () => {
    const { binding } = fakeBinding();
    const { authority, calls } = fakeAuthority(descriptor([]));
    expect(
      windowsVerifyPathAcl("C:\\tmp\\file", WINDOWS_AUTHORITY_PATH_KIND.FILE, {
        binding,
        authority,
        identity,
      }),
    ).toBe(true);
    expect(
      windowsHasNoForeignWrite("C:\\tmp\\file", WINDOWS_AUTHORITY_PATH_KIND.FILE, {
        binding,
        authority,
        identity,
      }),
    ).toBe(true);
    expect(calls.verifyHandle).toHaveLength(1);
  });

  test("refuses a path that does not hold the object the caller stat'ed", () => {
    // Both policies, both against a descriptor that would otherwise pass, so the refusal can only
    // come from the identity.
    const { binding, calls } = fakeBinding();
    const { authority, calls: authorityCalls } = fakeAuthority(descriptor([]));
    for (const stale of [
      { dev: identity.dev, ino: identity.ino + 1n },
      { dev: identity.dev + 1n, ino: identity.ino },
    ]) {
      expect(
        windowsVerifyPathAcl("C:\\tmp\\file", WINDOWS_AUTHORITY_PATH_KIND.FILE, {
          binding,
          authority,
          identity: stale,
        }),
      ).toBe(false);
      expect(
        windowsHasNoForeignWrite("C:\\tmp\\file", WINDOWS_AUTHORITY_PATH_KIND.FILE, {
          binding,
          authority,
          identity: stale,
        }),
      ).toBe(false);
    }
    expect(authorityCalls.verifyHandle).toHaveLength(0);
    expect(calls.closeHandle).toBe(4);
  });

  test("refuses a handle that cannot report an identity at all", () => {
    const { binding, calls } = fakeBinding({ fileInfo: () => 0 });
    const { authority, calls: authorityCalls } = fakeAuthority(descriptor([]));
    expect(
      windowsVerifyPathAcl("C:\\tmp\\file", WINDOWS_AUTHORITY_PATH_KIND.FILE, {
        binding,
        authority,
        identity,
      }),
    ).toBe(false);
    expect(authorityCalls.verifyHandle).toHaveLength(0);
    expect(calls.closeHandle).toBe(1);
  });

  test("repairs the object it verified, on the handle that verified it", () => {
    const { binding, calls: bindingCalls } = fakeBinding();
    let checks = 0;
    const { authority, calls } = fakeAuthority(descriptor([]), {
      verifyHandle: () => {
        if (checks++ === 0) throw new Error("permissive Windows authority DACL rejected");
      },
    });
    expect(
      windowsEnsurePrivateAcl("C:\\tmp\\dir", WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, {
        binding,
        authority,
        identity,
      }),
    ).toBe(true);
    expect(calls.migrated).toEqual([[HANDLE, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY]]);
    // Verify, repair, verify — all three against the one handle that identified the object, so the
    // answer after the repair cannot come from a fresh open that landed somewhere else.
    expect(checks).toBe(2);
    expect(bindingCalls.closeHandle).toBe(1);
  });

  test("does not repair a path that no longer holds the object the caller stat'ed", () => {
    const migrated: bigint[] = [];
    const stale = { dev: identity.dev, ino: identity.ino + 1n };
    const { binding } = fakeBinding();
    const strict = fakeAuthority(descriptor([]), {
      verifyHandle: () => {
        throw new Error("permissive Windows authority DACL rejected");
      },
      migrateHandle: (handle: bigint) => migrated.push(handle),
    });
    expect(
      windowsEnsurePrivateAcl("C:\\tmp\\file", WINDOWS_AUTHORITY_PATH_KIND.FILE, {
        binding,
        authority: strict.authority,
        identity: stale,
      }),
    ).toBe(false);
    const weak = fakeAuthority(
      descriptor([ace(WINDOWS_PRIVATE_SECURITY.FILE_ALL_ACCESS, OTHER_SID)]),
      { migrateHandle: (handle: bigint) => migrated.push(handle) },
    );
    expect(
      windowsEnsureNoForeignWrite("C:\\tmp\\dir", WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY, {
        binding,
        authority: weak.authority,
        identity: stale,
      }),
    ).toBe(false);
    expect(migrated).toEqual([]);
  });
});

describe("windows acl ops identity exactness above 2^53", () => {
  // NTFS file ids need 57 bits. Number-typed stats round them, and two neighbours that differ only
  // above bit 53 collapse onto the same double, so an identity compared as a Number cannot tell the
  // object the caller measured from its neighbour.
  const ROUNDED = 2n ** 53n;
  const NEIGHBOUR = ROUNDED + 1n;

  test("the rounding is real: two distinct file ids share one Number value", () => {
    expect(Number(NEIGHBOUR)).toBe(Number(ROUNDED));
    expect(Number(NEIGHBOUR)).toBe(2 ** 53);
  });

  test("refuses a handle whose exact id is the neighbour of the identity's", () => {
    // The caller measured an object whose exact id is 2^53; the leaf now at the path is the object
    // with id 2^53+1, which a Number-typed comparison cannot tell apart from it.
    const { binding, calls } = fakeBinding({ fileInfo: fileIdInfo(7n, NEIGHBOUR) });
    const { authority, calls: authorityCalls } = fakeAuthority(descriptor([]));
    const FILE = WINDOWS_AUTHORITY_PATH_KIND.FILE;
    expect(
      windowsVerifyPathAcl("C:\\tmp\\file", FILE, {
        binding,
        authority,
        identity: { dev: IDENTITY_DEV, ino: ROUNDED },
      }),
    ).toBe(false);
    expect(
      windowsHasNoForeignWrite("C:\\tmp\\file", FILE, {
        binding,
        authority,
        identity: { dev: IDENTITY_DEV, ino: ROUNDED },
      }),
    ).toBe(false);
    expect(authorityCalls.verifyHandle).toHaveLength(0);
    expect(calls.closeHandle).toBe(2);
  });

  test("still accepts the object whose exact id it is", () => {
    const { binding } = fakeBinding({ fileInfo: fileIdInfo(7n, NEIGHBOUR) });
    const { authority } = fakeAuthority(descriptor([]));
    expect(
      windowsVerifyPathAcl("C:\\tmp\\file", WINDOWS_AUTHORITY_PATH_KIND.FILE, {
        binding,
        authority,
        identity: { dev: IDENTITY_DEV, ino: NEIGHBOUR },
      }),
    ).toBe(true);
  });

  test("does not repair a path whose exact id is the identity's neighbour", () => {
    const migrated: bigint[] = [];
    const { binding } = fakeBinding({ fileInfo: fileIdInfo(7n, NEIGHBOUR) });
    const { authority } = fakeAuthority(descriptor([]), {
      verifyHandle: () => {
        throw new Error("permissive Windows authority DACL rejected");
      },
      migrateHandle: (handle: bigint) => migrated.push(handle),
    });
    expect(
      windowsEnsurePrivateAcl("C:\\tmp\\file", WINDOWS_AUTHORITY_PATH_KIND.FILE, {
        binding,
        authority,
        identity: { dev: IDENTITY_DEV, ino: ROUNDED },
      }),
    ).toBe(false);
    expect(migrated).toEqual([]);
  });
});
