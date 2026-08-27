import { describe, expect, test } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { AGENT_ENGINE } from "../src/core/agent-contract.js";
import { makeAsyncSpawner } from "../src/dispatch.js";
import { OWNED_PROCESS_AUTHORITY_ERROR } from "../src/dispatch/owned-process-authority-contract.js";
import {
  OWNED_CLI_IDENTITY_STATE,
  OWNED_PROCESS_ENV,
  OWNED_PROCESS_LIMIT,
  OWNED_PROCESS_QUIESCENCE_SCOPE,
  OWNED_PROCESS_RECORD_FIELD,
  OWNED_PROCESS_STATE,
  OWNED_PROCESS_STORAGE_NAME,
  OWNED_PROCESS_STRATEGY,
  OWNED_PROCESS_TERMINAL_KIND,
} from "../src/dispatch/owned-process-contract.js";
import {
  assertOwnedProcessHealthClear,
  inspectOwnedAttemptProcesses,
} from "../src/dispatch/owned-process-health.js";
import {
  createOwnedRuntimeRoot,
  defaultOwnedSupervisorLaunchRuntime,
} from "../src/dispatch/owned-process-launch-runtime.js";
import { launchOwnedSupervisorProcess } from "../src/dispatch/owned-process-launch.js";
import { createOwnedProcessPlatform } from "../src/dispatch/owned-process-platform.js";
import { reapOwnedProcessRecord } from "../src/dispatch/owned-process-reaper.js";
import { createOwnedProcessReleaseProof } from "../src/dispatch/owned-process-release-proof.js";
import {
  OwnedProcessController,
  OwnedProcessRecordStore,
  assertOwnedProcessRecord,
  buildOwnedProcessRecord,
  verifyOwnedProcessReleaseProof,
} from "../src/dispatch/owned-process-runtime.js";
import { OWNED_SUPERVISOR_TERMINAL_PHASE } from "../src/dispatch/owned-process-status.js";
import { canonicalJsonBytes, digestV1, processStartIdentity } from "../src/durability/index.js";
import {
  PROCESS_START_IDENTITY_PREFIX,
  PROCESS_START_IDENTITY_SEGMENT,
  formatPlatformProcessStartIdentity,
  formatProcessStartIdentity,
} from "../src/durability/process-identity-contract.js";

const LINUX_BOOT_ID = "123e4567-e89b-12d3-a456-426614174000";
const linuxIdentity = (ticks: number): string =>
  formatProcessStartIdentity(PROCESS_START_IDENTITY_PREFIX.LINUX, LINUX_BOOT_ID, ticks);
const WINDOWS_TICKS = Object.freeze({
  OWNER: 638_602_314_960_000_001n,
  SUPERVISOR: 638_602_314_960_000_041n,
  CLI: 638_602_314_960_000_042n,
} as const);
const WINDOWS_IDENTITY = Object.freeze({
  OWNER: formatProcessStartIdentity(PROCESS_START_IDENTITY_PREFIX.WINDOWS, WINDOWS_TICKS.OWNER),
  SUPERVISOR: formatProcessStartIdentity(
    PROCESS_START_IDENTITY_PREFIX.WINDOWS,
    WINDOWS_TICKS.SUPERVISOR,
  ),
  CLI: formatProcessStartIdentity(PROCESS_START_IDENTITY_PREFIX.WINDOWS, WINDOWS_TICKS.CLI),
} as const);
const SYNTHETIC_IDENTITY = Object.freeze({
  LEGACY_OWNER: formatPlatformProcessStartIdentity("freebsd", "legacy-owner"),
  OWNER: formatPlatformProcessStartIdentity("freebsd", "fixture-owner"),
  SUPERVISOR: formatPlatformProcessStartIdentity("freebsd", "fixture-supervisor"),
  CLI: formatPlatformProcessStartIdentity("freebsd", "fixture-cli"),
  RECEIPT_CLI: formatPlatformProcessStartIdentity("freebsd", "receipt-cli"),
  REPLACEMENT_CLI: formatPlatformProcessStartIdentity("freebsd", "replacement-cli"),
  REPLACEMENT_SUPERVISOR: formatPlatformProcessStartIdentity("freebsd", "replacement-supervisor"),
} as const);
const WINDOWS_EXITED_CLI_IDENTITY = formatProcessStartIdentity(
  PROCESS_START_IDENTITY_PREFIX.WINDOWS_EXITED_RECEIPT,
  WINDOWS_IDENTITY.SUPERVISOR,
  PROCESS_START_IDENTITY_SEGMENT.PID,
  701,
);

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function ownedRecordEntry(store: OwnedProcessRecordStore, attemptId: string): string {
  const entry = store
    .entries()
    .find(
      (candidate) =>
        store.readEntry(candidate)?.[OWNED_PROCESS_RECORD_FIELD.ATTEMPT_ID] === attemptId,
    );
  if (!entry) throw new Error("missing owned process record fixture");
  return entry;
}

function ownedRecordPath(root: string, entry: string): string {
  return join(root, OWNED_PROCESS_STORAGE_NAME.RECORD_DIRECTORY, entry);
}

