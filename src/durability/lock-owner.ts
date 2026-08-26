import { execFileSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { win32 as windowsPath } from "node:path";
import { canonicalJsonBytes } from "./canonical.js";
import { durabilityError } from "./errors.js";

export interface ProcessLockOwnerV1 {
  schema_version: "1.0";
  pid: number;
  process_start_identity: string;
  host: string;
  operation: string;
  nonce: string;
}

export interface ProcessLockOwnerRuntime {
  platform: NodeJS.Platform;
  host: string;
  kill: typeof process.kill;
  readFileSync: typeof fs.readFileSync;
  execFileSync: typeof execFileSync;
  windowsSystemRoot: string;
  observeStartIdentity?: (pid: number) => string | null;
}

const OWNER_KEYS = [
  "host",
  "nonce",
  "operation",
  "pid",
  "process_start_identity",
  "schema_version",
] as const;
const DARWIN_PROC_PID_TBSDINFO = 3;
const DARWIN_PROC_BSDINFO_BYTES = 136;
const DARWIN_START_SECONDS_OFFSET = 120;
const DARWIN_START_MICROSECONDS_OFFSET = 128;
const DARWIN_LIBPROC_PATH = "/usr/lib/libproc.dylib";
const IS_BUN = typeof (process.versions as Record<string, string | undefined>).bun === "string";
const RUNTIME_REQUIRE = createRequire(import.meta.url);

type DarwinProcPidInfo = (
  pid: number,
  flavor: number,
  arg: number,
  output: Buffer,
  outputBytes: number,
) => number;

export interface DarwinProcLoaderRuntime {
  isBun: boolean;
  requireModule: (specifier: "bun:ffi" | "koffi") => unknown;
}

export interface DarwinProcBinding {
  library: unknown;
  procPidInfo: DarwinProcPidInfo;
}

let darwinProcLibrary: unknown;
let darwinProcPidInfo: DarwinProcPidInfo | null | undefined;

/** Uncached cross-runtime loader; production caches its result and tests inject exact modules. */
export function loadDarwinProcBinding(runtime: DarwinProcLoaderRuntime): DarwinProcBinding | null {
  try {
    if (runtime.isBun) {
      const ffi = runtime.requireModule("bun:ffi") as typeof import("bun:ffi");
      const library = ffi.dlopen(DARWIN_LIBPROC_PATH, {
        proc_pidinfo: {
          args: [
            ffi.FFIType.i32,
            ffi.FFIType.i32,
            ffi.FFIType.u64,
            ffi.FFIType.ptr,
            ffi.FFIType.i32,
          ],
          returns: ffi.FFIType.i32,
        },
      });
      return {
        library,
        procPidInfo: (pid, flavor, arg, output, outputBytes) =>
          library.symbols.proc_pidinfo(pid, flavor, arg, output, outputBytes),
      };
    }
    const koffi = runtime.requireModule("koffi") as typeof import("koffi").default;
    const library = koffi.load(DARWIN_LIBPROC_PATH);
    return {
      library,
      procPidInfo: library.func(
        "int proc_pidinfo(int, int, uint64, void *, int)",
      ) as DarwinProcPidInfo,
    };
  } catch {
    return null;
  }
}

function ownerRuntime(overrides: Partial<ProcessLockOwnerRuntime>): ProcessLockOwnerRuntime {
  return {
    platform: process.platform,
    host: hostname(),
    kill: process.kill.bind(process),
    readFileSync: fs.readFileSync,
    execFileSync,
    windowsSystemRoot: process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows",
    ...overrides,
  };
}

export function boundedOwnerAscii(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    Buffer.byteLength(value, "utf8") <= max &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code <= 0x7e;
    })
  );
}

export function parseProcessLockOwner(bytes: Buffer): ProcessLockOwnerV1 {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    return durabilityError("corrupt", "invalid process lock owner metadata", error);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    durabilityError("corrupt", "invalid process lock owner metadata");
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (keys.length !== OWNER_KEYS.length || keys.some((key, index) => key !== OWNER_KEYS[index]))
    durabilityError("corrupt", "unknown process lock owner metadata field");
  if (
    row.schema_version !== "1.0" ||
    !Number.isSafeInteger(row.pid) ||
    (row.pid as number) < 1 ||
    (row.pid as number) > 2_147_483_647 ||
    !boundedOwnerAscii(row.process_start_identity, 512) ||
    !boundedOwnerAscii(row.host, 255) ||
    !boundedOwnerAscii(row.operation, 512) ||
    typeof row.nonce !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.nonce)
  )
    durabilityError("corrupt", "invalid process lock owner metadata");
  const canonical = canonicalJsonBytes(row);
  if (canonical.length !== bytes.length || !timingSafeEqual(canonical, bytes))
    durabilityError("corrupt", "process lock owner metadata is not canonical");
  return row as unknown as ProcessLockOwnerV1;
}

