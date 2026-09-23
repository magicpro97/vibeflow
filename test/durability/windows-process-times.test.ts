import { expect, test } from "bun:test";
import {
  type ProcessLockOwnerRuntime,
  type WindowsProcessTimesLoader,
  loadDarwinProcBinding,
  processStartIdentity,
} from "../../src/durability/lock-owner.js";
import {
  PROCESS_START_IDENTITY_PREFIX,
  WINDOWS_FILETIME_TICKS_PER_MICROSECOND,
  WINDOWS_FILETIME_TO_DOTNET_TICKS_OFFSET,
  formatProcessStartIdentity,
} from "../../src/durability/process-identity-contract.js";
import { loadWindowsProcessTimesBun } from "../../src/durability/windows-process-times-bun.js";
import { loadWindowsProcessTimesKoffi } from "../../src/durability/windows-process-times-koffi.js";

// Re-export check: loadDarwinProcBinding should still be exported (smoke).
test("lock-owner exports are intact after refactor", () => {
  expect(typeof loadDarwinProcBinding).toBe("function");
  expect(typeof processStartIdentity).toBe("function");
});

// ── FILETIME → .NET ticks conversion offset ──────────────────────────────────

test("WINDOWS_FILETIME_TO_DOTNET_TICKS_OFFSET is the exact .NET epoch delta", () => {
  // .NET ticks: 100-ns intervals since 0001-01-01 00:00:00 UTC
  // FILETIME:   100-ns intervals since 1601-01-01 00:00:00 UTC
  // Difference: days from 0001-01-01 to 1601-01-01 = 584388 days (Gregorian)
  // 584388 * 24 * 60 * 60 * 10_000_000 = 504_911_232_000_000_000
  expect(WINDOWS_FILETIME_TO_DOTNET_TICKS_OFFSET).toBe(504_911_232_000_000_000n);

  // Cross-check against two measured pairs. The CIM provider renders CreationDate with
  // microsecond precision, so the PowerShell value is the FILETIME with the sub-microsecond digits
  // dropped, plus the offset — not the raw FILETIME plus the offset.
  //   (a) issue #809 report: FILETIME 134346355485478757 -> 639257587485478750
  //   (b) live probe, Windows 11: FILETIME 134346606776543586 -> 639257838776543580
  for (const [filetime, powershellTicks] of [
    [134346355485478757n, 639257587485478750n],
    [134346606776543586n, 639257838776543580n],
  ] as const) {
    const truncated =
      (filetime / WINDOWS_FILETIME_TICKS_PER_MICROSECOND) * WINDOWS_FILETIME_TICKS_PER_MICROSECOND;
    expect(truncated + WINDOWS_FILETIME_TO_DOTNET_TICKS_OFFSET).toBe(powershellTicks);
  }
});

// ── Bun FFI loader ────────────────────────────────────────────────────────────

test("loadWindowsProcessTimesBun returns null when bun:ffi throws", () => {
  const result = loadWindowsProcessTimesBun(() => {
    throw new Error("injected bun:ffi failure");
  });
  expect(result).toBeNull();
});

