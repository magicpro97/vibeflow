import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  OWNED_PROCESS_EXIT_CODE,
  OWNED_PROCESS_PRESENCE_KIND,
  OWNED_PROCESS_PROOF_STRENGTH,
  OWNED_PROCESS_QUIESCENCE_SCOPE,
  OWNED_PROCESS_STATE,
  OWNED_PROCESS_STRATEGY,
} from "../src/dispatch/owned-process-contract.js";
import { inspectOwnedAttemptProcesses } from "../src/dispatch/owned-process-health.js";
import { waitForOwnedSupervisorReceipt } from "../src/dispatch/owned-process-launch-receipt.js";
import {
  createOwnedRuntimeRoot,
  defaultOwnedSupervisorLaunchRuntime,
} from "../src/dispatch/owned-process-launch-runtime.js";
import { launchOwnedSupervisorProcess } from "../src/dispatch/owned-process-launch.js";
import {
  type OwnedProcessObservation,
  type OwnedProcessPlatform,
  type OwnedProcessPresence,
  createOwnedProcessPlatform,
  resolveOwnedWindowsSystemRoot,
} from "../src/dispatch/owned-process-platform.js";
import {
  reapOwnedProcessRecord,
  reapOwnedProcessRecordSync,
} from "../src/dispatch/owned-process-reaper.js";
import {
  type OwnedAttemptProcessRecordV1,
  OwnedProcessRecordStore,
  buildOwnedProcessRecord,
} from "../src/dispatch/owned-process-runtime.js";
import {
  OWNED_SUPERVISOR_TERMINAL_PHASE,
  watchOwnedSupervisorExit,
} from "../src/dispatch/owned-process-status.js";
import { spawnOwnedSupervisorChild } from "../src/dispatch/owned-process-supervisor-child.js";
import { makeAsyncSpawner } from "../src/dispatch/spawners.js";

const ABSENT = { kind: OWNED_PROCESS_PRESENCE_KIND.ABSENT } as const;
const UNKNOWN = { kind: OWNED_PROCESS_PRESENCE_KIND.UNKNOWN } as const;

function observation(pid: number, identity: string, pgid = pid): OwnedProcessObservation {
  return { pid, identity, pgid, sid: null };
}

function present(pid: number, identity: string, pgid = pid): OwnedProcessPresence {
  return {
    kind: OWNED_PROCESS_PRESENCE_KIND.PRESENT,
    observation: observation(pid, identity, pgid),
  };
}

function record(
  attemptId: string,
  state: OwnedAttemptProcessRecordV1["state"],
  overrides: Partial<Omit<OwnedAttemptProcessRecordV1, "record_digest">> = {},
): OwnedAttemptProcessRecordV1 {
  const now = new Date().toISOString();
  const running = state === OWNED_PROCESS_STATE.RUNNING;
  return buildOwnedProcessRecord({
    schema_version: "1.0",
    attempt_id: attemptId,
    engine: "codex",
    host: hostname(),
    platform: process.platform,
    strategy: OWNED_PROCESS_STRATEGY.POSIX_SESSION,
    quiescence_scope: OWNED_PROCESS_QUIESCENCE_SCOPE.POSIX_PROCESS_GROUP,
    proof_strength: OWNED_PROCESS_PROOF_STRENGTH.COOPERATIVE_LINEAGE,
    owner_pid: 10,
    owner_identity: "owner",
    supervisor_pid: running ? 20 : null,
    supervisor_identity: running ? "supervisor" : null,
    cli_pid: running ? 21 : null,
    cli_identity: running ? "cli" : null,
    terminal_kind: null,
    state,
    release_reason: state === OWNED_PROCESS_STATE.UNCERTAIN ? "fixture uncertainty" : null,
    exit_code: null,
    process_quiescent: false,
    prior_record_digest: null,
    recorded_at: now,
    updated_at: now,
    ...overrides,
  });
}

function memoryStore(fixture: OwnedAttemptProcessRecordV1, readError?: Error) {
  const writes: OwnedAttemptProcessRecordV1[] = [];
  const store = {
    entries: () => [`${fixture.attempt_id}.json`],
    readEntry: () => {
      if (readError) throw readError;
      return fixture;
    },
    write: (_attemptId: string, _current: unknown, next: OwnedAttemptProcessRecordV1) => {
      writes.push(next);
    },
  } as unknown as OwnedProcessRecordStore;
  return { store, writes };
}

