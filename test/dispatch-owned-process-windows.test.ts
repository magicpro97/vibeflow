import { describe, expect, test } from "bun:test";
import { OWNED_SUPERVISOR_SCRIPT } from "../src/dispatch/owned-process-launch.js";
import {
  createOwnedProcessPlatform,
  resolveOwnedWindowsSystemRoot,
} from "../src/dispatch/owned-process-platform.js";
import { reapOwnedProcessRecord } from "../src/dispatch/owned-process-reaper.js";
import type { OwnedAttemptProcessRecordV1 } from "../src/dispatch/owned-process-runtime.js";

const WINDOWS_TICKS = Object.freeze({
  OWNER: "638602314960000001",
  SUPERVISOR: "638602314960000041",
  CLI: "638602314960000042",
} as const);
const WINDOWS_IDENTITY = Object.freeze({
  OWNER: `win32:${WINDOWS_TICKS.OWNER}`,
  SUPERVISOR: `win32:${WINDOWS_TICKS.SUPERVISOR}`,
  CLI: `win32:${WINDOWS_TICKS.CLI}`,
} as const);

function windowsRecord(): OwnedAttemptProcessRecordV1 {
  const recordedAt = new Date().toISOString();
  return {
    schema_version: "1.0",
    attempt_id: "owned-windows-tree",
    engine: "codex",
    host: "host",
    platform: "win32",
    strategy: "windows-tree",
    quiescence_scope: "windows-job",
    proof_strength: "kernel-contained",
    owner_pid: 1,
    owner_identity: WINDOWS_IDENTITY.OWNER,
    supervisor_pid: 41,
    supervisor_identity: WINDOWS_IDENTITY.SUPERVISOR,
    cli_pid: 42,
    cli_identity: WINDOWS_IDENTITY.CLI,
    terminal_kind: null,
    state: "running",
    release_reason: null,
    exit_code: null,
    process_quiescent: false,
    prior_record_digest: null,
    recorded_at: recordedAt,
    updated_at: recordedAt,
    record_digest: `sha256:${"0".repeat(64)}`,
  };
}

function powershellPid(args: string[]): number {
  return Number((args[2] ?? "").match(/ProcessId = (\d+)/)?.[1]);
}

function isTaskkill(command: string): boolean {
  return /(?:^|\\)taskkill\.exe$/i.test(command);
}