test("loadWindowsProcessTimesBun reads the creation FILETIME back from the addressed out-buffer", () => {
  // FILETIME from the issue #809 measurement.
  const FILETIME = 134346355485478757n;
  // The mock stands in for the native write-through: ffi.ptr hands out an address per array, and
  // GetProcessTimes writes the creation time into the buffer at that address, which is the only way
  // to prove the addressing reaches the array the loader reads back.
  const addressed = new Map<number, BigUint64Array>();
  const calls: string[] = [];
  let capturedPid = 0;

  const fn = loadWindowsProcessTimesBun((_specifier) => ({
    FFIType: { u64: "u64", u32: "u32", i32: "i32" },
    dlopen: (_path: string, _symbols: unknown) => ({
      symbols: {
        OpenProcess: (access: number, _inherit: number, pid: number) => {
          calls.push("OpenProcess");
          expect(access).toBe(0x1000);
          capturedPid = pid;
          return 0xdeadbeefn;
        },
        CloseHandle: (_handle: unknown) => {
          calls.push("CloseHandle");
          return 1;
        },
        GetProcessTimes: (
          _handle: unknown,
          creationAddr: unknown,
          exitAddr: unknown,
          kernelAddr: unknown,
          userAddr: unknown,
        ) => {
          calls.push("GetProcessTimes");
          expect(exitAddr).not.toBe(creationAddr);
          expect(kernelAddr).not.toBe(creationAddr);
          expect(userAddr).not.toBe(creationAddr);
          const target = addressed.get(Number(creationAddr));
          if (target) target[0] = FILETIME;
          return 1;
        },
      },
    }),
    ptr: (arr: BigUint64Array) => {
      const address = addressed.size + 1;
      addressed.set(address, arr);
      return address;
    },
    toArrayBuffer: (_ptr: number, _offset: number, len: number) => new ArrayBuffer(len),
  }));

  expect(fn).not.toBeNull();
  const result = fn?.(41);
  expect(calls).toContain("OpenProcess");
  expect(calls).toContain("GetProcessTimes");
  expect(calls).toContain("CloseHandle");
  expect(capturedPid).toBe(41);
  expect(result).toBe(FILETIME);
});

test("loadWindowsProcessTimesBun returns 0n when the native call zero-fills the out-buffer", () => {
  const fn = loadWindowsProcessTimesBun((_specifier) => ({
    FFIType: { u64: "u64", u32: "u32", i32: "i32" },
    dlopen: () => ({
      symbols: {
        OpenProcess: () => 0xdeadbeefn,
        CloseHandle: () => 1,
        GetProcessTimes: () => 1,
      },
    }),
    ptr: (_arr: BigUint64Array) => 0,
    toArrayBuffer: (_ptr: number, _offset: number, len: number) => new ArrayBuffer(len),
  }));

  // The loader returns the untouched 0n; windowsStartIdentity filters filetime <= 0n to null.
  expect(fn?.(41)).toBe(0n);
});

test("loadWindowsProcessTimesBun returns null when OpenProcess returns 0 (access denied)", () => {
  const fn = loadWindowsProcessTimesBun((_specifier) => ({
    FFIType: { u64: "u64", u32: "u32", i32: "i32" },
    dlopen: () => ({
      symbols: {
        OpenProcess: () => 0n,
        CloseHandle: () => 1,
        GetProcessTimes: () => 1,
      },
    }),
    ptr: () => 0,
    toArrayBuffer: () => new ArrayBuffer(8),
  }));
  expect(fn?.(41)).toBeNull();
});

test("loadWindowsProcessTimesBun returns null when GetProcessTimes returns 0 (failure)", () => {
  let closed = false;
  const fn = loadWindowsProcessTimesBun((_specifier) => ({
    FFIType: { u64: "u64", u32: "u32", i32: "i32" },
    dlopen: () => ({
      symbols: {
        OpenProcess: () => 0xcafen,
        CloseHandle: () => {
          closed = true;
          return 1;
        },
        GetProcessTimes: () => 0,
      },
    }),
    ptr: () => 0,
    toArrayBuffer: () => new ArrayBuffer(8),
  }));
  expect(fn?.(41)).toBeNull();
  expect(closed).toBeTrue();
});

// ── Koffi FFI loader ──────────────────────────────────────────────────────────

test("loadWindowsProcessTimesKoffi returns null when koffi throws", () => {
  const result = loadWindowsProcessTimesKoffi(() => {
    throw new Error("injected koffi failure");
  });
  expect(result).toBeNull();
});

