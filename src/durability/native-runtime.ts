import * as fs from "node:fs";
import { createRequire } from "node:module";
import { arch, constants as osConstants } from "node:os";
import { DurabilityError, durabilityError } from "./errors.js";
import { RUNTIME_PLATFORM } from "./process-identity-contract.js";

export interface NativeBindings {
  openat: (
    directoryFd: number,
    name: string,
    flags: number,
    modeType: "int",
    mode: number,
  ) => number;
  mkdirat: (directoryFd: number, name: string, mode: number) => number;
  fchmodat: (directoryFd: number, name: string, mode: number, flags: number) => number;
  renameat: (fromFd: number, from: string, toFd: number, to: string) => number;
  linkat: (fromFd: number, from: string, toFd: number, to: string, flags: number) => number;
  unlinkat: (directoryFd: number, name: string, flags: number) => number;
  flock: (fd: number, operation: number) => number;
  fcntl: ((fd: number, command: number, pointerType: "void *", output: Buffer) => number) | null;
}

export const IS_BUN =
  typeof (process.versions as Record<string, string | undefined>).bun === "string";
export const O_CLOEXEC = process.platform === RUNTIME_PLATFORM.DARWIN ? 0x01000000 : 0o2000000;
const RUNTIME_REQUIRE = createRequire(import.meta.url);

let bindings: NativeBindings | null = null;
let unavailableReason = "native durability is not initialized";
let errnoReader: () => number = () => 0;
let errnoTable: Record<string, number> = osConstants.errno;
let nativeLibrary: unknown = null;

function cString(value: string): Buffer {
  if (value.includes("\0")) durabilityError("unsafe_path", "native path contains NUL");
  return Buffer.from(`${value}\0`, "utf8");
}

export function linuxLibcCandidatesFromMaps(maps: string, architecture: string): string[] {
  const mapped: string[] = [];
  for (const line of maps.split("\n")) {
    const path = line.match(/\s(\/\S*(?:libc\.so\.6|ld-musl-[^/\s]+\.so\.1))\s*$/)?.[1];
    if (path && !mapped.includes(path)) mapped.push(path);
  }
  const muslArch =
    architecture === "x64" ? "x86_64" : architecture === "arm64" ? "aarch64" : architecture;
  return [
    ...new Set([
      ...mapped,
      "libc.so.6",
      `libc.musl-${muslArch}.so.1`,
      `/lib/ld-musl-${muslArch}.so.1`,
    ]),
  ];
}

function linuxLibcCandidates(): string[] {
  let maps = "";
  try {
    maps = fs.readFileSync("/proc/self/maps", "utf8");
  } catch {
    // Missing procfs is supported; the ordered libc fallback list remains authoritative.
  }
  return linuxLibcCandidatesFromMaps(maps, arch());
}

