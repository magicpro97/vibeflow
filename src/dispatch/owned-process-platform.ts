import { execFileSync as nodeExecFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { win32 as windowsPath } from "node:path";
import { processStartIdentity } from "../durability/index.js";
import {
  OWNED_PROCESS_PRESENCE_KIND,
  OWNED_PROCESS_PROOF_STRENGTH,
  OWNED_PROCESS_QUIESCENCE_SCOPE,
  OWNED_PROCESS_STRATEGY,
  OWNED_PROCESS_TIMING_MS,
  OWNED_WINDOWS_LIMIT,
  OWNED_WINDOWS_QUERY_STATUS,
  type OwnedProcessProofStrength,
  type OwnedProcessQuiescenceMode,
  type OwnedProcessQuiescenceScope,
  type OwnedProcessStrategy,
} from "./owned-process-contract.js";
import type { OwnedAttemptProcessRecordV1 } from "./owned-process-record.js";

export type { OwnedProcessStrategy } from "./owned-process-contract.js";
export type QuiescenceMode = OwnedProcessQuiescenceMode;
export type OwnedProcessPresence =
  | { kind: typeof OWNED_PROCESS_PRESENCE_KIND.PRESENT; observation: OwnedProcessObservation }
  | { kind: typeof OWNED_PROCESS_PRESENCE_KIND.ABSENT }
  | { kind: typeof OWNED_PROCESS_PRESENCE_KIND.UNKNOWN };
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const RUNTIME_REQUIRE = createRequire(import.meta.url);

export interface OwnedProcessQuiescenceHint {
  supervisor_exit_observed?: boolean;
  exact_tree_termination_succeeded?: boolean;
}

export interface OwnedProcessObservation {
  pid: number;
  identity: string;
  pgid: number | null;
  sid: number | null;
}

export interface OwnedProcessPlatform {
  strategy: OwnedProcessStrategy;
  platform: NodeJS.Platform;
  proofStrength?: OwnedProcessProofStrength;
  quiescenceScope?: OwnedProcessQuiescenceScope;
  probe?: (pid: number) => OwnedProcessPresence;
  observe(pid: number): OwnedProcessObservation | null;
  terminateExactTree(root: OwnedProcessObservation, force: boolean): void;
  terminateExactCliFallback?: (
    record: OwnedAttemptProcessRecordV1,
    cli: OwnedProcessObservation,
    force: boolean,
  ) => void;
  proveQuiescent(
    record: OwnedAttemptProcessRecordV1,
    mode: QuiescenceMode,
    hint?: OwnedProcessQuiescenceHint,
  ): boolean | null;
}

export interface OwnedProcessPlatformRuntime {
  execFileSync: typeof nodeExecFileSync;
  kill: typeof process.kill;
  platform: NodeJS.Platform;
  processStartIdentity: (pid: number) => string | null;
  resolveWindowsSystemRoot?: () => string;
  windowsSystemRoot: string;
}

export function observationMatches(
  pid: number,
  identity: string,
  observed: OwnedProcessObservation | null,
): boolean {
  return observed !== null && observed.pid === pid && observed.identity === identity;
}

export function probeProcess(platform: OwnedProcessPlatform, pid: number): OwnedProcessPresence {
  if (platform.probe) return platform.probe(pid);
  const observed = platform.observe(pid);
  return observed
    ? { kind: OWNED_PROCESS_PRESENCE_KIND.PRESENT, observation: observed }
    : { kind: OWNED_PROCESS_PRESENCE_KIND.ABSENT };
}

function windowsTool(runtime: OwnedProcessPlatformRuntime, relativePath: string): string {
  const root = windowsPath.normalize(runtime.windowsSystemRoot);
  if (!/^[A-Za-z]:\\[^\0]+$/.test(root)) throw new Error("invalid Windows system root");
  return windowsPath.join(root, relativePath);
}

function queryNativeWindowsSystemRoot(): string {
  const koffi = RUNTIME_REQUIRE("koffi") as typeof import("koffi").default;
  const kernel32 = koffi.load("Kernel32.dll");
  const getWindowsDirectory = kernel32.func(
    "unsigned int GetWindowsDirectoryW(void *, unsigned int)",
  ) as (output: Buffer, outputChars: number) => number;
  const output = Buffer.alloc(OWNED_WINDOWS_LIMIT.DIRECTORY_BUFFER_CHARS * 2);
  const length = getWindowsDirectory(output, OWNED_WINDOWS_LIMIT.DIRECTORY_BUFFER_CHARS);
  if (length < 1 || length >= OWNED_WINDOWS_LIMIT.DIRECTORY_BUFFER_CHARS) {
    throw new Error("trusted Windows directory query failed");
  }
  return output.subarray(0, length * 2).toString("utf16le");
}

export function resolveOwnedWindowsSystemRoot(
  query: () => string = queryNativeWindowsSystemRoot,
): string {
  const root = windowsPath.normalize(query()).replace(/\\+$/, "");
  if (!/^[A-Za-z]:\\[^\0]+$/.test(root)) throw new Error("invalid trusted Windows system root");
  return root;
}

function windowsPowerShell(runtime: OwnedProcessPlatformRuntime): string {
  return windowsTool(runtime, "System32\\WindowsPowerShell\\v1.0\\powershell.exe");
}

function windowsTaskkill(runtime: OwnedProcessPlatformRuntime): string {
  return windowsTool(runtime, "System32\\taskkill.exe");
}

function windowsProbe(pid: number, runtime: OwnedProcessPlatformRuntime): OwnedProcessPresence {
  try {
    const creation = runtime
      .execFileSync(
        windowsPowerShell(runtime),
        [
          "-NoProfile",
          "-Command",
          `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -eq $p) { exit ${OWNED_WINDOWS_QUERY_STATUS.ABSENT} }; [Console]::WriteLine($p.CreationDate.ToUniversalTime().Ticks)`,
        ],
        {
          encoding: "utf8",
          timeout: OWNED_PROCESS_TIMING_MS.PLATFORM_PROBE_TIMEOUT,
          stdio: ["ignore", "pipe", "ignore"],
        },
      )
      .trim();
    if (!creation) return { kind: OWNED_PROCESS_PRESENCE_KIND.UNKNOWN };
    return {
      kind: OWNED_PROCESS_PRESENCE_KIND.PRESENT,
      observation: { pid, identity: `win32:${creation}`, pgid: null, sid: null },
    };
  } catch (error) {
    return (error as NodeJS.ErrnoException & { status?: number }).status ===
      OWNED_WINDOWS_QUERY_STATUS.ABSENT
      ? { kind: OWNED_PROCESS_PRESENCE_KIND.ABSENT }
      : { kind: OWNED_PROCESS_PRESENCE_KIND.UNKNOWN };
  }
}

function posixExists(pid: number, runtime: OwnedProcessPlatformRuntime): boolean | null {
  try {
    runtime.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : null;
  }
}

function posixProbe(pid: number, runtime: OwnedProcessPlatformRuntime): OwnedProcessPresence {
  const identityBefore = runtime.processStartIdentity(pid);
  if (!identityBefore) {
    const exists = posixExists(pid, runtime);
    return exists === false
      ? { kind: OWNED_PROCESS_PRESENCE_KIND.ABSENT }
      : { kind: OWNED_PROCESS_PRESENCE_KIND.UNKNOWN };
  }
  try {
    const pgidText = runtime
      .execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: OWNED_PROCESS_TIMING_MS.PLATFORM_PROBE_TIMEOUT,
        stdio: ["ignore", "pipe", "ignore"],
      })
      .trim();
    const identityAfter = runtime.processStartIdentity(pid);
    if (!identityAfter || identityAfter !== identityBefore || !POSITIVE_INTEGER.test(pgidText))
      return { kind: OWNED_PROCESS_PRESENCE_KIND.UNKNOWN };
    const pgid = Number(pgidText);
    return {
      kind: OWNED_PROCESS_PRESENCE_KIND.PRESENT,
      observation: {
        pid,
        identity: identityAfter,
        pgid: Number.isSafeInteger(pgid) ? pgid : null,
        sid: null,
      },
    };
  } catch {
    const identityAfter = runtime.processStartIdentity(pid);
    if (identityAfter) return { kind: OWNED_PROCESS_PRESENCE_KIND.UNKNOWN };
    const exists = posixExists(pid, runtime);
    return exists === false
      ? { kind: OWNED_PROCESS_PRESENCE_KIND.ABSENT }
      : { kind: OWNED_PROCESS_PRESENCE_KIND.UNKNOWN };
  }
}

