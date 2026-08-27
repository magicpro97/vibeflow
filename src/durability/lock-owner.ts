import { execFileSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { win32 as windowsPath } from "node:path";
import { canonicalJsonBytes } from "./canonical.js";
import { durabilityError } from "./errors.js";
import {
  PROCESS_START_IDENTITY_DARWIN_PROBE,
  PROCESS_START_IDENTITY_KIND,
  PROCESS_START_IDENTITY_PATTERN_SOURCE,
  PROCESS_START_IDENTITY_PREFIX,
  PROCESS_START_IDENTITY_WINDOWS_QUERY_STATUS,
  classifyDarwinProcessStartIdentity,
  formatPlatformProcessStartIdentity,
  formatProcessStartIdentity,
  isNativeProcessStartIdentity,
  isProcessStartIdentityGenericPosixPlatform,
} from "./process-identity-contract.js";

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
      const library = ffi.dlopen(PROCESS_START_IDENTITY_DARWIN_PROBE.LIBRARY_PATH, {
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
    const library = koffi.load(PROCESS_START_IDENTITY_DARWIN_PROBE.LIBRARY_PATH);
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

/** Lock owners must use an identity the host process probe can observe directly. */
export const isProcessLockOwnerStartIdentity = isNativeProcessStartIdentity;

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
    !isProcessLockOwnerStartIdentity(row.process_start_identity) ||
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
    if (
      !startTicks ||
      !new RegExp(PROCESS_START_IDENTITY_PATTERN_SOURCE.POSITIVE_DECIMAL, "u").test(startTicks)
    )
      return null;
    const bootId = runtime
      .readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
      .trim()
      .toLowerCase();
    if (!new RegExp(PROCESS_START_IDENTITY_PATTERN_SOURCE.LINUX_BOOT_ID, "u").test(bootId))
      return null;
    return formatProcessStartIdentity(PROCESS_START_IDENTITY_PREFIX.LINUX, bootId, startTicks);
  } catch {
    return null;
  }
}

function psStartIdentity(
  pid: number,
  runtime: ProcessLockOwnerRuntime,
  platform: Parameters<typeof formatPlatformProcessStartIdentity>[0],
): string | null {
  try {
    const result = runtime
      .execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 1_000,
        stdio: ["ignore", "pipe", "ignore"],
      })
      .trim();
    return result ? formatPlatformProcessStartIdentity(platform, result) : null;
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
          `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -eq $p) { exit ${PROCESS_START_IDENTITY_WINDOWS_QUERY_STATUS.ABSENT} }; [Console]::WriteLine($p.CreationDate.ToUniversalTime().Ticks)`,
        ],
        {
          encoding: "utf8",
          timeout: 1_000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      )
      .trim();
    return /^[1-9][0-9]{0,19}$/.test(ticks)
      ? formatProcessStartIdentity(PROCESS_START_IDENTITY_PREFIX.WINDOWS, ticks)
      : null;
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
    const output = Buffer.alloc(PROCESS_START_IDENTITY_DARWIN_PROBE.OUTPUT_BYTES);
    if (
      procPidInfo(
        pid,
        PROCESS_START_IDENTITY_DARWIN_PROBE.FLAVOR,
        0,
        output,
        PROCESS_START_IDENTITY_DARWIN_PROBE.OUTPUT_BYTES,
      ) !== PROCESS_START_IDENTITY_DARWIN_PROBE.OUTPUT_BYTES
    ) {
      return null;
    }
    const seconds = output.readBigUInt64LE(
      PROCESS_START_IDENTITY_DARWIN_PROBE.START_SECONDS_OFFSET,
    );
    const microseconds = output.readBigUInt64LE(
      PROCESS_START_IDENTITY_DARWIN_PROBE.START_MICROSECONDS_OFFSET,
    );
    if (
      seconds === 0n ||
      microseconds >= BigInt(PROCESS_START_IDENTITY_DARWIN_PROBE.MICROSECONDS_PER_SECOND)
    )
      return null;
    return formatProcessStartIdentity(PROCESS_START_IDENTITY_PREFIX.DARWIN, seconds, microseconds);
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
  if (runtime.platform === PROCESS_START_IDENTITY_KIND.LINUX)
    return linuxStartIdentity(pid, runtime);
  if (runtime.platform === PROCESS_START_IDENTITY_KIND.DARWIN) return darwinStartIdentity(pid);
  if (runtime.platform === PROCESS_START_IDENTITY_KIND.WINDOWS)
    return windowsStartIdentity(pid, runtime);
  return isProcessStartIdentityGenericPosixPlatform(runtime.platform)
    ? psStartIdentity(pid, runtime, runtime.platform)
    : null;
}

export function processLockOwnerIsAlive(
  owner: ProcessLockOwnerV1,
  overrides: Partial<ProcessLockOwnerRuntime> = {},
): boolean | null {
  if (!isProcessLockOwnerStartIdentity(owner.process_start_identity)) return null;
  const runtime = ownerRuntime(overrides);
  if (owner.host !== runtime.host) return null;
  try {
    runtime.kill(owner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : null;
  }
  const observed = processStartIdentity(owner.pid, runtime);
  if (observed === null || !isNativeProcessStartIdentity(observed)) return null;
  const persistedDarwinFormat = classifyDarwinProcessStartIdentity(owner.process_start_identity);
  const observedDarwinFormat = classifyDarwinProcessStartIdentity(observed);
  if (
    persistedDarwinFormat !== observedDarwinFormat &&
    (persistedDarwinFormat !== null || observedDarwinFormat !== null)
  )
    return null;
  return observed === owner.process_start_identity;
}
