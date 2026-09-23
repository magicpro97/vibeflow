import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type WindowsPinRuntimeV1,
  memoizedWindowsLockProvider,
  pinWindowsDirectory,
  releaseWindowsAdvisoryLock,
  repairWindowsLeafAcl,
  tryWindowsAdvisoryLock,
  windowsPinRuntime,
} from "../../src/durability/native-windows-ops.js";
import type { PinnedDirectory } from "../../src/durability/pinned-directory.js";
import {
  WINDOWS_NATIVE_RECORD,
  type WindowsRecordNativeBindings,
} from "../../src/durability/windows-kernel-lock.js";
import type {
  WindowsKernelLock,
  WindowsKernelLockProvider,
} from "../../src/durability/windows-kernel-lock.js";
import {
  WINDOWS_AUTHORITY_PATH_KIND,
  type WindowsAuthorityPathKind,
  type WindowsPrivateAuthority,
} from "../../src/durability/windows-private-authority.js";

/**
 * These are the Windows-only steps of native.ts. Running them used to require Windows, so CI
 * (Linux) never executed them and the fd bookkeeping went unverified. Each function takes its
 * collaborators as arguments, so the real control flow runs here on any platform.
 */
const fakeRuntime = (
  overrides: Partial<WindowsPinRuntimeV1> & { dev?: bigint; ino?: bigint; isDir?: boolean } = {},
): { runtime: WindowsPinRuntimeV1; asserted: PinnedDirectory[]; registry: Map<number, string> } => {
  const registry = overrides.registry ?? new Map<number, string>();
  const asserted: PinnedDirectory[] = [];
  return {
    registry,
    asserted,
    runtime: {
      fstatBig:
        overrides.fstatBig ??
        (() => ({
          dev: overrides.dev ?? 42n,
          // Deliberately past 2^53: a Number-typed ino would round this.
          ino: overrides.ino ?? 0x1_0000_0000_0001n,
          isDirectory: () => overrides.isDir ?? true,
        })),
      assertPinned:
        overrides.assertPinned ??
        ((directory) => {
          asserted.push(directory);
        }),
      registry,
    },
  };
};

describe("pinWindowsDirectory", () => {
  test("records the exact 57-bit identity and registers the path", () => {
    const { runtime, asserted, registry } = fakeRuntime();
    const pinned = pinWindowsDirectory(7, "C:\\state", runtime);

    expect(pinned.fd).toBe(7);
    expect(pinned.path).toBe("C:\\state");
    expect(pinned.devBig).toBe(42n);
    expect(pinned.inoBig).toBe(0x1_0000_0000_0001n);
    // The rounded pair is carried for older callers, and rounding it is exactly why the
    // bigint pair above is the authoritative one.
    expect(pinned.dev).toBe(42);
    expect(pinned.ino).toBe(Number(0x1_0000_0000_0001n));
    expect(registry.get(7)).toBe("C:\\state");
    expect(asserted).toEqual([pinned]);
  });

  test("rejects an fd that is not a directory before registering anything", () => {
    const { runtime, registry } = fakeRuntime({ isDir: false });
    expect(() => pinWindowsDirectory(9, "C:\\file", runtime)).toThrow("unsafe pinned directory");
    expect(registry.has(9)).toBe(false);
  });

  test("overwrites a stale registry entry left by a recycled fd number", () => {
    const registry = new Map<number, string>([[3, "C:\\previous\\owner"]]);
    const { runtime } = fakeRuntime({ registry });
    pinWindowsDirectory(3, "C:\\current", runtime);
    expect(registry.get(3)).toBe("C:\\current");
  });

  test("propagates an identity rejection from the pin assertion", () => {
    const { runtime } = fakeRuntime({
      assertPinned: () => {
        throw new Error("pinned directory identity changed");
      },
    });
    expect(() => pinWindowsDirectory(4, "C:\\state", runtime)).toThrow(
      "pinned directory identity changed",
    );
  });

  test("windowsPinRuntime wires the real fstat, assertion and shared registry", () => {
    const runtime = windowsPinRuntime();
    expect(typeof runtime.fstatBig).toBe("function");
    expect(typeof runtime.assertPinned).toBe("function");
    expect(runtime.registry).toBeInstanceOf(Map);
  });
});

