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