export function loadBunBindings(): NativeBindings {
  const ffi = RUNTIME_REQUIRE("bun:ffi") as typeof import("bun:ffi");
  const { FFIType } = ffi;
  const errnoSymbol = process.platform === RUNTIME_PLATFORM.DARWIN ? "__error" : "__errno_location";
  const definitions = {
    openat: {
      args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    mkdirat: { args: [FFIType.i32, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
    fchmodat: {
      args: [FFIType.i32, FFIType.cstring, FFIType.u32, FFIType.i32],
      returns: FFIType.i32,
    },
    renameat: {
      args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring],
      returns: FFIType.i32,
    },
    linkat: {
      args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.i32],
      returns: FFIType.i32,
    },
    unlinkat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [errnoSymbol]: { args: [], returns: FFIType.ptr },
  } as const;
  let library: ReturnType<typeof ffi.dlopen> | null = null;
  let failure: unknown;
  const candidates =
    process.platform === RUNTIME_PLATFORM.DARWIN
      ? ["/usr/lib/libSystem.B.dylib"]
      : linuxLibcCandidates();
  for (const candidate of candidates) {
    try {
      library = ffi.dlopen(candidate, definitions);
      break;
    } catch (error) {
      failure = error;
    }
  }
  if (!library) durabilityError("unsupported", "Bun cannot load a supported system libc", failure);
  nativeLibrary = library;
  const symbols = library.symbols as unknown as Record<string, (...args: unknown[]) => number>;
  const errnoAddress = symbols[errnoSymbol];
  if (!errnoAddress) durabilityError("unsupported", `Bun FFI is missing ${errnoSymbol}`);
  errnoReader = () => ffi.read.i32(errnoAddress() as import("bun:ffi").Pointer, 0);
  return {
    openat: (fd, name, flags, _modeType, mode) =>
      symbols.openat?.(fd, cString(name), flags, mode) ?? -1,
    mkdirat: (fd, name, mode) => symbols.mkdirat?.(fd, cString(name), mode) ?? -1,
    fchmodat: (fd, name, mode, flags) => symbols.fchmodat?.(fd, cString(name), mode, flags) ?? -1,
    renameat: (fromFd, from, toFd, to) =>
      symbols.renameat?.(fromFd, cString(from), toFd, cString(to)) ?? -1,
    linkat: (fromFd, from, toFd, to, flags) =>
      symbols.linkat?.(fromFd, cString(from), toFd, cString(to), flags) ?? -1,
    unlinkat: (fd, name, flags) => symbols.unlinkat?.(fd, cString(name), flags) ?? -1,
    flock: (fd, operation) => symbols.flock?.(fd, operation) ?? -1,
    fcntl: null,
  };
}

export function loadNodeBindings(): NativeBindings {
  const koffi = RUNTIME_REQUIRE("koffi") as typeof import("koffi").default;
  const library = koffi.load(
    process.platform === RUNTIME_PLATFORM.DARWIN ? "/usr/lib/libSystem.B.dylib" : null,
  );
  nativeLibrary = library;
  errnoReader = koffi.errno;
  errnoTable = koffi.os.errno;
  return {
    openat: library.func("int openat(int, const char *, int, ...)") as NativeBindings["openat"],
    mkdirat: library.func(
      "int mkdirat(int, const char *, unsigned int)",
    ) as NativeBindings["mkdirat"],
    fchmodat: library.func(
      "int fchmodat(int, const char *, unsigned int, int)",
    ) as NativeBindings["fchmodat"],
    renameat: library.func(
      "int renameat(int, const char *, int, const char *)",
    ) as NativeBindings["renameat"],
    linkat: library.func(
      "int linkat(int, const char *, int, const char *, int)",
    ) as NativeBindings["linkat"],
    unlinkat: library.func("int unlinkat(int, const char *, int)") as NativeBindings["unlinkat"],
    flock: library.func("int flock(int, int)") as NativeBindings["flock"],
    fcntl:
      process.platform === RUNTIME_PLATFORM.DARWIN
        ? (library.func("int fcntl(int, int, ...)") as NativeBindings["fcntl"])
        : null,
  };
}

export interface NativeRuntimeInitializationV1 {
  bindings: NativeBindings | null;
  unavailableReason: string;
}

export function initializeNativeRuntime(input: {
  disabled: boolean;
  platform: string;
  isBun: boolean;
}): NativeRuntimeInitializationV1 {
  try {
    if (input.disabled)
      return { bindings: null, unavailableReason: "native durability was disabled by the runtime" };
    if (input.platform !== RUNTIME_PLATFORM.DARWIN && input.platform !== RUNTIME_PLATFORM.LINUX)
      return {
        bindings: null,
        unavailableReason: `native durability is unsupported on ${input.platform}`,
      };
    return {
      bindings: input.isBun ? loadBunBindings() : loadNodeBindings(),
      unavailableReason: "native durability is not initialized",
    };
  } catch (error) {
    return {
      bindings: null,
      unavailableReason: `native durability load failed: ${String(error)}`,
    };
  }
}

const initialized = initializeNativeRuntime({
  disabled: process.env.VF_TEST_DISABLE_NATIVE_DURABILITY === "1",
  platform: process.platform,
  isBun: IS_BUN,
});
bindings = initialized.bindings;
unavailableReason = initialized.unavailableReason;

export function native(): NativeBindings {
  if (!bindings || nativeLibrary === null) durabilityError("unsupported", unavailableReason);
  return bindings;
}

export function errnoIs(name: string): boolean {
  return errnoReader() === errnoTable[name];
}

export function errnoValue(name: string): number {
  return errnoTable[name] ?? 0;
}

export function classifySyscallError(label: string, code: number): DurabilityError {
  const unsupported =
    code === errnoTable.ENOSYS || code === errnoTable.ENOTSUP || code === errnoTable.EOPNOTSUPP;
  return new DurabilityError(
    unsupported ? "unsupported" : "unsafe_path",
    unsupported
      ? `${label} is unsupported by this filesystem/runtime (errno ${code})`
      : `${label} failed (errno ${code})`,
  );
}

export function syscallFailure(label: string): never {
  throw classifySyscallError(label, errnoReader());
}

export function assertNativeDurabilityAvailable(): void {
  native();
}