describe("owned CLI lifecycle on Windows", () => {
  test("Windows Job Object containment is installed before receipt and untrusted spawn", () => {
    const initialize = OWNED_SUPERVISOR_SCRIPT.indexOf(
      "const windowsJob = initializeWindowsJob();",
    );
    const receipt = OWNED_SUPERVISOR_SCRIPT.indexOf("write(receipt, {", initialize);
    const bindAck = OWNED_SUPERVISOR_SCRIPT.indexOf("waitForBindAck()", receipt);
    const cliSpawn = OWNED_SUPERVISOR_SCRIPT.indexOf("const child = spawn(", bindAck);

    expect(OWNED_SUPERVISOR_SCRIPT).toContain("KILL_ON_JOB_CLOSE_FLAG");
    expect(OWNED_SUPERVISOR_SCRIPT).toContain("AssignProcessToJobObject");
    expect(OWNED_SUPERVISOR_SCRIPT).toContain("QueryInformationJobObject");
    expect(initialize).toBeGreaterThan(-1);
    expect(receipt).toBeGreaterThan(initialize);
    expect(bindAck).toBeGreaterThan(receipt);
    expect(cliSpawn).toBeGreaterThan(bindAck);
  });

  test("Windows platform advertises kernel-contained Job Object proof", () => {
    const platform = createOwnedProcessPlatform({
      platform: "win32",
      windowsSystemRoot: "C:\\Windows",
    });
    expect(platform.quiescenceScope).toBe("windows-job");
    expect(platform.proofStrength).toBe("kernel-contained");
  });

  test("Windows system root comes from the native query contract, not process env", () => {
    const originalSystemRoot = process.env.SystemRoot;
    const originalWindir = process.env.windir;
    process.env.SystemRoot = "Z:\\attacker";
    process.env.windir = "Y:\\attacker";
    try {
      expect(resolveOwnedWindowsSystemRoot(() => "D:\\Windows\\")).toBe("D:\\Windows");
      expect(() => resolveOwnedWindowsSystemRoot(() => "relative\\Windows")).toThrow(
        /invalid trusted Windows system root/,
      );
    } finally {
      if (originalSystemRoot === undefined) Reflect.deleteProperty(process.env, "SystemRoot");
      else process.env.SystemRoot = originalSystemRoot;
      if (originalWindir === undefined) Reflect.deleteProperty(process.env, "windir");
      else process.env.windir = originalWindir;
    }
    expect(OWNED_SUPERVISOR_SCRIPT).toContain("GetWindowsDirectoryW");
    expect(OWNED_SUPERVISOR_SCRIPT).not.toContain("process.env.SystemRoot");
    expect(OWNED_SUPERVISOR_SCRIPT).not.toContain("process.env.windir");
  });

  test("Windows native root query failure constructs a fail-closed platform", () => {
    const platform = createOwnedProcessPlatform({
      platform: "win32",
      resolveWindowsSystemRoot: () => {
        throw new Error("native ABI unavailable");
      },
    });

    expect(platform.probe?.(41)).toEqual({ kind: "unknown" });
    expect(() =>
      platform.terminateExactTree(
        { pid: 41, identity: WINDOWS_IDENTITY.SUPERVISOR, pgid: null, sid: null },
        false,
      ),
    ).toThrow(/owned Windows root identity changed/);
  });

  test("an absent bound supervisor proves its kill-on-close Windows Job was reaped", () => {
    const platform = createOwnedProcessPlatform({
      platform: "win32",
      windowsSystemRoot: "C:\\Windows",
      kill: (() => true) as typeof process.kill,
      processStartIdentity: () => null,
      execFileSync: ((command: string) => {
        if (isTaskkill(command)) return "";
        throw Object.assign(new Error("absent"), { status: 3 });
      }) as never,
    });

    expect(platform.proveQuiescent(windowsRecord(), "recovery")).toBe(true);
  });

  test("successful taskkill /T plus fresh absent probes proves tree release", async () => {
    const live = new Map([
      [41, WINDOWS_TICKS.SUPERVISOR],
      [42, WINDOWS_TICKS.CLI],
    ]);
    const taskkillCalls: string[][] = [];
    const platform = createOwnedProcessPlatform({
      platform: "win32",
      windowsSystemRoot: "C:\\Windows",
      kill: (() => true) as typeof process.kill,
      processStartIdentity: () => null,
      execFileSync: ((command: string, args: string[]) => {
        if (isTaskkill(command)) {
          taskkillCalls.push(args);
          live.clear();
          return "";
        }
        const identity = live.get(powershellPid(args));
        if (!identity) throw Object.assign(new Error("absent"), { status: 3 });
        return identity;
      }) as never,
    });

    await expect(reapOwnedProcessRecord(platform, windowsRecord(), 0, "active")).resolves.toBe(
      true,
    );
    expect(taskkillCalls).toEqual([["/PID", "41", "/T"]]);
  });

  test("taskkill or process-query failure remains unproven", async () => {
    let queryFails = false;
    const platform = createOwnedProcessPlatform({
      platform: "win32",
      windowsSystemRoot: "C:\\Windows",
      kill: (() => true) as typeof process.kill,
      processStartIdentity: () => null,
      execFileSync: ((command: string, args: string[]) => {
        if (isTaskkill(command)) {
          queryFails = true;
          throw Object.assign(new Error("taskkill failed"), { status: 1 });
        }
        if (queryFails) throw Object.assign(new Error("query failed"), { status: 1 });
        return powershellPid(args) === 41 ? WINDOWS_TICKS.SUPERVISOR : WINDOWS_TICKS.CLI;
      }) as never,
    });

    await expect(
      reapOwnedProcessRecord(platform, windowsRecord(), 0, "active"),
    ).resolves.toBeNull();
  });

  test("root-loss recovery reaps an exact live CLI tree on Windows", async () => {
    const live = new Map([[42, WINDOWS_TICKS.CLI]]);
    const commands: string[] = [];
    const platform = createOwnedProcessPlatform({
      platform: "win32",
      windowsSystemRoot: "D:\\Windows",
      kill: (() => true) as typeof process.kill,
      processStartIdentity: () => null,
      execFileSync: ((command: string, args: string[]) => {
        commands.push(command);
        if (isTaskkill(command)) {
          live.clear();
          return "";
        }
        const identity = live.get(powershellPid(args));
        if (!identity) throw Object.assign(new Error("absent"), { status: 3 });
        return identity;
      }) as never,
    });

    await expect(reapOwnedProcessRecord(platform, windowsRecord(), 0, "recovery")).resolves.toBe(
      true,
    );
    expect(commands.some((command) => command === "D:\\Windows\\System32\\taskkill.exe")).toBe(
      true,
    );
    expect(
      commands
        .filter((command) => !isTaskkill(command))
        .every(
          (command) => command === "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        ),
    ).toBe(true);
    expect(commands).not.toContain("powershell");
    expect(commands).not.toContain("taskkill");
  });
});