function posixGroupEmpty(groupId: number, runtime: OwnedProcessPlatformRuntime): boolean | null {
  try {
    const output = runtime.execFileSync("/bin/ps", ["-axo", "pid=,pgid="], {
      encoding: "utf8",
      timeout: OWNED_PROCESS_TIMING_MS.PLATFORM_PROBE_TIMEOUT,
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of output.split(/\r?\n/)) {
      const [pidText, pgidText] = line.trim().split(/\s+/);
      if (!pidText || !pgidText) continue;
      if (Number(pidText) > 0 && Number(pgidText) === groupId) return false;
    }
    return true;
  } catch {
    return null;
  }
}

export function createOwnedProcessPlatform(
  runtimeOverrides: Partial<OwnedProcessPlatformRuntime> = {},
): OwnedProcessPlatform {
  const platform = runtimeOverrides.platform ?? process.platform;
  const windowsSystemRoot =
    runtimeOverrides.windowsSystemRoot ??
    (platform === "win32"
      ? (() => {
          try {
            return resolveOwnedWindowsSystemRoot(runtimeOverrides.resolveWindowsSystemRoot);
          } catch {
            return "";
          }
        })()
      : "C:\\Windows");
  const runtime: OwnedProcessPlatformRuntime = {
    execFileSync: nodeExecFileSync,
    kill: process.kill.bind(process),
    platform,
    processStartIdentity,
    windowsSystemRoot,
    ...runtimeOverrides,
  };
  if (runtime.platform === "win32") {
    return {
      strategy: OWNED_PROCESS_STRATEGY.WINDOWS_TREE,
      platform: runtime.platform,
      proofStrength: OWNED_PROCESS_PROOF_STRENGTH.KERNEL_CONTAINED,
      quiescenceScope: OWNED_PROCESS_QUIESCENCE_SCOPE.WINDOWS_JOB,
      probe: (pid) => windowsProbe(pid, runtime),
      observe: (pid) => {
        const observed = windowsProbe(pid, runtime);
        return observed.kind === OWNED_PROCESS_PRESENCE_KIND.PRESENT ? observed.observation : null;
      },
      terminateExactTree: (root, force) => {
        const fresh = windowsProbe(root.pid, runtime);
        if (
          fresh.kind !== OWNED_PROCESS_PRESENCE_KIND.PRESENT ||
          !observationMatches(root.pid, root.identity, fresh.observation)
        ) {
          throw new Error("owned Windows root identity changed before termination");
        }
        runtime.execFileSync(
          windowsTaskkill(runtime),
          ["/PID", String(root.pid), "/T", ...(force ? ["/F"] : [])],
          {
            timeout: OWNED_PROCESS_TIMING_MS.TREE_TERMINATE_TIMEOUT,
            stdio: ["ignore", "ignore", "ignore"],
          },
        );
      },
      terminateExactCliFallback: (_record, cli, force) => {
        const fresh = windowsProbe(cli.pid, runtime);
        if (
          fresh.kind !== OWNED_PROCESS_PRESENCE_KIND.PRESENT ||
          !observationMatches(cli.pid, cli.identity, fresh.observation)
        ) {
          throw new Error("owned Windows CLI identity changed before fallback termination");
        }
        runtime.execFileSync(
          windowsTaskkill(runtime),
          ["/PID", String(cli.pid), "/T", ...(force ? ["/F"] : [])],
          {
            timeout: OWNED_PROCESS_TIMING_MS.TREE_TERMINATE_TIMEOUT,
            stdio: ["ignore", "ignore", "ignore"],
          },
        );
      },
      proveQuiescent: (record, _mode, hint) => {
        const supervisor = !record.supervisor_pid
          ? { kind: OWNED_PROCESS_PRESENCE_KIND.ABSENT }
          : windowsProbe(record.supervisor_pid, runtime);
        const cli = !record.cli_pid
          ? { kind: OWNED_PROCESS_PRESENCE_KIND.ABSENT }
          : windowsProbe(record.cli_pid, runtime);
        if (
          supervisor.kind === OWNED_PROCESS_PRESENCE_KIND.UNKNOWN ||
          cli.kind === OWNED_PROCESS_PRESENCE_KIND.UNKNOWN ||
          (supervisor.kind === OWNED_PROCESS_PRESENCE_KIND.PRESENT &&
            !observationMatches(
              record.supervisor_pid as number,
              record.supervisor_identity as string,
              supervisor.observation,
            )) ||
          (cli.kind === OWNED_PROCESS_PRESENCE_KIND.PRESENT &&
            !observationMatches(
              record.cli_pid as number,
              record.cli_identity as string,
              cli.observation,
            ))
        ) {
          return null;
        }
        if (
          supervisor.kind === OWNED_PROCESS_PRESENCE_KIND.PRESENT ||
          cli.kind === OWNED_PROCESS_PRESENCE_KIND.PRESENT
        )
          return false;
        if (
          record.quiescence_scope === OWNED_PROCESS_QUIESCENCE_SCOPE.WINDOWS_JOB &&
          record.proof_strength === OWNED_PROCESS_PROOF_STRENGTH.KERNEL_CONTAINED &&
          record.supervisor_pid !== null
        ) {
          return true;
        }
        return hint?.exact_tree_termination_succeeded ? true : null;
      },
    };
  }
  return {
    strategy: OWNED_PROCESS_STRATEGY.POSIX_SESSION,
    platform: runtime.platform,
    proofStrength: OWNED_PROCESS_PROOF_STRENGTH.COOPERATIVE_LINEAGE,
    quiescenceScope: OWNED_PROCESS_QUIESCENCE_SCOPE.POSIX_PROCESS_GROUP,
    probe: (pid) => posixProbe(pid, runtime),
    observe: (pid) => {
      const observed = posixProbe(pid, runtime);
      return observed.kind === OWNED_PROCESS_PRESENCE_KIND.PRESENT ? observed.observation : null;
    },
    terminateExactTree: (root, force) => {
      const fresh = posixProbe(root.pid, runtime);
      if (
        fresh.kind !== OWNED_PROCESS_PRESENCE_KIND.PRESENT ||
        !observationMatches(root.pid, root.identity, fresh.observation) ||
        fresh.observation.pgid !== root.pid
      ) {
        throw new Error("owned POSIX root identity changed before termination");
      }
      runtime.kill(-root.pid, force ? "SIGKILL" : "SIGTERM");
    },
    terminateExactCliFallback: (record, cli, force) => {
      const fresh = posixProbe(cli.pid, runtime);
      if (
        !record.supervisor_pid ||
        fresh.kind !== OWNED_PROCESS_PRESENCE_KIND.PRESENT ||
        !observationMatches(cli.pid, cli.identity, fresh.observation) ||
        fresh.observation.pgid !== record.supervisor_pid
      ) {
        throw new Error("owned POSIX CLI identity changed before fallback termination");
      }
      runtime.kill(-record.supervisor_pid, force ? "SIGKILL" : "SIGTERM");
    },
    proveQuiescent: (record) =>
      record.supervisor_pid ? posixGroupEmpty(record.supervisor_pid, runtime) : true,
  };
}
