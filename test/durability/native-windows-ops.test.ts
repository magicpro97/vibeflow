import { describe, expect, test } from "bun:test";
import {
  type WindowsPinRuntimeV1,
  memoizedWindowsLockProvider,
  pinWindowsDirectory,
  releaseWindowsAdvisoryLock,
  tryWindowsAdvisoryLock,
  windowsPinRuntime,
} from "../../src/durability/native-windows-ops.js";
import type { PinnedDirectory } from "../../src/durability/pinned-directory.js";
import type {
  WindowsKernelLock,
  WindowsKernelLockProvider,
} from "../../src/durability/windows-kernel-lock.js";

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