test("loadWindowsProcessTimesKoffi calls OpenProcess and GetProcessTimes with injected module", () => {
  const calls: string[] = [];
  let capturedPid = 0;
  const LOW = 0xdeadbeef;
  const HIGH = 0x01d50000;
  const FILETIME = (BigInt(HIGH) << 32n) | BigInt(LOW >>> 0);

  const fn = loadWindowsProcessTimesKoffi((_specifier) => {
    // Minimal koffi stub matching the used surface.
    const funcs: Record<string, (...args: unknown[]) => unknown> = {};
    return {
      load: (_dll: string) => ({
        func: (_conv: string, name: string, _ret: unknown, _args: unknown) => {
          if (name === "OpenProcess") {
            return (access: number, _inh: number, pid: number) => {
              calls.push("OpenProcess");
              expect(access).toBe(0x1000);
              capturedPid = pid;
              return 0x1234n;
            };
          }
          if (name === "CloseHandle") {
            return (_h: unknown) => {
              calls.push("CloseHandle");
              return 1;
            };
          }
          if (name === "GetProcessTimes") {
            return (
              _h: unknown,
              creation: unknown[],
              _exit: unknown[],
              _k: unknown[],
              _u: unknown[],
            ) => {
              calls.push("GetProcessTimes");
              creation[0] = { dwLowDateTime: LOW, dwHighDateTime: HIGH };
              return 1;
            };
          }
          return funcs[name] ?? (() => 0);
        },
      }),
      opaque: () => "opaque",
      pointer: (t: unknown) => `pointer(${String(t)})`,
      out: (t: unknown) => `out(${String(t)})`,
      struct: (fields: Record<string, unknown>) => fields,
      decode: (_val: unknown, _type: unknown) => ({ dwLowDateTime: LOW, dwHighDateTime: HIGH }),
    };
  });

  expect(fn).not.toBeNull();
  const result = fn?.(41);
  expect(calls).toContain("OpenProcess");
  expect(calls).toContain("GetProcessTimes");
  expect(calls).toContain("CloseHandle");
  expect(capturedPid).toBe(41);
  expect(result).toBe(FILETIME);
});

test("loadWindowsProcessTimesKoffi never decodes the struct koffi already put in the out slot", () => {
  const FILETIME = 134346355485478757n;
  const decodes: unknown[] = [];
  const fn = loadWindowsProcessTimesKoffi((_specifier) => ({
    load: () => ({
      func: (_convention: unknown, name: string) => {
        if (name === "OpenProcess") return () => 0x1234n;
        if (name === "CloseHandle") return () => 1;
        return (_h: unknown, creation: unknown[]) => {
          creation[0] = {
            dwLowDateTime: Number(FILETIME & 0xffffffffn),
            dwHighDateTime: Number(FILETIME >> 32n),
          };
          return 1;
        };
      },
    }),
    opaque: () => "opaque",
    pointer: () => "ptr",
    out: () => "out",
    struct: (fields: unknown) => fields,
    // Real koffi rejects a struct that is not a pointer/Buffer with this exact message; the module
    // must read the out slot directly. Regression guard: this shipped once and passed a mocked
    // test, then failed the package smoke job on the node/koffi path.
    decode: (...args: unknown[]) => {
      decodes.push(args);
      throw new Error("Unexpected Object value for reference, expected pointer");
    },
  }));

  expect(fn?.(41)).toBe(FILETIME);
  expect(decodes).toHaveLength(0);
});

test("loadWindowsProcessTimesKoffi returns null when OpenProcess returns 0n", () => {
  const fn = loadWindowsProcessTimesKoffi((_specifier) => ({
    load: () => ({
      func: (_conv: unknown, name: string) => {
        if (name === "OpenProcess") return () => 0n;
        return () => 0;
      },
    }),
    opaque: () => "opaque",
    pointer: () => "ptr",
    out: () => "out",
    struct: (f: unknown) => f,
    decode: () => ({ dwLowDateTime: 0, dwHighDateTime: 0 }),
  }));
  expect(fn?.(41)).toBeNull();
});

