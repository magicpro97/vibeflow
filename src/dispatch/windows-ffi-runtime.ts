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