function fakePlatform(
  presences: ReadonlyMap<number, OwnedProcessPresence>,
  overrides: Partial<OwnedProcessPlatform> = {},
): OwnedProcessPlatform {
  const lookup = (pid: number) => presences.get(pid) ?? ABSENT;
  return {
    strategy: OWNED_PROCESS_STRATEGY.POSIX_SESSION,
    platform: process.platform,
    probe: lookup,
    observe: (pid) => {
      const value = lookup(pid);
      return value.kind === OWNED_PROCESS_PRESENCE_KIND.PRESENT ? value.observation : null;
    },
    terminateExactTree: () => undefined,
    terminateExactCliFallback: () => undefined,
    proveQuiescent: () => false,
    ...overrides,
  };
}

function healthReason(
  fixture: OwnedAttemptProcessRecordV1,
  platform: OwnedProcessPlatform,
  fix = false,
): string | undefined {
  const { store } = memoryStore(fixture);
  return inspectOwnedAttemptProcesses(store, platform, fix).uncertain[0]?.reason;
}

describe("final owned-process health coverage", () => {
  test("classifies every distinct owner and supervisor uncertainty without guessing", () => {
    expect(
      healthReason(
        record("foreign", OWNED_PROCESS_STATE.RESERVED, { host: "remote.invalid" }),
        fakePlatform(new Map()),
      ),
    ).toBe("foreign host");
    expect(
      healthReason(
        record("uncertain-owner-unknown", OWNED_PROCESS_STATE.UNCERTAIN),
        fakePlatform(new Map([[10, UNKNOWN]])),
      ),
    ).toBe("owner state unknown");
    expect(
      healthReason(
        record("uncertain-owner-mismatch", OWNED_PROCESS_STATE.UNCERTAIN),
        fakePlatform(new Map([[10, present(10, "reused-owner")]])),
      ),
    ).toBe("owner identity mismatch");

    const uncertainWithSupervisor = (attemptId: string) =>
      record(attemptId, OWNED_PROCESS_STATE.UNCERTAIN, {
        supervisor_pid: 20,
        supervisor_identity: "supervisor",
        cli_pid: 21,
        cli_identity: "cli",
      });
    expect(
      healthReason(
        uncertainWithSupervisor("uncertain-supervisor-unknown"),
        fakePlatform(new Map([[20, UNKNOWN]])),
      ),
    ).toBe("supervisor state unknown");
    expect(
      healthReason(
        uncertainWithSupervisor("uncertain-supervisor-mismatch"),
        fakePlatform(new Map([[20, present(20, "reused-supervisor")]])),
      ),
    ).toBe("supervisor identity mismatch");
    expect(
      healthReason(
        uncertainWithSupervisor("uncertain-proved-orphan"),
        fakePlatform(new Map([[20, present(20, "supervisor")]])),
      ),
    ).toBe("runtime already uncertain");
    expect(
      healthReason(
        record("uncertain-no-tree", OWNED_PROCESS_STATE.UNCERTAIN),
        fakePlatform(new Map()),
      ),
    ).toBe("runtime already uncertain");

    expect(
      healthReason(
        record("running-owner-unknown", OWNED_PROCESS_STATE.RUNNING),
        fakePlatform(new Map([[10, UNKNOWN]])),
      ),
    ).toBe("owner state unknown");
    expect(
      healthReason(
        record("running-owner-mismatch", OWNED_PROCESS_STATE.RUNNING),
        fakePlatform(new Map([[10, present(10, "reused-owner")]])),
      ),
    ).toBe("owner identity mismatch");
    expect(
      healthReason(
        record("dead-before-launch", OWNED_PROCESS_STATE.RESERVED),
        fakePlatform(new Map()),
      ),
    ).toBe("dead owner pending release");
    expect(
      healthReason(
        record("running-supervisor-unknown", OWNED_PROCESS_STATE.RUNNING),
        fakePlatform(new Map([[20, UNKNOWN]])),
      ),
    ).toBe("supervisor state unknown");

    const racedAway = fakePlatform(new Map([[20, present(20, "supervisor")]]), {
      observe: () => null,
      proveQuiescent: () => false,
    });
    expect(
      healthReason(record("orphan-unproven", OWNED_PROCESS_STATE.RUNNING), racedAway, true),
    ).toBe("orphan reap unproven");
    expect(
      healthReason(
        record("quiescence-unproven", OWNED_PROCESS_STATE.RUNNING),
        fakePlatform(new Map()),
      ),
    ).toBe("quiescence unprovable");
  });

  test("recovers a dead pre-launch owner and converts corrupt entry reads into uncertainty", () => {
    const fixture = record("dead-prelaunch-fix", OWNED_PROCESS_STATE.RESERVED);
    const { store, writes } = memoryStore(fixture);
    const report = inspectOwnedAttemptProcesses(store, fakePlatform(new Map()), true);
    expect(report.uncertain).toEqual([]);
    expect(report.recovered.map((item) => item.state)).toEqual([OWNED_PROCESS_STATE.RELEASED]);
    expect(writes[0]?.release_reason).toBe("dead owner before launch");

    const corrupt = memoryStore(
      record("corrupt-entry", OWNED_PROCESS_STATE.RESERVED),
      new Error("corrupt fixture"),
    );
    expect(
      inspectOwnedAttemptProcesses(corrupt.store, fakePlatform(new Map()), false).uncertain,
    ).toEqual([{ attempt_id: "corrupt-entry", reason: "corrupt fixture" }]);
  });
});