const fakeLock = (): WindowsKernelLock & { released: number } => {
  const lock = {
    released: 0,
    release() {
      lock.released += 1;
    },
  };
  return lock as WindowsKernelLock & { released: number };
};

const fakeProvider = (lock: WindowsKernelLock | null): WindowsKernelLockProvider =>
  ({ tryAcquire: () => lock }) as unknown as WindowsKernelLockProvider;

describe("repairWindowsLeafAcl", () => {
  const SCRATCH: string[] = [];
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "vf-leaf-acl-"));
    SCRATCH.push(dir);
    return dir;
  };
  const cleanup = () => {
    for (const dir of SCRATCH.splice(0)) rmSync(dir, { recursive: true, force: true });
  };

  const fakeAcl = (options: {
    fileInfo?: (handle: bigint, informationClass: number, output: Buffer) => number;
    verifyHandle?: () => void;
    createFile?: () => bigint;
  }) => {
    const calls = { migrated: [] as WindowsAuthorityPathKind[], closed: 0 };
    const binding = {
      invalidHandle: 0n,
      createFile: options.createFile ?? (() => 42n),
      closeHandle: () => {
        calls.closed += 1;
        return 1;
      },
      fileInfo:
        options.fileInfo ??
        ((_handle, informationClass, output: Buffer) => {
          if (informationClass !== WINDOWS_NATIVE_RECORD.FILE_ID_INFO_CLASS) return 0;
          output.writeUInt32LE(7, 0);
          output.writeBigUInt64LE(11n, 8);
          return 1;
        }),
    } as unknown as WindowsRecordNativeBindings;
    const authority = {
      currentUserId: () => Buffer.alloc(0),
      inspect: () => ({
        control: 0,
        owner: Buffer.alloc(0),
        daclPresent: true,
        daclDefaulted: false,
        aces: [],
      }),
      verifyHandle: options.verifyHandle ?? (() => undefined),
      migrateHandle: (_handle: bigint, kind: WindowsAuthorityPathKind) => calls.migrated.push(kind),
    } as unknown as WindowsPrivateAuthority;
    return { binding, authority, calls };
  };
  // The identity the real fd reports, so the fake ACL layer can reproduce it exactly.
  const reportedIdentity = (fd: number): { dev: bigint; ino: bigint } => {
    const stat = fs.fstatSync(fd, { bigint: true });
    return { dev: stat.dev, ino: stat.ino };
  };
  const identityInfo = (identity: { dev: bigint; ino: bigint }) => {
    return (handle: bigint, informationClass: number, output: Buffer): number => {
      if (handle !== 42n || informationClass !== WINDOWS_NATIVE_RECORD.FILE_ID_INFO_CLASS) return 0;
      output.writeUInt32LE(Number(identity.dev), 0);
      output.writeBigUInt64LE(identity.ino, 8);
      return 1;
    };
  };

  test("writes the owner-only ACL through a handle that reproduces the fd's identity", () => {
    const path = scratch();
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      let checks = 0;
      const { binding, authority, calls } = fakeAcl({
        fileInfo: identityInfo(reportedIdentity(fd)),
        // The first check is what a path with the inherited descriptor answers: repair, then answer
        // again on the same handle.
        verifyHandle: () => {
          if (checks++ === 0) throw new Error("permissive Windows authority DACL rejected");
        },
      });
      expect(repairWindowsLeafAcl(path, fd, { binding, authority })).toBe(true);
      expect(calls.migrated).toEqual([WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY]);
      expect(calls.closed).toBe(1);
      expect(checks).toBe(2);
    } finally {
      fs.closeSync(fd);
      cleanup();
    }
  });

  test("refuses to write when the path holds a different object than the fd", () => {
    const path = scratch();
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      const neighbour = reportedIdentity(fd);
      const { binding, authority, calls } = fakeAcl({
        fileInfo: identityInfo({ dev: neighbour.dev, ino: neighbour.ino + 1n }),
        verifyHandle: () => {
          throw new Error("permissive Windows authority DACL rejected");
        },
      });
      // A Number-typed comparison would accept this; the exact pair is what refuses it.
      expect(repairWindowsLeafAcl(path, fd, { binding, authority })).toBe(false);
      expect(calls.migrated).toHaveLength(0);
      expect(calls.closed).toBe(1);
    } finally {
      fs.closeSync(fd);
      cleanup();
    }
  });

  test("refuses a descriptor whose identity cannot be read", () => {
    expect(repairWindowsLeafAcl("C:\\state", -1)).toBe(false);
    const closed = fs.openSync(scratch(), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    fs.closeSync(closed);
    expect(repairWindowsLeafAcl("C:\\state", closed)).toBe(false);
  });

  test("refuses when the host has no Win32 security bindings at all", () => {
    if (process.platform === "win32") return;
    const path = scratch();
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      expect(repairWindowsLeafAcl(path, fd)).toBe(false);
    } finally {
      fs.closeSync(fd);
      cleanup();
    }
  });
});