test("loadWindowsProcessTimesKoffi returns null when GetProcessTimes returns 0 (failure)", () => {
  let closed = false;
  const fn = loadWindowsProcessTimesKoffi((_specifier) => ({
    load: () => ({
      func: (_conv: unknown, name: string) => {
        if (name === "OpenProcess") return () => 0xcafen;
        if (name === "CloseHandle")
          return () => {
            closed = true;
            return 1;
          };
        if (name === "GetProcessTimes")
          return (_h: unknown, c: unknown[], ..._rest: unknown[]) => {
            c[0] = null;
            return 0;
          };
        return () => 0;
      },
    }),
    opaque: () => "opaque",
    pointer: () => "ptr",
    out: () => "out",
    struct: (f: unknown) => f,
    decode: () => ({ dwLowDateTime: 0, dwHighDateTime: 0 }),
  }));
  expect(fn?.(41)).toBeNull();
  expect(closed).toBeTrue();
});

// ── windowsStartIdentity integration via processStartIdentity ─────────────────

test("Windows FFI path returns identity encoded as .NET ticks (FILETIME + offset)", () => {
  // FILETIME from issue #809 measurement
  const FILETIME = 134346355485478757n;
  const EXPECTED_DOTNET_TICKS =
    (FILETIME / WINDOWS_FILETIME_TICKS_PER_MICROSECOND) * WINDOWS_FILETIME_TICKS_PER_MICROSECOND +
    WINDOWS_FILETIME_TO_DOTNET_TICKS_OFFSET;
  const expectedIdentity = formatProcessStartIdentity(
    PROCESS_START_IDENTITY_PREFIX.WINDOWS,
    String(EXPECTED_DOTNET_TICKS),
  );

  const timesLoader: WindowsProcessTimesLoader = {
    isBun: false,
    requireModule: (_specifier) => ({
      load: () => ({
        func: (_conv: unknown, name: string) => {
          if (name === "OpenProcess") return () => 0x1234n;
          if (name === "CloseHandle") return () => 1;
          if (name === "GetProcessTimes")
            return (_h: unknown, creation: unknown[], ..._rest: unknown[]) => {
              creation[0] = {
                dwLowDateTime: Number(FILETIME & 0xffffffffn),
                dwHighDateTime: Number(FILETIME >> 32n),
              };
              return 1;
            };
          return () => 0;
        },
      }),
      opaque: () => "opaque",
      pointer: () => "ptr",
      out: () => "out",
      struct: (f: unknown) => f,
      decode: (_val: unknown, _type: unknown) => ({
        dwLowDateTime: Number(FILETIME & 0xffffffffn),
        dwHighDateTime: Number(FILETIME >> 32n),
      }),
    }),
  };

  const result = processStartIdentity(41, {
    platform: "win32",
    windowsProcessTimesLoader: timesLoader,
  });
  expect(result).toBe(expectedIdentity);
  expect(result?.startsWith("win32:")).toBeTrue();
});

test("Windows FFI path fails closed when GetProcessTimes returns 0 (never falls back to ps)", () => {
  let execCalled = false;
  const timesLoader: WindowsProcessTimesLoader = {
    isBun: false,
    requireModule: (_specifier) => ({
      load: () => ({
        func: (_conv: unknown, name: string) => {
          if (name === "OpenProcess") return () => 0x1234n;
          if (name === "CloseHandle") return () => 1;
          if (name === "GetProcessTimes")
            return (_h: unknown, c: unknown[], ..._rest: unknown[]) => {
              c[0] = null;
              return 0;
            };
          return () => 0;
        },
      }),
      opaque: () => "opaque",
      pointer: () => "ptr",
      out: () => "out",
      struct: (f: unknown) => f,
      decode: () => ({ dwLowDateTime: 0, dwHighDateTime: 0 }),
    }),
  };

  const result = processStartIdentity(41, {
    platform: "win32",
    windowsSystemRoot: "C:\\Windows",
    windowsProcessTimesLoader: timesLoader,
    execFileSync: (() => {
      execCalled = true;
      return "";
    }) as never,
  });
  expect(result).toBeNull();
  expect(execCalled).toBeFalse();
});