describe("final owned-process platform and reaper coverage", () => {
  test("native Windows root rejects a failed kernel directory query", () => {
    const require = createRequire(import.meta.url);
    const koffi = require("koffi") as {
      load: (name: string) => {
        func: (signature: string) => (output: Buffer, chars: number) => number;
      };
    };
    const originalLoad = koffi.load;
    let returnValidRoot = false;
    koffi.load = () => ({
      func: () => (output: Buffer) => {
        if (!returnValidRoot) return 0;
        const encoded = Buffer.from("C:\\Windows", "utf16le");
        encoded.copy(output);
        return encoded.byteLength / 2;
      },
    });
    try {
      expect(() => resolveOwnedWindowsSystemRoot()).toThrow(
        "trusted Windows directory query failed",
      );
      returnValidRoot = true;
      expect(resolveOwnedWindowsSystemRoot()).toBe("C:\\Windows");
    } finally {
      koffi.load = originalLoad;
    }
  });

  test("POSIX probes distinguish disappearance after ps failure and unknown group scans", () => {
    let identities = 0;
    const platform = createOwnedProcessPlatform({
      platform: "linux",
      processStartIdentity: () => (identities++ === 0 ? "linux:boot:41" : null),
      execFileSync: (() => {
        throw new Error("injected ps failure");
      }) as never,
      kill: (() => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }) as typeof process.kill,
    });
    expect(platform.probe?.(41)).toEqual(ABSENT);
    identities = 0;
    const unknown = createOwnedProcessPlatform({
      platform: "linux",
      processStartIdentity: () => (identities++ === 0 ? "linux:boot:42" : null),
      execFileSync: (() => {
        throw new Error("injected ps failure");
      }) as never,
      kill: (() => {
        throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      }) as typeof process.kill,
    });
    expect(unknown.probe?.(42)).toEqual(UNKNOWN);
    expect(
      platform.proveQuiescent(record("group-query-failure", OWNED_PROCESS_STATE.RUNNING), "active"),
    ).toBeNull();
  });

  test("exact Windows and POSIX termination reject identity or group drift", () => {
    const windows = createOwnedProcessPlatform({
      platform: "win32",
      windowsSystemRoot: "C:\\Windows",
      execFileSync: (() => "actual-creation") as never,
    });
    expect(() =>
      windows.terminateExactCliFallback?.(
        record("windows-cli-drift", OWNED_PROCESS_STATE.RUNNING, {
          platform: "win32",
          strategy: OWNED_PROCESS_STRATEGY.WINDOWS_TREE,
          quiescence_scope: OWNED_PROCESS_QUIESCENCE_SCOPE.WINDOWS_JOB,
          proof_strength: OWNED_PROCESS_PROOF_STRENGTH.KERNEL_CONTAINED,
        }),
        observation(21, "win32:expected", 21),
        false,
      ),
    ).toThrow("owned Windows CLI identity changed");

    const posix = createOwnedProcessPlatform({
      platform: "linux",
      processStartIdentity: (pid) => `linux:boot:${pid}`,
      execFileSync: ((_command: string, args: string[]) =>
        args.includes("pgid=") ? "99" : "") as never,
      kill: (() => true) as typeof process.kill,
    });
    expect(() => posix.terminateExactTree(observation(20, "linux:boot:20", 20), false)).toThrow(
      "owned POSIX root identity changed",
    );
    expect(() =>
      posix.terminateExactCliFallback?.(
        record("posix-cli-drift", OWNED_PROCESS_STATE.RUNNING),
        observation(21, "linux:boot:21", 20),
        false,
      ),
    ).toThrow("owned POSIX CLI identity changed");
  });

  test("Windows Job proof accepts an absent bound tree", () => {
    const platform = createOwnedProcessPlatform({
      platform: "win32",
      windowsSystemRoot: "C:\\Windows",
      execFileSync: (() => {
        throw Object.assign(new Error("absent"), { status: 3 });
      }) as never,
    });
    const fixture = record("windows-job-absent", OWNED_PROCESS_STATE.RUNNING, {
      platform: "win32",
      strategy: OWNED_PROCESS_STRATEGY.WINDOWS_TREE,
      quiescence_scope: OWNED_PROCESS_QUIESCENCE_SCOPE.WINDOWS_JOB,
      proof_strength: OWNED_PROCESS_PROOF_STRENGTH.KERNEL_CONTAINED,
    });
    expect(platform.proveQuiescent(fixture, "active")).toBe(true);
    expect(
      platform.proveQuiescent(
        record("windows-hinted-release", OWNED_PROCESS_STATE.RESERVED, {
          platform: "win32",
          strategy: OWNED_PROCESS_STRATEGY.WINDOWS_TREE,
          quiescence_scope: OWNED_PROCESS_QUIESCENCE_SCOPE.WINDOWS_JOB,
          proof_strength: OWNED_PROCESS_PROOF_STRENGTH.KERNEL_CONTAINED,
        }),
        "active",
        { exact_tree_termination_succeeded: true },
      ),
    ).toBe(true);
  });

  test("async and sync reapers preserve a failed force-termination proof", async () => {
    const fixture = record("force-termination-failure", OWNED_PROCESS_STATE.RUNNING);
    const hints: Array<Record<string, boolean | undefined>> = [{}, {}];
    const platform = fakePlatform(
      new Map([
        [20, present(20, "supervisor")],
        [21, present(21, "cli", 20)],
      ]),
      {
        terminateExactTree: () => {
          throw new Error("injected termination failure");
        },
        proveQuiescent: () => false,
      },
    );
    await expect(reapOwnedProcessRecord(platform, fixture, 0, "active", hints[0])).resolves.toBe(
      false,
    );
    expect(reapOwnedProcessRecordSync(platform, fixture, 0, "active", hints[1])).toBe(false);
    expect(hints).toEqual([
      { exact_tree_termination_succeeded: false },
      { exact_tree_termination_succeeded: false },
    ]);
  });
});