describe("owned CLI lifecycle", () => {
  test.if(process.platform !== "win32")(
    "owned runtime root is private, exclusive, and rejects a pre-seeded symlink",
    () => {
      const root = tempRoot("vf-owned-private-runtime-root-");
      const nonce = "00000000-0000-4000-8000-0000000000aa";
      try {
        const runtime = { ...defaultOwnedSupervisorLaunchRuntime(), tmpdir: () => root };
        const created = createOwnedRuntimeRoot(runtime, nonce);
        const observed = lstatSync(created.path);
        expect(observed.isDirectory()).toBe(true);
        expect(observed.isSymbolicLink()).toBe(false);
        expect(observed.mode & 0o077).toBe(0);
        created.cleanup();
        expect(existsSync(created.path)).toBe(false);

        const attacker = join(root, "attacker-controlled");
        const seeded = join(root, `vibeflow-owned-runtime-${nonce}`);
        mkdirSync(attacker);
        symlinkSync(attacker, seeded, "dir");
        expect(() => createOwnedRuntimeRoot(runtime, nonce)).toThrow(/EEXIST/);
        expect(lstatSync(seeded).isSymbolicLink()).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test.if(process.platform !== "win32")(
    "POSIX root exit watcher stays async and reaps a pipe-holding descendant",
    async () => {
      const root = tempRoot("vf-owned-posix-");
      try {
        const spawner = makeAsyncSpawner({
          graceMs: 100,
          timeoutMs: 5_000,
          evidenceRoot: root,
          ownedProcessPlatform: createOwnedProcessPlatform(),
        });
        let ticks = 0;
        const interval = setInterval(() => {
          ticks++;
        }, 25);
        const started = Date.now();
        const attemptId = "owned-posix-root-exit";
        const result = await spawner(
          process.execPath,
          [
            "-e",
            [
              "const { spawn } = require('node:child_process');",
              "spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 4000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
              "setTimeout(() => { process.stdout.write('root-exit\\\\n'); process.exit(0); }, 2200);",
            ].join(" "),
          ],
          "",
          { attemptId, engine: "codex", evidenceRoot: root },
        );
        clearInterval(interval);
        const record = new OwnedProcessRecordStore(root).read(attemptId);
        expect(Date.now() - started).toBeGreaterThan(2_000);
        expect(ticks).toBeGreaterThan(20);
        expect(result.status).toBe(0);
        expect(record?.state).toBe("released");
        expect(record?.process_quiescent).toBe(true);
        expect(record?.supervisor_identity).toBeTruthy();
        expect(record?.cli_identity).toBeTruthy();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test.if(process.platform !== "win32")(
    "spawned CLI cannot observe supervisor-only control paths",
    async () => {
      const root = tempRoot("vf-owned-private-env-");
      const marker = join(root, "cli-environment.json");
      try {
        const spawner = makeAsyncSpawner({
          graceMs: 100,
          timeoutMs: 5_000,
          evidenceRoot: root,
          ownedProcessPlatform: createOwnedProcessPlatform(),
        });
        const keys = Object.values(OWNED_PROCESS_ENV);
        const result = await spawner(
          process.execPath,
          [
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map((key) => [key, Object.hasOwn(process.env, key)]))));`,
          ],
          "",
          { attemptId: "owned-private-env", engine: AGENT_ENGINE.CODEX, evidenceRoot: root },
        );
        expect(result.status).toBe(0);
        expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual(
          Object.fromEntries(keys.map((key) => [key, false])),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test("supervisor containment must match the reserved quiescence scope", () => {
    const root = tempRoot("vf-owned-containment-");
    try {
      const platform = createOwnedProcessPlatform();
      const store = new OwnedProcessRecordStore(root);
      const controller = new OwnedProcessController(
        store,
        platform,
        store.reserve("owned-containment", AGENT_ENGINE.CODEX, platform),
      );
      const mismatched =
        platform.strategy === OWNED_PROCESS_STRATEGY.WINDOWS_TREE
          ? OWNED_PROCESS_QUIESCENCE_SCOPE.POSIX_PROCESS_GROUP
          : OWNED_PROCESS_QUIESCENCE_SCOPE.WINDOWS_JOB;
      expect(() => controller.assertSupervisorContainment(mismatched)).toThrow(
        "owned supervisor containment receipt changed",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.if(process.platform === "darwin")(
    "Darwin process identity includes kernel start-time microseconds",
    () => {
      expect(processStartIdentity(process.pid)).toMatch(/^darwin:\d+:\d{1,6}$/);
    },
  );

  test("released pre-scope records remain readable without minting a qualified proof", () => {
    const root = tempRoot("vf-owned-legacy-release-");
    try {
      const store = new OwnedProcessRecordStore(root);
      const recordedAt = new Date().toISOString();
      const preimage = {
        schema_version: "1.0" as const,
        attempt_id: "owned-legacy-released",
        engine: "codex" as const,
        host: hostname(),
        platform: process.platform,
        strategy: "posix-session" as const,
        owner_pid: process.pid,
        owner_identity: SYNTHETIC_IDENTITY.LEGACY_OWNER,
        supervisor_pid: null,
        supervisor_identity: null,
        cli_pid: null,
        cli_identity: null,
        terminal_kind: null,
        state: "released" as const,
        release_reason: "legacy release",
        exit_code: 0,
        process_quiescent: true,
        prior_record_digest: null,
        recorded_at: recordedAt,
        updated_at: recordedAt,
      };
      const legacy = {
        ...preimage,
        record_digest: digestV1("VF-OWNED-CLI-RUNTIME\0v1\0", preimage),
      };
      store.reserve(preimage.attempt_id, preimage.engine, createOwnedProcessPlatform());
      const entry = ownedRecordEntry(store, preimage.attempt_id);
      const path = ownedRecordPath(root, entry);
      const bytes = canonicalJsonBytes(legacy);
      writeFileSync(path, bytes, { mode: 0o600 });

      const normalized = store.readEntry(entry);
      assertOwnedProcessRecord(normalized);
      expect(normalized?.quiescence_scope).toBe("legacy-unscoped");
      expect(normalized?.proof_strength).toBe("legacy-unqualified");
      expect(
        inspectOwnedAttemptProcesses(store, createOwnedProcessPlatform(), true).uncertain,
      ).toEqual([]);
      expect(readFileSync(path).equals(bytes)).toBe(true);
      if (!normalized) throw new Error("missing normalized legacy record");
      expect(
        verifyOwnedProcessReleaseProof(
          createOwnedProcessReleaseProof({
            process_quiescent: true,
            strategy: normalized.strategy,
            quiescence_scope: normalized.quiescence_scope,
            proof_strength: normalized.proof_strength,
            runtime_record_digest: `sha256:${"1".repeat(64)}`,
            released_record_digest: normalized.record_digest,
            terminal_kind: normalized.terminal_kind,
            exit_code: normalized.exit_code,
            released_at: normalized.updated_at,
          }),
          normalized,
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("POSIX identity failures distinguish a live process from an absent PID", () => {
    const live = createOwnedProcessPlatform({
      platform: "linux",
      processStartIdentity: () => null,
      kill: (() => true) as typeof process.kill,
      execFileSync: (() => {
        throw new Error("ps must not run without a start identity");
      }) as never,
    });
    const absent = createOwnedProcessPlatform({
      platform: "linux",
      processStartIdentity: () => null,
      kill: (() => {
        throw Object.assign(new Error("absent"), { code: "ESRCH" });
      }) as typeof process.kill,
      execFileSync: (() => {
        throw new Error("ps must not run without a start identity");
      }) as never,
    });

    expect(live.probe?.(41)).toEqual({ kind: "unknown" });
    expect(absent.probe?.(41)).toEqual({ kind: "absent" });
  });

  test("POSIX root-loss recovery terminates the exact surviving CLI process group", async () => {
    let cliAlive = true;
    const signals: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    const platform = createOwnedProcessPlatform({
      platform: "linux",
      processStartIdentity: (pid) => (pid === 42 && cliAlive ? linuxIdentity(42) : null),
      kill: ((pid: number, signal: NodeJS.Signals | number) => {
        if (pid === 42 && signal === 0 && cliAlive) return true;
        if (pid === -41 && cliAlive) {
          signals.push({ pid, signal });
          cliAlive = false;
          return true;
        }
        throw Object.assign(new Error("absent"), { code: "ESRCH" });
      }) as typeof process.kill,
      execFileSync: ((_command: string, args: string[]) => {
        if (args.includes("pgid=")) return cliAlive ? "41" : "";
        if (args.includes("pid=,pgid=")) return cliAlive ? "42 41\n" : "";
        throw new Error(`unexpected ps args: ${args.join(" ")}`);
      }) as never,
    });
    const recordedAt = new Date().toISOString();
    const record = {
      schema_version: "1.0",
      attempt_id: "owned-posix-root-loss",
      engine: "codex",
      host: "host",
      platform: "linux",
      strategy: "posix-session",
      quiescence_scope: "posix-process-group",
      proof_strength: "cooperative-lineage",
      owner_pid: 1,
      owner_identity: SYNTHETIC_IDENTITY.OWNER,
      supervisor_pid: 41,
      supervisor_identity: linuxIdentity(41),
      cli_pid: 42,
      cli_identity: linuxIdentity(42),
      terminal_kind: null,
      state: "running",
      release_reason: null,
      exit_code: null,
      process_quiescent: false,
      prior_record_digest: null,
      recorded_at: recordedAt,
      updated_at: recordedAt,
      record_digest: `sha256:${"0".repeat(64)}`,
    } as const;

    await expect(reapOwnedProcessRecord(platform, record, 0, "recovery")).resolves.toBe(true);
    expect(signals).toEqual([{ pid: -41, signal: "SIGTERM" }]);
  });

  test.if(process.platform !== "win32")(
    "POSIX observe reads the live process without killing it",
    () => {
      const observation = createOwnedProcessPlatform().observe(process.pid);
      expect(observation?.pid).toBe(process.pid);
      expect(observation?.identity).toBeTruthy();
      expect(observation?.pgid && observation.pgid > 0).toBe(true);
      expect(observation?.sid).toBeNull();
      expect(createOwnedProcessPlatform().quiescenceScope).toBe("posix-process-group");
      expect(createOwnedProcessPlatform().proofStrength).toBe("cooperative-lineage");
    },
  );

  test("Windows process inspection fails closed on mismatch/query failure", () => {
    const responses = new Map<number, string | Error>([
      [41, WINDOWS_TICKS.SUPERVISOR.toString()],
      [42, new Error("powershell failed")],
    ]);
    const platform = createOwnedProcessPlatform({
      platform: "win32",
      windowsSystemRoot: "C:\\Windows",
      kill: (() => true) as typeof process.kill,
      processStartIdentity: () => null,
      execFileSync: ((cmd: string, args: string[]) => {
        if (cmd === "taskkill") return "";
        const pid = Number((args[2] ?? "").match(/ProcessId = (\d+)/)?.[1]);
        const response = responses.get(pid);
        if (response instanceof Error) throw Object.assign(response, { status: 1 });
        return (
          response ??
          (() => {
            throw Object.assign(new Error("absent"), { status: 3 });
          })()
        );
      }) as never,
    });
    expect(
      platform.proveQuiescent(
        {
          schema_version: "1.0",
          attempt_id: "owned-win-mismatch",
          engine: "codex",
          host: "host",
          platform: "win32",
          strategy: "windows-tree",
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
          recorded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          record_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        } as never,
        "active",
      ),
    ).toBeNull();
  });

  test("Windows tree termination uses taskkill /PID /T and hidden supervisor launch", () => {
    const calls: Array<{ cmd: string; args: string[]; windowsHide?: boolean }> = [];
    let receiptReads = 0;
    const root = tempRoot("vf-owned-launch-");
    try {
      const platform = {
        strategy: "windows-tree" as const,
        platform: "win32" as const,
        observe: (pid: number) =>
          pid === process.pid
            ? { pid, identity: WINDOWS_IDENTITY.OWNER, pgid: null, sid: null }
            : pid === 900
              ? { pid, identity: WINDOWS_IDENTITY.SUPERVISOR, pgid: null, sid: null }
              : null,
        proveQuiescent: () => null,
        terminateExactTree: (rootObservation: { pid: number }, force: boolean) => {
          calls.push({
            cmd: "taskkill",
            args: ["/PID", String(rootObservation.pid), "/T", ...(force ? ["/F"] : [])],
          });
        },
      };
      const store = new OwnedProcessRecordStore(root);
      const controller = new OwnedProcessController(
        store,
        platform,
        store.reserve("owned-win-bind-failure", "codex", platform),
      );
      const fakeChild = new EventEmitter() as EventEmitter & {
        pid: number;
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        kill(signal?: NodeJS.Signals): boolean;
      };
      fakeChild.pid = 900;
      fakeChild.stdin = new PassThrough();
      fakeChild.stdout = new PassThrough();
      fakeChild.stderr = new PassThrough();
      fakeChild.kill = () => true;
      expect(() =>
        launchOwnedSupervisorProcess(
          [process.execPath, "-e", "process.exit(0)"],
          { detached: false, env: {}, stdinText: "", ownedRuntime: controller },
          {
            delay: () => new Promise(() => undefined),
            mkdirSync,
            now: () => 1,
            randomUUID: () => "00000000-0000-4000-8000-000000000001",
            readFileSync: (() =>
              JSON.stringify(
                receiptReads++ === 0
                  ? {
                      supervisor_pid: 900,
                      containment: OWNED_PROCESS_QUIESCENCE_SCOPE.WINDOWS_JOB,
                    }
                  : {
                      cli_pid: 901,
                      cli_identity: null,
                      cli_identity_state: OWNED_CLI_IDENTITY_STATE.UNKNOWN,
                      cli_pgid: null,
                    },
              )) as never,
            rmSync: (() => undefined) as never,
            spawn: ((
              cmd: string,
              args: string[],
              options: { env: Record<string, string>; windowsHide?: boolean },
            ) => {
              calls.push({ cmd, args, windowsHide: options.windowsHide });
              return fakeChild as never;
            }) as never,
            tmpdir: () => root,
          },
        ),
      ).toThrow(/owned process identity is unavailable/);
      const record = store.read("owned-win-bind-failure");
      expect(calls[0]).toMatchObject({
        cmd: process.execPath,
        args: ["-e", expect.any(String)],
        windowsHide: true,
      });
      expect(calls.slice(1)).toEqual([
        { cmd: "taskkill", args: ["/PID", "900", "/T"] },
        { cmd: "taskkill", args: ["/PID", "900", "/T", "/F"] },
      ]);
      expect(record?.state).toBe("uncertain");
      expect(record?.supervisor_pid).toBe(900);
      expect(record?.cli_pid).toBe(901);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("supervisor never executes the CLI before durable bind ack succeeds", async () => {
    const root = tempRoot("vf-owned-bind-");
    const marker = join(root, "cli-started");
    try {
      const platform = createOwnedProcessPlatform();
      const store = new OwnedProcessRecordStore(root);
      const controller = new OwnedProcessController(
        store,
        platform,
        store.reserve("owned-bind-window", "codex", platform),
      ) as OwnedProcessController & { bindSupervisor(pid: number): never };
      controller.bindSupervisor = () => {
        throw new Error("bind boom");
      };
      expect(() =>
        launchOwnedSupervisorProcess(
          [
            process.execPath,
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); process.exit(0);`,
          ],
          {
            detached: process.platform !== "win32",
            env: {},
            stdinText: "",
            ownedRuntime: controller,
          },
        ),
      ).toThrow(/bind boom/);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.if(process.platform !== "win32")(
    "status write failure terminates the supervisor and resolves the watcher",
    async () => {
      const root = tempRoot("vf-owned-status-write-failure-");
      const nonce = "00000000-0000-4000-8000-0000000000ff";
      const statusPath = join(
        realpathSync(root),
        `vibeflow-owned-runtime-${nonce}`,
        `status-${nonce}.json`,
      );
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const platform = createOwnedProcessPlatform();
        const store = new OwnedProcessRecordStore(root);
        const controller = new OwnedProcessController(
          store,
          platform,
          store.reserve("owned-status-write-failure", "codex", platform),
        );
        const processHandle = launchOwnedSupervisorProcess(
          [process.execPath, "-e", "setTimeout(() => process.exit(0), 250);"],
          {
            detached: true,
            env: {},
            stdinText: "",
            ownedRuntime: controller,
          },
          {
            delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            mkdirSync,
            now: Date.now,
            randomUUID: () => nonce,
            readFileSync,
            rmSync: ((path: string, options: { force?: boolean }) => {
              if (path === statusPath) return;
              rmSync(path, options);
            }) as never,
            spawn: nodeSpawn,
            tmpdir: () => root,
            writeFileSync,
          },
        );
        mkdirSync(statusPath);
        const startedAt = Date.now();
        const rootOutcome = await Promise.race([
          processHandle.rootExited as NonNullable<typeof processHandle.rootExited>,
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () => reject(new Error("owned supervisor watcher did not terminate")),
              5_000,
            );
          }),
        ]);

        expect(rootOutcome).toEqual({
          phase: OWNED_SUPERVISOR_TERMINAL_PHASE.SUPERVISOR_EXITED_UNPROVEN,
          exitCode: 1,
        });
        expect(Date.now() - startedAt).toBeLessThan(5_000);
        await expect(processHandle.exited).resolves.toBe(1);
      } finally {
        if (deadline) clearTimeout(deadline);
        rmSync(root, { recursive: true, force: true });
      }
    },
    10_000,
  );

  test("startup scan reports uncertainty before a live owner and blocks new launches", async () => {
    const root = tempRoot("vf-owned-uncertain-");
    try {
      const platform = {
        strategy: "posix-session" as const,
        platform: process.platform,
        observe: (pid: number) =>
          pid === process.pid
            ? { pid, identity: SYNTHETIC_IDENTITY.OWNER, pgid: process.pid, sid: null }
            : pid === 700
              ? { pid, identity: SYNTHETIC_IDENTITY.SUPERVISOR, pgid: 700, sid: null }
              : pid === 701
                ? { pid, identity: SYNTHETIC_IDENTITY.CLI, pgid: 700, sid: null }
                : null,
        terminateExactTree: () => undefined,
        proveQuiescent: () => true,
      };
      const store = new OwnedProcessRecordStore(root);
      const reserved = store.reserve("owned-uncertain", "codex", platform);
      const { record_digest: _digest, ...preimage } = reserved;
      const uncertain = buildOwnedProcessRecord({
        ...preimage,
        supervisor_pid: 700,
        supervisor_identity: SYNTHETIC_IDENTITY.SUPERVISOR,
        cli_pid: 701,
        cli_identity: SYNTHETIC_IDENTITY.CLI,
        state: "uncertain",
        release_reason: "injected",
        updated_at: new Date().toISOString(),
      });
      store.write(uncertain.attempt_id, reserved, uncertain);
      const report = inspectOwnedAttemptProcesses(store, platform, false);
      expect(report.active).toHaveLength(0);
      expect(report.uncertain[0]?.reason).toBe("runtime already uncertain");
      expect(() => assertOwnedProcessHealthClear(report, "launch")).toThrow(
        /launch blocked by uncertainty/,
      );
      const spawner = makeAsyncSpawner({
        evidenceRoot: root,
        ownedProcessPlatform: platform,
        timeoutMs: 500,
      });
      await expect(
        spawner(process.execPath, ["-e", "process.exit(0)"], "", {
          attemptId: "owned-blocked-launch",
          engine: "codex",
          evidenceRoot: root,
        }),
      ).rejects.toThrow(/launch blocked by uncertainty/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("release proof self-verifies against the persisted released record", () => {
    const root = tempRoot("vf-owned-proof-");
    try {
      const platform = {
        strategy: "posix-session" as const,
        platform: process.platform,
        observe: (pid: number) => {
          if (pid === process.pid)
            return { pid, identity: SYNTHETIC_IDENTITY.OWNER, pgid: process.pid, sid: null };
          if (pid === 700)
            return { pid, identity: SYNTHETIC_IDENTITY.SUPERVISOR, pgid: 700, sid: null };
          if (pid === 701) return { pid, identity: SYNTHETIC_IDENTITY.CLI, pgid: 700, sid: null };
          return null;
        },
        terminateExactTree: () => undefined,
        proveQuiescent: () => true,
      };
      const store = new OwnedProcessRecordStore(root);
      const controller = new OwnedProcessController(
        store,
        platform,
        store.reserve("owned-proof", "codex", platform),
      );
      controller.bindLaunch(700, 701);
      const proof = controller.finalize(0, "engine exit");
      const released = store.read("owned-proof");
      expect(proof).not.toBeNull();
      expect(released?.state).toBe("released");
      expect(released?.prior_record_digest).toBe(proof?.runtime_record_digest ?? null);
      expect(proof?.released_record_digest ?? null).toBe(released?.record_digest ?? null);
      expect(proof?.quiescence_scope).toBe("posix-process-group");
      expect(proof?.proof_strength).toBe("cooperative-lineage");
      expect(proof && released ? verifyOwnedProcessReleaseProof(proof, released) : false).toBe(
        true,
      );
      if (!proof || !released) throw new Error("missing release proof fixture");
      const { release_verifier: _verifier, ...proofPreimage } = proof;
      for (const mismatch of [
        { strategy: "windows-tree" as const },
        { quiescence_scope: "windows-job" as const },
        { proof_strength: "kernel-contained" as const },
        { terminal_kind: OWNED_PROCESS_TERMINAL_KIND.CODEX_TURN_COMPLETED },
        { exit_code: 9 },
        { released_at: new Date(Date.parse(proof.released_at) + 1_000).toISOString() },
      ]) {
        expect(
          verifyOwnedProcessReleaseProof(
            createOwnedProcessReleaseProof({ ...proofPreimage, ...mismatch }),
            released,
          ),
        ).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("record reads bind decoded attempt identity to the requested storage key", () => {
    const root = tempRoot("vf-owned-storage-binding-");
    try {
      const platform = {
        strategy: OWNED_PROCESS_STRATEGY.POSIX_SESSION,
        platform: process.platform,
        observe: (pid: number) =>
          pid === process.pid
            ? { pid, identity: SYNTHETIC_IDENTITY.OWNER, pgid: process.pid, sid: null }
            : null,
        terminateExactTree: () => undefined,
        proveQuiescent: () => true,
      };
      const store = new OwnedProcessRecordStore(root);
      const sourceAttemptId = "owned-storage-source";
      const targetAttemptId = "owned-storage-target";
      store.reserve(sourceAttemptId, "codex", platform);
      store.reserve(targetAttemptId, "codex", platform);
      const sourceEntry = ownedRecordEntry(store, sourceAttemptId);
      const targetEntry = ownedRecordEntry(store, targetAttemptId);
      writeFileSync(
        ownedRecordPath(root, targetEntry),
        readFileSync(ownedRecordPath(root, sourceEntry)),
      );

      expect(() => store.read(targetAttemptId)).toThrow(
        OWNED_PROCESS_AUTHORITY_ERROR.STORAGE_BINDING,
      );
      expect(() => store.readEntry(targetEntry)).toThrow(
        OWNED_PROCESS_AUTHORITY_ERROR.STORAGE_BINDING,
      );
      expect(() => store.listOpenRecords()).toThrow(OWNED_PROCESS_AUTHORITY_ERROR.STORAGE_BINDING);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("record writes reject mismatched current and next attempts without changing bytes", () => {
    const root = tempRoot("vf-owned-write-binding-");
    try {
      const platform = {
        strategy: OWNED_PROCESS_STRATEGY.POSIX_SESSION,
        platform: process.platform,
        observe: (pid: number) =>
          pid === process.pid
            ? { pid, identity: SYNTHETIC_IDENTITY.OWNER, pgid: process.pid, sid: null }
            : null,
        terminateExactTree: () => undefined,
        proveQuiescent: () => true,
      };
      const store = new OwnedProcessRecordStore(root);
      const targetAttemptId = "owned-write-target";
      const foreignAttemptId = "owned-write-foreign";
      const target = store.reserve(targetAttemptId, "codex", platform);
      const foreign = store.reserve(foreignAttemptId, "codex", platform);
      const targetPath = ownedRecordPath(root, ownedRecordEntry(store, targetAttemptId));
      const targetBytes = readFileSync(targetPath);

      expect(() => store.write(targetAttemptId, target, foreign)).toThrow(
        OWNED_PROCESS_AUTHORITY_ERROR.WRITE_BINDING,
      );
      expect(readFileSync(targetPath).equals(targetBytes)).toBe(true);
      expect(() => store.write(targetAttemptId, foreign, target)).toThrow(
        OWNED_PROCESS_AUTHORITY_ERROR.WRITE_BINDING,
      );
      expect(readFileSync(targetPath).equals(targetBytes)).toBe(true);
      const invalid = {
        ...target,
        [OWNED_PROCESS_RECORD_FIELD.RECORD_DIGEST]:
          foreign[OWNED_PROCESS_RECORD_FIELD.RECORD_DIGEST],
      };
      expect(() => store.write(targetAttemptId, target, invalid)).toThrow();
      expect(readFileSync(targetPath).equals(targetBytes)).toBe(true);
      expect(() => store.write(targetAttemptId, invalid, target)).toThrow();
      expect(readFileSync(targetPath).equals(targetBytes)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("controller bindings and terminal observations are exact-idempotent", () => {
    const root = tempRoot("vf-owned-controller-authority-");
    const identities = new Map<number, string>([
      [process.pid, SYNTHETIC_IDENTITY.OWNER],
      [700, SYNTHETIC_IDENTITY.SUPERVISOR],
      [701, SYNTHETIC_IDENTITY.CLI],
    ]);
    try {
      const platform = {
        strategy: OWNED_PROCESS_STRATEGY.POSIX_SESSION,
        platform: process.platform,
        observe: (pid: number) => {
          const identity = identities.get(pid);
          return identity ? { pid, identity, pgid: pid === 701 ? 700 : pid, sid: null } : null;
        },
        terminateExactTree: () => undefined,
        proveQuiescent: () => true,
      };
      const store = new OwnedProcessRecordStore(root);
      const attemptId = "owned-controller-authority";
      const controller = new OwnedProcessController(
        store,
        platform,
        store.reserve(attemptId, "codex", platform),
      );
      const path = ownedRecordPath(root, ownedRecordEntry(store, attemptId));

      expect(() =>
        controller.noteTerminal(OWNED_PROCESS_TERMINAL_KIND.CODEX_TURN_COMPLETED),
      ).toThrow(OWNED_PROCESS_AUTHORITY_ERROR.ILLEGAL_TRANSITION);
      controller.bindSupervisor(700);
      const supervisorBytes = readFileSync(path);
      controller.bindSupervisor(700);
      expect(readFileSync(path).equals(supervisorBytes)).toBe(true);
      identities.set(700, SYNTHETIC_IDENTITY.REPLACEMENT_SUPERVISOR);
      expect(() => controller.bindSupervisor(700)).toThrow(
        OWNED_PROCESS_AUTHORITY_ERROR.BINDING_CONFLICT,
      );
      expect(readFileSync(path).equals(supervisorBytes)).toBe(true);

      identities.set(700, SYNTHETIC_IDENTITY.SUPERVISOR);
      controller.bindLaunch(700, 701);
      const runningBytes = readFileSync(path);
      controller.bindLaunch(700, 701);
      expect(readFileSync(path).equals(runningBytes)).toBe(true);
      identities.set(701, SYNTHETIC_IDENTITY.REPLACEMENT_CLI);
      expect(() => controller.bindLaunch(700, 701)).toThrow(
        OWNED_PROCESS_AUTHORITY_ERROR.BINDING_CONFLICT,
      );
      expect(readFileSync(path).equals(runningBytes)).toBe(true);

      identities.set(701, SYNTHETIC_IDENTITY.CLI);
      controller.noteTerminal(OWNED_PROCESS_TERMINAL_KIND.CODEX_TURN_COMPLETED);
      const terminalBytes = readFileSync(path);
      controller.noteTerminal(OWNED_PROCESS_TERMINAL_KIND.CODEX_TURN_COMPLETED);
      expect(readFileSync(path).equals(terminalBytes)).toBe(true);
      expect(() =>
        controller.noteTerminal(OWNED_PROCESS_TERMINAL_KIND.OUTPUT_DRAIN_UNPROVEN),
      ).toThrow(OWNED_PROCESS_AUTHORITY_ERROR.BINDING_CONFLICT);
      expect(readFileSync(path).equals(terminalBytes)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("repeated finalize returns the original proof and leaves released bytes immutable", () => {
    const root = tempRoot("vf-owned-finalize-idempotence-");
    let quiescenceProofs = 0;
    try {
      const platform = {
        strategy: OWNED_PROCESS_STRATEGY.POSIX_SESSION,
        platform: process.platform,
        observe: (pid: number) => {
          if (pid === process.pid)
            return { pid, identity: SYNTHETIC_IDENTITY.OWNER, pgid: process.pid, sid: null };
          if (pid === 700)
            return { pid, identity: SYNTHETIC_IDENTITY.SUPERVISOR, pgid: 700, sid: null };
          if (pid === 701) return { pid, identity: SYNTHETIC_IDENTITY.CLI, pgid: 700, sid: null };
          return null;
        },
        terminateExactTree: () => undefined,
        proveQuiescent: () => {
          quiescenceProofs++;
          return true;
        },
      };
      const store = new OwnedProcessRecordStore(root);
      const attemptId = "owned-finalize-idempotence";
      const controller = new OwnedProcessController(
        store,
        platform,
        store.reserve(attemptId, "codex", platform),
      );
      controller.bindLaunch(700, 701);
      controller.noteTerminal(OWNED_PROCESS_TERMINAL_KIND.CODEX_TURN_COMPLETED);
      const firstProof = controller.finalize(0, "engine exit");
      const path = ownedRecordPath(root, ownedRecordEntry(store, attemptId));
      const releasedBytes = readFileSync(path);
      const secondProof = controller.finalize(9, "ignored repeat");
      const released = store.read(attemptId);

      expect(secondProof).toEqual(firstProof);
      expect(readFileSync(path).equals(releasedBytes)).toBe(true);
      expect(quiescenceProofs).toBe(1);
      expect(
        firstProof && released ? verifyOwnedProcessReleaseProof(firstProof, released) : false,
      ).toBe(true);
      expect(
        secondProof && released ? verifyOwnedProcessReleaseProof(secondProof, released) : false,
      ).toBe(true);
      expect(() => controller.bindSupervisor(700)).toThrow(
        OWNED_PROCESS_AUTHORITY_ERROR.ILLEGAL_TRANSITION,
      );
      expect(() =>
        controller.noteTerminal(OWNED_PROCESS_TERMINAL_KIND.CODEX_TURN_COMPLETED),
      ).toThrow(OWNED_PROCESS_AUTHORITY_ERROR.ILLEGAL_TRANSITION);
      expect(() => controller.failLaunch(700, 701, "late failure")).toThrow(
        OWNED_PROCESS_AUTHORITY_ERROR.ILLEGAL_TRANSITION,
      );
      expect(readFileSync(path).equals(releasedBytes)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("owned terminal records reject unknown strings and persist only contract kinds", () => {
    const root = tempRoot("vf-owned-terminal-contract-");
    try {
      const platform = {
        strategy: OWNED_PROCESS_STRATEGY.POSIX_SESSION,
        platform: process.platform,
        observe: (pid: number) =>
          pid === process.pid
            ? { pid, identity: SYNTHETIC_IDENTITY.OWNER, pgid: process.pid, sid: null }
            : pid === 700
              ? { pid, identity: SYNTHETIC_IDENTITY.SUPERVISOR, pgid: 700, sid: null }
              : pid === 701
                ? { pid, identity: SYNTHETIC_IDENTITY.CLI, pgid: 700, sid: null }
                : null,
        terminateExactTree: () => undefined,
        proveQuiescent: () => true,
      };
      const store = new OwnedProcessRecordStore(root);
      const reserved = store.reserve("owned-terminal-contract", "codex", platform);
      const { record_digest: _digest, ...preimage } = reserved;
      expect(() =>
        buildOwnedProcessRecord({ ...preimage, terminal_kind: "unknown-terminal" as never }),
      ).toThrow(/invalid owned process record/);
      const controller = new OwnedProcessController(store, platform, reserved);

      controller.bindLaunch(700, 701);
      controller.noteTerminal(OWNED_PROCESS_TERMINAL_KIND.CODEX_TURN_COMPLETED);

      expect(store.read("owned-terminal-contract")?.terminal_kind).toBe(
        OWNED_PROCESS_TERMINAL_KIND.CODEX_TURN_COMPLETED,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Windows fast exit binds an absent-after-probe receipt without trusting a reused PID", () => {
    const root = tempRoot("vf-owned-win-fast-exit-");
    try {
      const platform = {
        strategy: OWNED_PROCESS_STRATEGY.WINDOWS_TREE,
        platform: "win32" as const,
        probe: (pid: number) =>
          pid === 701 ? ({ kind: "absent" } as const) : ({ kind: "unknown" } as const),
        observe: (pid: number) => {
          if (pid === process.pid)
            return { pid, identity: WINDOWS_IDENTITY.OWNER, pgid: null, sid: null };
          if (pid === 700)
            return { pid, identity: WINDOWS_IDENTITY.SUPERVISOR, pgid: null, sid: null };
          return null;
        },
        terminateExactTree: () => undefined,
        proveQuiescent: () => true,
      };
      const store = new OwnedProcessRecordStore(root);
      const controller = new OwnedProcessController(
        store,
        platform,
        store.reserve("owned-win-fast-exit", "codex", platform),
      );
      const running = controller.bindLaunch(700, 701, {
        identity: null,
        identityState: OWNED_CLI_IDENTITY_STATE.ABSENT_AFTER_PROBE,
      });
      expect(running.state).toBe(OWNED_PROCESS_STATE.RUNNING);
      expect(running.cli_identity).toBe(WINDOWS_EXITED_CLI_IDENTITY);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("launch identity settles a transient probe race but persistent uncertainty fails closed", () => {
    const root = tempRoot("vf-owned-probe-settle-");
    try {
      let transientProbes = 0;
      const observation = (pid: number) => {
        if (pid === process.pid)
          return { pid, identity: SYNTHETIC_IDENTITY.OWNER, pgid: process.pid, sid: null };
        if (pid === 700)
          return { pid, identity: SYNTHETIC_IDENTITY.SUPERVISOR, pgid: 700, sid: null };
        return null;
      };
      const transientPlatform = {
        strategy: OWNED_PROCESS_STRATEGY.POSIX_SESSION,
        platform: process.platform,
        probe: () =>
          transientProbes++ === 0 ? ({ kind: "unknown" } as const) : ({ kind: "absent" } as const),
        observe: observation,
        terminateExactTree: () => undefined,
        proveQuiescent: () => true,
      };
      const store = new OwnedProcessRecordStore(root);
      const transient = new OwnedProcessController(
        store,
        transientPlatform,
        store.reserve("owned-transient-probe", "codex", transientPlatform),
      );
      const running = transient.bindLaunch(700, 701, {
        identity: SYNTHETIC_IDENTITY.RECEIPT_CLI,
        identityState: OWNED_CLI_IDENTITY_STATE.AVAILABLE,
        pgid: 700,
      });
      expect(transientProbes).toBe(2);
      expect(running.state).toBe(OWNED_PROCESS_STATE.RUNNING);
      expect(running.cli_identity).toBe(SYNTHETIC_IDENTITY.RECEIPT_CLI);

      let persistentProbes = 0;
      const persistentPlatform = {
        ...transientPlatform,
        probe: () => {
          persistentProbes++;
          return { kind: "unknown" as const };
        },
      };
      const persistent = new OwnedProcessController(
        store,
        persistentPlatform,
        store.reserve("owned-persistent-probe", "codex", persistentPlatform),
      );
      expect(() =>
        persistent.bindLaunch(700, 701, {
          identity: SYNTHETIC_IDENTITY.RECEIPT_CLI,
          identityState: OWNED_CLI_IDENTITY_STATE.AVAILABLE,
          pgid: 700,
        }),
      ).toThrow(/owned CLI identity is unavailable/);
      expect(persistentProbes).toBe(OWNED_PROCESS_LIMIT.IDENTITY_SETTLE_ATTEMPTS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("startup scan preserves a live owner and only fixes proved orphans with --fix", () => {
    const root = tempRoot("vf-owned-health-");
    try {
      let ownerAlive = true;
      let terminated = 0;
      const platform = {
        strategy: "posix-session" as const,
        platform: process.platform,
        observe: (pid: number) => {
          if (pid === process.pid && ownerAlive)
            return { pid, identity: SYNTHETIC_IDENTITY.OWNER, pgid: process.pid, sid: null };
          if (pid === 700)
            return { pid, identity: SYNTHETIC_IDENTITY.SUPERVISOR, pgid: 700, sid: null };
          if (pid === 701) return { pid, identity: SYNTHETIC_IDENTITY.CLI, pgid: 700, sid: null };
          return null;
        },
        terminateExactTree: () => {
          terminated++;
        },
        proveQuiescent: () => terminated > 1,
      };
      const store = new OwnedProcessRecordStore(root);
      const live = new OwnedProcessController(
        store,
        platform,
        store.reserve("owned-live", "codex", platform),
      );
      live.bindLaunch(700, 701);
      const active = inspectOwnedAttemptProcesses(store, platform, false);
      expect(active.active.map((record) => record.attempt_id)).toEqual(["owned-live"]);
      ownerAlive = false;
      const uncertain = inspectOwnedAttemptProcesses(store, platform, false);
      expect(uncertain.uncertain[0]?.reason).toBe("proved orphan");
      const fixed = inspectOwnedAttemptProcesses(store, platform, true);
      expect(fixed.recovered.map((record) => record.attempt_id)).toEqual(["owned-live"]);
      expect(terminated).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("callback failure terminates the owned runtime and never leaves the record running", async () => {
    const root = tempRoot("vf-owned-callback-");
    try {
      const spawner = makeAsyncSpawner({
        evidenceRoot: root,
        timeoutMs: 5_000,
        ownedProcessPlatform: createOwnedProcessPlatform(),
        onChunk: () => {
          throw new Error("chunk boom");
        },
      });
      await expect(
        spawner(
          process.execPath,
          ["-e", "process.stdout.write('boom'); setTimeout(() => process.exit(0), 1000);"],
          "",
          {
            attemptId: "owned-chunk-failure",
            engine: "codex",
            evidenceRoot: root,
          },
        ),
      ).rejects.toThrow(/chunk boom/);
      const record = new OwnedProcessRecordStore(root).read("owned-chunk-failure");
      expect(record?.state === "released" || record?.state === "uncertain").toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("owned supervisor receipts use a UUID nonce so concurrent launches do not collide", () => {
    const root = tempRoot("vf-owned-nonce-");
    const receipts: string[] = [];
    try {
      const platform = {
        strategy: "posix-session" as const,
        platform: process.platform,
        observe: (pid: number) =>
          pid === process.pid
            ? { pid, identity: SYNTHETIC_IDENTITY.OWNER, pgid: process.pid, sid: null }
            : pid === 901
              ? { pid, identity: SYNTHETIC_IDENTITY.SUPERVISOR, pgid: 901, sid: null }
              : pid === 902
                ? { pid, identity: SYNTHETIC_IDENTITY.CLI, pgid: 901, sid: null }
                : null,
        terminateExactTree: () => undefined,
        proveQuiescent: () => true,
      };
      const store = new OwnedProcessRecordStore(root);
      const makeController = (attemptId: string) =>
        new OwnedProcessController(store, platform, store.reserve(attemptId, "codex", platform));
      const receiptReader = () => {
        let reads = 0;
        return (() =>
          JSON.stringify(
            reads++ === 0
              ? {
                  supervisor_pid: 901,
                  containment: OWNED_PROCESS_QUIESCENCE_SCOPE.POSIX_PROCESS_GROUP,
                }
              : {
                  cli_pid: 902,
                  cli_identity: SYNTHETIC_IDENTITY.CLI,
                  cli_identity_state: OWNED_CLI_IDENTITY_STATE.AVAILABLE,
                  cli_pgid: 901,
                },
          )) as never;
      };
      const fakeChild = () => {
        const child = new EventEmitter() as EventEmitter & {
          pid: number;
          stdin: PassThrough;
          stdout: PassThrough;
          stderr: PassThrough;
          kill(signal?: NodeJS.Signals): boolean;
        };
        child.pid = 901;
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => true;
        return child;
      };
      launchOwnedSupervisorProcess(
        [process.execPath, "-e", "process.exit(0)"],
        { detached: false, env: {}, stdinText: "", ownedRuntime: makeController("owned-nonce-a") },
        {
          delay: () => new Promise(() => undefined),
          mkdirSync,
          now: () => 1,
          randomUUID: () => "00000000-0000-4000-8000-00000000000a",
          readFileSync: receiptReader(),
          rmSync: (() => undefined) as never,
          spawn: ((cmd: string, args: string[], options: { env: Record<string, string> }) => {
            receipts.push(options.env[OWNED_PROCESS_ENV.RECEIPT] as string);
            return fakeChild() as never;
          }) as never,
          tmpdir: () => root,
        },
      );
      launchOwnedSupervisorProcess(
        [process.execPath, "-e", "process.exit(0)"],
        { detached: false, env: {}, stdinText: "", ownedRuntime: makeController("owned-nonce-b") },
        {
          delay: () => new Promise(() => undefined),
          mkdirSync,
          now: () => 1,
          randomUUID: () => "00000000-0000-4000-8000-00000000000b",
          readFileSync: receiptReader(),
          rmSync: (() => undefined) as never,
          spawn: ((cmd: string, args: string[], options: { env: Record<string, string> }) => {
            receipts.push(options.env[OWNED_PROCESS_ENV.RECEIPT] as string);
            return fakeChild() as never;
          }) as never,
          tmpdir: () => root,
        },
      );
      expect(receipts).toHaveLength(2);
      expect(new Set(receipts).size).toBe(2);
      expect(
        receipts.every((path) =>
          /receipt-00000000-0000-4000-8000-00000000000[ab]\.json$/.test(path),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