test("Windows FFI path fails closed when filetime is 0 (never falls back to ps)", () => {
  let execCalled = false;
  const timesLoader: WindowsProcessTimesLoader = {
    isBun: false,
    requireModule: (_specifier) => ({
      load: () => ({
        func: (_conv: unknown, name: string) => {
          if (name === "OpenProcess") return () => 0x1234n;
          if (name === "CloseHandle") return () => 1;
          if (name === "GetProcessTimes")
            return (_h: unknown, creation: unknown[], ..._rest: unknown[]) => {
              creation[0] = { dwLowDateTime: 0, dwHighDateTime: 0 };
              return 1;
            };
          return () => 0;
        },
      }),
      opaque: () => "opaque",
      pointer: () => "ptr",
      out: () => "out",
      struct: (f: unknown) => f,
      decode: () => ({ dwLowDateTime: 0, dwHighDateTime: 0 }),
    }),
  };

  const result = processStartIdentity(41, {
    platform: "win32",
    windowsSystemRoot: "C:\\Windows",
    windowsProcessTimesLoader: timesLoader,
    execFileSync: (() => {
      execCalled = true;
      return "";
    }) as never,
  });
  expect(result).toBeNull();
  expect(execCalled).toBeFalse();
});

test("processStartIdentity loads the production GetProcessTimes fn once and caches it (no loader seam)", () => {
  let execCalls = 0;
  const runtime = {
    platform: "win32",
    windowsSystemRoot: "C:\\Windows",
    execFileSync: ((_cmd: string, _args: string[], _opts: unknown) => {
      execCalls += 1;
      return "638918820000000000";
    }) as never,
  } as unknown as ProcessLockOwnerRuntime;

  // No injected loader: this is the path production takes, where IS_BUN/requireModule pick the
  // FFI binding at runtime and the result is cached at module level.
  const first = processStartIdentity(process.pid, runtime);
  const second = processStartIdentity(process.pid, runtime);

  // Stable on every host: on Windows the FFI binding answers, elsewhere the load fails and the
  // PowerShell fallback answers, and either way the second call reuses the cached loader.
  expect(first).not.toBeNull();
  expect(second).toBe(first);
  expect(first?.startsWith("win32:")).toBeTrue();
  if (execCalls > 0) expect(first).toBe("win32:638918820000000000");
});

test("Windows falls back to PowerShell when FFI loader itself throws during load", () => {
  const psOutput = "638918820000000000";
  let execCalled = false;
  const timesLoader: WindowsProcessTimesLoader = {
    isBun: false,
    requireModule: () => {
      throw new Error("koffi not available");
    },
  };

  const result = processStartIdentity(41, {
    platform: "win32",
    windowsSystemRoot: "C:\\Windows",
    windowsProcessTimesLoader: timesLoader,
    execFileSync: ((_cmd: string, _args: string[], _opts: unknown) => {
      execCalled = true;
      return psOutput;
    }) as never,
  });
  expect(execCalled).toBeTrue();
  expect(result).toBe(`win32:${psOutput}`);
});

test("Windows fails closed when neither FFI nor PowerShell can answer", () => {
  const timesLoader: WindowsProcessTimesLoader = {
    isBun: false,
    requireModule: () => {
      throw new Error("no FFI");
    },
  };

  const result = processStartIdentity(41, {
    platform: "win32",
    windowsSystemRoot: "C:\\Windows",
    windowsProcessTimesLoader: timesLoader,
    execFileSync: (() => {
      throw new Error("powershell timeout");
    }) as never,
  });
  expect(result).toBeNull();
});