function linuxStartIdentity(pid: number, runtime: ProcessLockOwnerRuntime): string | null {
  try {
    const stat = runtime.readFileSync(`/proc/${pid}/stat`, "utf8");
    if (stat.length > 16 * 1024) return null;
    const end = stat.lastIndexOf(")");
    if (end < 0) return null;
    const startTicks = stat
      .slice(end + 2)
      .trim()
      .split(/\s+/)[19];
    if (!startTicks || !/^[0-9]+$/.test(startTicks)) return null;
    const bootId = runtime.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!/^[a-f0-9-]{16,64}$/i.test(bootId)) return null;
    return `linux:${bootId.toLowerCase()}:${startTicks}`;
  } catch {
    return null;
  }
}

function psStartIdentity(pid: number, runtime: ProcessLockOwnerRuntime): string | null {
  try {
    const result = runtime
      .execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 1_000,
        stdio: ["ignore", "pipe", "ignore"],
      })
      .trim();
    return result ? `${runtime.platform}:${result}` : null;
  } catch {
    return null;
  }
}

function windowsStartIdentity(pid: number, runtime: ProcessLockOwnerRuntime): string | null {
  try {
    const root = windowsPath.normalize(runtime.windowsSystemRoot);
    if (!/^[A-Za-z]:\\[^\0]+$/.test(root)) return null;
    const powershell = windowsPath.join(root, "System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    const ticks = runtime
      .execFileSync(
        powershell,
        [
          "-NoProfile",
          "-Command",
          `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -eq $p) { exit 3 }; [Console]::WriteLine($p.CreationDate.ToUniversalTime().Ticks)`,
        ],
        {
          encoding: "utf8",
          timeout: 1_000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      )
      .trim();
    return /^[1-9][0-9]{0,19}$/.test(ticks) ? `win32:${ticks}` : null;
  } catch {
    return null;
  }
}

function loadDarwinProcPidInfo(): DarwinProcPidInfo | null {
  if (darwinProcPidInfo !== undefined) return darwinProcPidInfo;
  const binding = loadDarwinProcBinding({
    isBun: IS_BUN,
    requireModule: (specifier) => RUNTIME_REQUIRE(specifier),
  });
  darwinProcLibrary = binding?.library ?? null;
  darwinProcPidInfo = binding?.procPidInfo ?? null;
  return darwinProcPidInfo;
}

function darwinStartIdentity(pid: number): string | null {
  try {
    const procPidInfo = loadDarwinProcPidInfo();
    if (!procPidInfo || darwinProcLibrary === null) return null;
    const output = Buffer.alloc(DARWIN_PROC_BSDINFO_BYTES);
    if (
      procPidInfo(pid, DARWIN_PROC_PID_TBSDINFO, 0, output, DARWIN_PROC_BSDINFO_BYTES) !==
      DARWIN_PROC_BSDINFO_BYTES
    ) {
      return null;
    }
    const seconds = output.readBigUInt64LE(DARWIN_START_SECONDS_OFFSET);
    const microseconds = output.readBigUInt64LE(DARWIN_START_MICROSECONDS_OFFSET);
    if (seconds === 0n || microseconds >= 1_000_000n) return null;
    return `darwin:${seconds}:${microseconds}`;
  } catch {
    return null;
  }
}

export function processStartIdentity(
  pid = process.pid,
  overrides: Partial<ProcessLockOwnerRuntime> = {},
): string | null {
  const runtime = ownerRuntime(overrides);
  if (runtime.observeStartIdentity) return runtime.observeStartIdentity(pid);
  if (runtime.platform === "linux") return linuxStartIdentity(pid, runtime);
  if (runtime.platform === "darwin") return darwinStartIdentity(pid);
  if (runtime.platform === "win32") return windowsStartIdentity(pid, runtime);
  return psStartIdentity(pid, runtime);
}

export function processLockOwnerIsAlive(
  owner: ProcessLockOwnerV1,
  overrides: Partial<ProcessLockOwnerRuntime> = {},
): boolean | null {
  const runtime = ownerRuntime(overrides);
  if (owner.host !== runtime.host) return null;
  try {
    runtime.kill(owner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : null;
  }
  const observed = processStartIdentity(owner.pid, runtime);
  return observed === null ? null : observed === owner.process_start_identity;
}
