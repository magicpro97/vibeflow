import { closeSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch } from "node:os";
import { linuxLibcCandidatesFromMaps } from "../../durability/native-runtime.js";

const require = createRequire(import.meta.url);
const IS_BUN = typeof (process.versions as Record<string, string | undefined>).bun === "string";
const NAME_OFFSET = process.platform === "darwin" ? 21 : 19;
const RECLEN_OFFSET = 16;

export interface DirectoryApiV1 {
  duplicate(fd: number): number;
  open(fd: number): unknown;
  next(directory: unknown): Uint8Array | null;
  close(directory: unknown): number;
}

export interface BunDirectoryRuntimeV1 {
  platform: NodeJS.Platform;
  architecture: string;
  readMaps(): string;
  ffi: Pick<typeof import("bun:ffi"), "FFIType" | "dlopen" | "toBuffer">;
}

export interface NodeDirectoryRuntimeV1 {
  platform: NodeJS.Platform;
  koffi: Pick<typeof import("koffi"), "load" | "view">;
}

function readName(bytes: Uint8Array): string {
  const end = bytes.indexOf(0, NAME_OFFSET);
  if (end < NAME_OFFSET) throw new Error("invalid directory entry");
  const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(NAME_OFFSET, end));
  if (!name || name.includes("/") || name.includes("\0"))
    throw new Error("invalid directory entry");
  return name;
}

/** Loads Bun's libc directory reader through an injectable platform authority. */
export function loadBunDirectoryApi(
  runtime: BunDirectoryRuntimeV1 = {
    platform: process.platform,
    architecture: arch(),
    readMaps: () => readFileSync("/proc/self/maps", "utf8"),
    ffi: require("bun:ffi") as typeof import("bun:ffi"),
  },
): DirectoryApiV1 {
  const { ffi } = runtime;
  const { FFIType } = ffi;
  const definitions = {
    dup: { args: [FFIType.i32], returns: FFIType.i32 },
    fdopendir: { args: [FFIType.i32], returns: FFIType.ptr },
    readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
    closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
  } as const;
  let maps = "";
  if (runtime.platform === "linux") {
    try {
      maps = runtime.readMaps();
    } catch {
      // Missing procfs is supported; the ordered libc fallback list remains authoritative.
    }
  }
  const candidates =
    runtime.platform === "darwin"
      ? ["/usr/lib/libSystem.B.dylib"]
      : linuxLibcCandidatesFromMaps(maps, runtime.architecture);
  let library: ReturnType<typeof ffi.dlopen> | null = null;
  let failure: unknown;
  for (const candidate of candidates) {
    try {
      library = ffi.dlopen(candidate, definitions);
      break;
    } catch (error) {
      failure = error;
    }
  }
  if (!library) throw new Error("cannot load a supported system libc", { cause: failure });
  const symbols = library.symbols as unknown as {
    dup(fd: number): number;
    fdopendir(fd: number): import("bun:ffi").Pointer | null;
    readdir(directory: import("bun:ffi").Pointer): import("bun:ffi").Pointer | null;
    closedir(directory: import("bun:ffi").Pointer): number;
  };
  return {
    duplicate: (fd) => symbols.dup(fd),
    open: (fd) => symbols.fdopendir(fd),
    next: (directory) => {
      const pointer = symbols.readdir(directory as import("bun:ffi").Pointer);
      if (!pointer) return null;
      const prefix = ffi.toBuffer(pointer, 0, NAME_OFFSET);
      const length = prefix.readUInt16LE(RECLEN_OFFSET);
      if (length <= NAME_OFFSET || length > 4096) throw new Error("invalid directory entry");
      return ffi.toBuffer(pointer, 0, length);
    },
    close: (directory) => symbols.closedir(directory as import("bun:ffi").Pointer),
  };
}

/** Loads Node's koffi directory reader through an injectable platform authority. */
export function loadNodeDirectoryApi(
  runtime: NodeDirectoryRuntimeV1 = {
    platform: process.platform,
    koffi: require("koffi") as typeof import("koffi"),
  },
): DirectoryApiV1 {
  const { koffi } = runtime;
  const library = koffi.load(runtime.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : null);
  const duplicate = library.func("int dup(int)");
  const open = library.func("void *fdopendir(int)");
  const next = library.func("void *readdir(void *)");
  const close = library.func("int closedir(void *)");
  return {
    duplicate: (fd) => duplicate(fd) as number,
    open: (fd) => open(fd),
    next: (directory) => {
      const pointer = next(directory);
      if (!pointer) return null;
      const prefix = Buffer.from(koffi.view(pointer, NAME_OFFSET));
      const length = prefix.readUInt16LE(RECLEN_OFFSET);
      if (length <= NAME_OFFSET || length > 4096) throw new Error("invalid directory entry");
      return new Uint8Array(koffi.view(pointer, length));
    },
    close: (directory) => close(directory) as number,
  };
}

let cached: DirectoryApiV1 | null = null;

/** Reads one pinned descriptor using a supplied native API, including all cleanup semantics. */
export function readDirectoryNamesUsingApi(fd: number, api: DirectoryApiV1): string[] {
  const duplicate = api.duplicate(fd);
  if (duplicate < 0) throw new Error("cannot duplicate directory descriptor");
  const directory = api.open(duplicate);
  if (!directory) {
    closeSync(duplicate);
    throw new Error("cannot open directory descriptor");
  }
  const names: string[] = [];
  let failed = false;
  let primary: unknown;
  try {
    for (;;) {
      const entry = api.next(directory);
      if (!entry) break;
      const name = readName(entry);
      if (name !== "." && name !== "..") names.push(name);
    }
  } catch (error) {
    failed = true;
    primary = error;
  }
  const closeFailed = api.close(directory) !== 0;
  if (failed) throw primary;
  if (closeFailed) throw new Error("cannot close directory descriptor");
  return names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

export function readDirectoryNamesAt(fd: number): string[] {
  if (!cached) cached = IS_BUN ? loadBunDirectoryApi() : loadNodeDirectoryApi();
  return readDirectoryNamesUsingApi(fd, cached);
}
