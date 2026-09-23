import { createRequire } from "node:module";

export interface WindowsFfiRuntime {
  isBun: boolean;
  requireModule: (specifier: "bun:ffi" | "koffi") => unknown;
}

const IS_BUN = typeof (process.versions as Record<string, string | undefined>).bun === "string";
const RUNTIME_REQUIRE = createRequire(import.meta.url);

export const DEFAULT_WINDOWS_FFI_RUNTIME: WindowsFfiRuntime = {
  isBun: IS_BUN,
  requireModule: (specifier) => RUNTIME_REQUIRE(specifier),
};

/**
 * Address helpers for Bun FFI declarations that pass Win32 HANDLE/PSID/pointer arguments.
 *
 * Win32 hands those back as plain integers, and Bun refuses to coerce an integer into an
 * FFIType.ptr argument ("Unable to convert 888 to a pointer"), so such arguments are declared
 * u64 and every value goes through `address` first.
 */
export function windowsFfiAddressing(ffi: typeof import("bun:ffi")): {
  address: (value: unknown) => bigint;
  view: (value: unknown, length: number) => Uint8Array;
} {
  const address = (value: unknown): bigint => {
    if (value === null || value === undefined) return 0n;
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(value);
    return BigInt(ffi.ptr(value as NodeJS.TypedArray));
  };
  return {
    address,
    // ffi.toArrayBuffer takes Bun's Pointer, a JS number: handing it a bigint silently yields an
    // empty buffer rather than throwing, so narrow before reading.
    view: (value, length) =>
      new Uint8Array(ffi.toArrayBuffer(Number(address(value)) as never, 0, length)),
  };
}