describe("final owned-process launch and status coverage", () => {
  test("receipt timeout fails explicitly without accepting a missing PID", () => {
    let calls = 0;
    expect(() =>
      waitForOwnedSupervisorReceipt("missing.json", "supervisor_pid", {
        now: () => (calls++ === 0 ? 0 : Number.MAX_SAFE_INTEGER),
        readFileSync: (() => {
          throw new Error("must not read after deadline");
        }) as never,
      }),
    ).toThrow("owned supervisor supervisor_pid receipt timed out");
  });

  test("runtime-root validation preserves its primary error when cleanup also fails", () => {
    const runtime = {
      ...defaultOwnedSupervisorLaunchRuntime(),
      tmpdir: () => "/tmp",
      mkdirSync: (() => undefined) as never,
      lstatSync: (() => ({ isDirectory: () => false, isSymbolicLink: () => false })) as never,
      rmSync: (() => {
        throw new Error("injected cleanup failure");
      }) as never,
    };
    expect(() => createOwnedRuntimeRoot(runtime, "00000000-0000-4000-8000-0000000000bb")).toThrow(
      "owned runtime root is not a private directory",
    );
  });

  test("supervisor spawn failure cleans the private runtime root", () => {
    let cleaned = 0;
    expect(() =>
      spawnOwnedSupervisorChild({
        argv: ["codex"],
        bindAckPath: "bind.json",
        cleanupRuntimeRoot: () => {
          cleaned++;
        },
        options: { detached: false, env: {}, stdinText: "prompt" },
        receiptPath: "receipt.json",
        runtime: {
          ...defaultOwnedSupervisorLaunchRuntime(),
          spawn: (() => {
            throw new Error("injected spawn failure");
          }) as never,
        },
        script: "",
        statusPath: "status.json",
      }),
    ).toThrow("injected spawn failure");
    expect(cleaned).toBe(1);
  });

  test("non-Error stdin failure and ignorable close races still fail the owned launch", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-final-owned-launch-"));
    const stdin = new EventEmitter() as EventEmitter & {
      write(text: string): void;
      end(): void;
    };
    stdin.write = () => {
      stdin.emit("error", "opaque stdin failure");
    };
    stdin.end = () => {
      throw Object.assign(new Error("pipe closed"), { code: "EPIPE" });
    };
    const child = Object.assign(new EventEmitter(), {
      pid: 900,
      stdin,
      stdout: undefined,
      stderr: undefined,
      kill: () => undefined,
    });
    let receipts = 0;
    let launchFailure = "";
    try {
      expect(() =>
        launchOwnedSupervisorProcess(
          ["codex"],
          {
            detached: false,
            env: {},
            stdinText: "prompt",
            ownedRuntime: {
              bindSupervisor: () => undefined,
              bindLaunch: () => undefined,
              failLaunch: (_supervisor: number, _cli: number, reason: string) => {
                launchFailure = reason;
              },
            } as never,
          },
          {
            ...defaultOwnedSupervisorLaunchRuntime(),
            randomUUID: () => "00000000-0000-4000-8000-0000000000cc",
            tmpdir: () => root,
            spawn: (() => child) as never,
            readFileSync: (() =>
              JSON.stringify(
                receipts++ === 0 ? { supervisor_pid: 900 } : { cli_pid: 901 },
              )) as never,
          },
        ),
      ).toThrow("opaque stdin failure");
      expect(launchFailure).toBe("opaque stdin failure");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("watcher reports drain uncertainty after supervisor exit and propagates exit rejection", async () => {
    let now = 0;
    const drained = await watchOwnedSupervisorExit("status.json", Promise.resolve(0), {
      delay: async (ms) => {
        now += ms;
        await Promise.resolve();
      },
      now: () => now,
      readFileSync: (() => JSON.stringify({ phase: "cli-exited", exit_code: 0 })) as never,
    });
    expect(drained).toEqual({
      phase: OWNED_SUPERVISOR_TERMINAL_PHASE.STREAMS_DRAIN_UNPROVEN,
      exitCode: OWNED_PROCESS_EXIT_CODE.OUTPUT_DRAIN_UNPROVEN,
    });

    const rejection = new Error("supervisor observation rejected");
    await expect(
      watchOwnedSupervisorExit("missing.json", Promise.reject(rejection), {
        delay: async () => {
          await Promise.resolve();
        },
        now: () => 0,
        readFileSync: (() => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }) as never,
      }),
    ).rejects.toBe(rejection);
  });

  test.if(process.platform !== "win32")(
    "successful CLI exit remains nonzero when process quiescence cannot be proved",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "vf-final-owned-unproven-"));
      const native = createOwnedProcessPlatform();
      try {
        const result = await makeAsyncSpawner({
          evidenceRoot: root,
          graceMs: 0,
          ownedProcessPlatform: { ...native, proveQuiescent: () => false },
          timeoutMs: 5_000,
        })(process.execPath, ["-e", "process.exit(0)"], "", {
          attemptId: "release-unproven",
          engine: "codex",
          evidenceRoot: root,
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("owned CLI release is unproven");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test("record store lists only open process records", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-final-owned-open-records-"));
    const platform = fakePlatform(new Map([[process.pid, present(process.pid, "owner")]]), {
      observe: (pid) => (pid === process.pid ? observation(pid, "owner") : null),
      proveQuiescent: () => true,
    });
    try {
      const store = new OwnedProcessRecordStore(root);
      store.reserve("open-record", "codex", platform);
      const current = store.reserve("closed-record", "codex", platform);
      const { record_digest: _digest, ...preimage } = current;
      const closed = buildOwnedProcessRecord({
        ...preimage,
        state: OWNED_PROCESS_STATE.RELEASED,
        process_quiescent: true,
        prior_record_digest: current.record_digest,
        release_reason: "fixture release",
        exit_code: 0,
        updated_at: new Date().toISOString(),
      });
      store.write("closed-record", current, closed);
      expect(store.listOpenRecords().map((item) => item.attempt_id)).toEqual(["open-record"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