describe("memoizedWindowsLockProvider", () => {
  test("constructs the provider once and reuses it", () => {
    // Laziness is the point: constructing it loads Windows FFI, which must not happen at
    // module init on POSIX, and must not happen twice on Windows either.
    let constructed = 0;
    const provider = fakeProvider(fakeLock());
    const get = memoizedWindowsLockProvider(() => {
      constructed += 1;
      return provider;
    });

    expect(constructed).toBe(0);
    expect(get()).toBe(provider);
    expect(get()).toBe(provider);
    expect(constructed).toBe(1);
  });

  test("retries construction after a failure rather than caching the error", () => {
    let attempts = 0;
    const provider = fakeProvider(fakeLock());
    const get = memoizedWindowsLockProvider(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("FFI not loadable yet");
      return provider;
    });

    expect(() => get()).toThrow("FFI not loadable yet");
    expect(get()).toBe(provider);
    expect(attempts).toBe(2);
  });
});

describe("Windows advisory locking", () => {
  test("records the lock against the fd when the kernel grants it", () => {
    const lock = fakeLock();
    const locks = new Map<number, WindowsKernelLock>();
    expect(tryWindowsAdvisoryLock(5, "C:\\state\\writer.lock", fakeProvider(lock), locks)).toBe(
      true,
    );
    expect(locks.get(5)).toBe(lock);
  });

  test("reports contention without recording anything", () => {
    const locks = new Map<number, WindowsKernelLock>();
    expect(tryWindowsAdvisoryLock(5, "C:\\state\\writer.lock", fakeProvider(null), locks)).toBe(
      false,
    );
    // A recorded entry here would make a later release look successful for a lock never held.
    expect(locks.size).toBe(0);
  });

  test("refuses to lock without a path", () => {
    const locks = new Map<number, WindowsKernelLock>();
    expect(() => tryWindowsAdvisoryLock(5, undefined, fakeProvider(fakeLock()), locks)).toThrow(
      "Windows advisory lock requires a path",
    );
    expect(locks.size).toBe(0);
  });

  test("release drops the entry and releases the kernel lock", () => {
    const lock = fakeLock();
    const locks = new Map<number, WindowsKernelLock>([[5, lock]]);
    releaseWindowsAdvisoryLock(5, locks);
    expect(locks.has(5)).toBe(false);
    expect(lock.released).toBe(1);
  });

  test("release refuses an fd that never took a lock", () => {
    expect(() => releaseWindowsAdvisoryLock(5, new Map())).toThrow(
      "Windows kernel lock not found for fd",
    );
  });

  test("a throwing release still clears the entry so the fd is not left looking locked", () => {
    const locks = new Map<number, WindowsKernelLock>([
      [
        5,
        {
          release() {
            throw new Error("CloseHandle failed");
          },
        } as unknown as WindowsKernelLock,
      ],
    ]);
    expect(() => releaseWindowsAdvisoryLock(5, locks)).toThrow("CloseHandle failed");
    expect(locks.has(5)).toBe(false);
  });
});
