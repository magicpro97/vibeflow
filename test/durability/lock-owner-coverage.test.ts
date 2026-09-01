import { expect, spyOn, test } from "bun:test";
import { loadDarwinProcBinding, processStartIdentity } from "../../src/durability/lock-owner.js";

test("Darwin native loader supports Node Koffi and fails closed without poisoning production", () => {
  const procPidInfo = () => 136;
  const binding = loadDarwinProcBinding({
    isBun: false,
    requireModule: (specifier) => {
      expect(specifier).toBe("koffi");
      return {
        load: (path: string) => {
          expect(path).toBe("/usr/lib/libproc.dylib");
          return {
            func: (signature: string) => {
              expect(signature).toBe("int proc_pidinfo(int, int, uint64, void *, int)");
              return procPidInfo;
            },
          };
        },
      };
    },
  });
  expect(binding?.procPidInfo).toBe(procPidInfo);
  expect(
    loadDarwinProcBinding({
      isBun: false,
      requireModule: () => {
        throw new Error("injected native loader failure");
      },
    }),
  ).toBeNull();
});

test("fallback ps identity returns exact text and fails closed on command failure", () => {
  const calls: string[][] = [];
  expect(
    processStartIdentity(41, {
      platform: "freebsd",
      execFileSync: ((_command: string, args: string[]) => {
        calls.push(args);
        return "Mon Aug 26 12:34:56 2026\n";
      }) as never,
    }),
  ).toBe("freebsd:Mon Aug 26 12:34:56 2026");
  expect(calls).toEqual([["-o", "lstart=", "-p", "41"]]);
  expect(
    processStartIdentity(42, {
      platform: "freebsd",
      execFileSync: (() => {
        throw new Error("injected ps failure");
      }) as never,
    }),
  ).toBeNull();
});

test.if(process.platform === "darwin")(
  "Darwin identity fails closed when its fixed native output allocation fails",
  () => {
    const originalAlloc = Buffer.alloc;
    const alloc = spyOn(Buffer, "alloc").mockImplementation(((size, fill, encoding) => {
      if (size === 136) throw new Error("injected native output allocation failure");
      return originalAlloc(size, fill as never, encoding);
    }) as typeof Buffer.alloc);
    try {
      expect(processStartIdentity(41, { platform: "darwin" })).toBeNull();
    } finally {
      alloc.mockRestore();
    }
  },
);

test("Darwin native loader supports Bun bun:ffi with an injected module", () => {
  let procCalls = 0;
  const binding = loadDarwinProcBinding({
    isBun: true,
    requireModule: (specifier) => {
      expect(specifier).toBe("bun:ffi");
      return {
        FFIType: { i32: "i32", u64: "u64", ptr: "ptr" },
        dlopen: (path: string) => {
          expect(path).toBe("/usr/lib/libproc.dylib");
          return {
            symbols: {
              proc_pidinfo: () => {
                procCalls++;
                return 136;
              },
            },
          };
        },
      };
    },
  });
  expect(binding?.procPidInfo(1, 3, 0, Buffer.alloc(136), 136)).toBe(136);
  expect(procCalls).toBe(1);
});

test("injected Darwin loader resolves a full process start identity", () => {
  const identity = processStartIdentity(41, {
    platform: "darwin",
    darwinProcLoader: {
      isBun: false,
      requireModule: (specifier) => {
        expect(specifier).toBe("koffi");
        const func = (
          _pid: number,
          _flavor: number,
          _arg: number,
          output: Buffer,
          outputBytes: number,
        ): number => {
          output.writeBigUInt64LE(1699999999n, 120);
          output.writeBigUInt64LE(0n, 128);
          return outputBytes;
        };
        return { load: () => ({ func: (_signature: string) => func }) };
      },
    },
  });
  expect(identity).toBe("darwin:1699999999:0");
});

test("injected Darwin loader rejects short, zero, and overflowed native outputs", () => {
  const funcFor = (returned: number, seconds: bigint, microseconds: bigint) => {
    const fn = (
      _pid: number,
      _flavor: number,
      _arg: number,
      output: Buffer,
      outputBytes: number,
    ): number => {
      output.writeBigUInt64LE(seconds, 120);
      output.writeBigUInt64LE(microseconds, 128);
      return returned;
    };
    return { load: () => ({ func: (_signature: string) => fn }) };
  };
  expect(
    processStartIdentity(41, {
      platform: "darwin",
      darwinProcLoader: { isBun: false, requireModule: () => funcFor(3, 1n, 2n) },
    }),
  ).toBeNull();
  expect(
    processStartIdentity(42, {
      platform: "darwin",
      darwinProcLoader: { isBun: false, requireModule: () => funcFor(136, 0n, 1n) },
    }),
  ).toBeNull();
  expect(
    processStartIdentity(43, {
      platform: "darwin",
      darwinProcLoader: { isBun: false, requireModule: () => funcFor(136, 1n, 1000000n) },
    }),
  ).toBeNull();
});

test("injected Darwin loader failures throw and fail closed from the loader itself", () => {
  expect(
    processStartIdentity(44, {
      platform: "darwin",
      darwinProcLoader: {
        isBun: false,
        requireModule: () => {
          throw new Error("injected loader failure");
        },
      },
    }),
  ).toBeNull();
  expect(
    processStartIdentity(45, {
      platform: "darwin",
      darwinProcLoader: {
        isBun: false,
        requireModule: () => ({
          load: () => ({
            func: () => () => {
              throw new Error("injected probe failure");
            },
          }),
        }),
      },
    }),
  ).toBeNull();
});

test("real Darwin loader fails closed off darwin and caches its outcome", () => {
  const first = processStartIdentity(46, { platform: "darwin" });
  const second = processStartIdentity(47, { platform: "darwin" });
  // On a real Darwin host the loaded probe either resolves an identity or the
  // call also fails closed; the contract is that the cached loader outcome is
  // stable across calls (lines 247-254), not that a specific PID resolves.
  expect(first === null || /^darwin:/.test(first)).toBeTrue();
  expect(first).toBe(second);
  if (process.platform !== "darwin") expect(first).toBeNull();
});
