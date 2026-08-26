import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAsyncSpawner } from "../src/dispatch.js";
import {
  OWNED_PROCESS_EXIT_CODE,
  OWNED_PROCESS_STATE,
  OWNED_PROCESS_TIMING_MS,
} from "../src/dispatch/owned-process-contract.js";
import { inspectOwnedAttemptProcesses } from "../src/dispatch/owned-process-health.js";
import {
  OwnedProcessController,
  OwnedProcessRecordStore,
  buildOwnedProcessRecord,
} from "../src/dispatch/owned-process-runtime.js";
import {
  OWNED_SUPERVISOR_TERMINAL_PHASE,
  watchOwnedSupervisorExit,
} from "../src/dispatch/owned-process-status.js";
import { noteOwnedOutputDrainFailure } from "../src/dispatch/session-owned-runtime.js";

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("owned CLI output and orphan recovery", () => {
  test("root watcher waits for the streams-drained phase after CLI exit", async () => {
    let now = 0;
    let phase = "cli-exited";
    const supervisorExit = new Promise<number | null>(() => undefined);
    const outcome = await watchOwnedSupervisorExit("status.json", supervisorExit, {
      delay: async (ms) => {
        now += ms;
        if (now >= 50) phase = "streams-drained";
      },
      now: () => now,
      readFileSync: (() => JSON.stringify({ phase, exit_code: 0 })) as never,
    });

    expect(outcome).toEqual({
      phase: OWNED_SUPERVISOR_TERMINAL_PHASE.STREAMS_DRAINED,
      exitCode: 0,
    });
    expect(now).toBe(50);
  });

  test("root watcher returns a typed failure when stream drain proof never arrives", async () => {
    let now = 0;
    const outcome = await watchOwnedSupervisorExit(
      "status.json",
      new Promise<number | null>(() => undefined),
      {
        delay: async (ms) => {
          now += ms;
        },
        now: () => now,
        readFileSync: (() => JSON.stringify({ phase: "cli-exited", exit_code: 0 })) as never,
      },
    );

    expect(outcome).toEqual({
      phase: OWNED_SUPERVISOR_TERMINAL_PHASE.STREAMS_DRAIN_UNPROVEN,
      exitCode: OWNED_PROCESS_EXIT_CODE.OUTPUT_DRAIN_UNPROVEN,
    });
    expect(noteOwnedOutputDrainFailure(outcome, undefined)).toBe(
      "owned CLI output drain proof failed",
    );
    expect(now).toBe(OWNED_PROCESS_TIMING_MS.OUTPUT_DRAIN_PROOF_TIMEOUT);
  });

  test("exit code 125 is not a drain failure when the typed phase proves another outcome", async () => {
    const cases = [
      {
        statusPhase: "streams-drained",
        outcomePhase: OWNED_SUPERVISOR_TERMINAL_PHASE.STREAMS_DRAINED,
      },
      {
        statusPhase: "supervisor-failed",
        outcomePhase: OWNED_SUPERVISOR_TERMINAL_PHASE.SUPERVISOR_FAILED,
      },
    ] as const;

    for (const fixture of cases) {
      const outcome = await watchOwnedSupervisorExit(
        "status.json",
        new Promise<number | null>(() => undefined),
        {
          delay: async () => undefined,
          now: () => 0,
          readFileSync: (() =>
            JSON.stringify({
              phase: fixture.statusPhase,
              exit_code: OWNED_PROCESS_EXIT_CODE.OUTPUT_DRAIN_UNPROVEN,
            })) as never,
        },
      );

      expect(outcome).toEqual({
        phase: fixture.outcomePhase,
        exitCode: OWNED_PROCESS_EXIT_CODE.OUTPUT_DRAIN_UNPROVEN,
      });
      expect(noteOwnedOutputDrainFailure(outcome, undefined)).toBeUndefined();
    }
  });

  test("watcher returns a bounded unproven outcome when the supervisor exits without status", async () => {
    let now = 0;
    const outcome = await watchOwnedSupervisorExit("missing-status.json", Promise.resolve(0), {
      delay: async (ms) => {
        now += ms;
      },
      now: () => now,
      readFileSync: (() => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }) as never,
    });

    expect(outcome).toEqual({
      phase: OWNED_SUPERVISOR_TERMINAL_PHASE.SUPERVISOR_EXITED_UNPROVEN,
      exitCode: 1,
    });
    expect(now).toBeLessThanOrEqual(OWNED_PROCESS_TIMING_MS.SUPERVISOR_STATUS_POLL);
  });

  test.if(process.platform !== "win32")(
    "drains a large final stdout burst before reaping the supervisor",
    async () => {
      const root = tempRoot("vf-owned-output-");
      try {
        const outputBytes = 8 * 1024 * 1024;
        const result = await makeAsyncSpawner({
          evidenceRoot: root,
          timeoutMs: 15_000,
        })(
          process.execPath,
          ["-e", `process.stdout.write("x".repeat(${outputBytes}), () => process.exit(0));`],
          "",
          { attemptId: "owned-large-output", engine: "codex", evidenceRoot: root },
        );
        const record = new OwnedProcessRecordStore(root).read("owned-large-output");
        expect(result.status).toBe(0);
        expect(Buffer.byteLength(result.stdout)).toBe(outputBytes);
        expect(record?.state).toBe("released");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test.if(process.platform !== "win32")(
    "preserves a real CLI exit 125 without labeling it as a drain failure",
    async () => {
      const root = tempRoot("vf-owned-real-exit-125-");
      try {
        const result = await makeAsyncSpawner({ evidenceRoot: root, timeoutMs: 5_000 })(
          process.execPath,
          ["-e", `process.exit(${OWNED_PROCESS_EXIT_CODE.OUTPUT_DRAIN_UNPROVEN});`],
          "",
          { attemptId: "owned-real-exit-125", engine: "codex", evidenceRoot: root },
        );

        expect(result.status).toBe(OWNED_PROCESS_EXIT_CODE.OUTPUT_DRAIN_UNPROVEN);
        expect(result.stderr).not.toContain("output drain proof failed");
        expect(
          new OwnedProcessRecordStore(root).read("owned-real-exit-125")?.terminal_kind,
        ).toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test("doctor fix reaps an exact orphan even when its record is already uncertain", () => {
    const root = tempRoot("vf-owned-uncertain-reap-");
    let ownerAlive = true;
    let treeAlive = true;
    let terminated = 0;
    try {
      const platform = {
        strategy: "posix-session" as const,
        platform: process.platform,
        observe: (pid: number) => {
          if (pid === process.pid && ownerAlive)
            return { pid, identity: "owner", pgid: process.pid, sid: null };
          if (pid === 700 && treeAlive)
            return { pid, identity: "supervisor", pgid: 700, sid: null };
          if (pid === 701 && treeAlive) return { pid, identity: "cli", pgid: 700, sid: null };
          return null;
        },
        terminateExactTree: () => {
          terminated++;
          treeAlive = false;
        },
        proveQuiescent: () => !treeAlive,
      };
      const store = new OwnedProcessRecordStore(root);
      const controller = new OwnedProcessController(
        store,
        platform,
        store.reserve("owned-uncertain-orphan", "codex", platform),
      );
      controller.bindLaunch(700, 701);
      const running = store.read("owned-uncertain-orphan");
      if (!running) throw new Error("missing owned process fixture");
      const { record_digest: _digest, ...preimage } = running;
      const uncertain = buildOwnedProcessRecord({
        ...preimage,
        state: OWNED_PROCESS_STATE.UNCERTAIN,
        release_reason: "injected uncertainty",
        updated_at: new Date().toISOString(),
      });
      store.write(uncertain.attempt_id, running, uncertain);
      ownerAlive = false;

      const report = inspectOwnedAttemptProcesses(store, platform, true);

      expect(terminated).toBe(1);
      expect(report.uncertain).toHaveLength(0);
      expect(report.recovered.map((record) => record.attempt_id)).toEqual([
        "owned-uncertain-orphan",
      ]);
      expect(store.read("owned-uncertain-orphan")?.state).toBe("released");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("doctor fix uses the exact CLI fallback when the recorded supervisor is absent", () => {
    for (const state of [OWNED_PROCESS_STATE.RUNNING, OWNED_PROCESS_STATE.UNCERTAIN] as const) {
      const root = tempRoot(`vf-owned-cli-fallback-${state}-`);
      let ownerAlive = true;
      let supervisorAlive = true;
      let cliAlive = true;
      const fallbackForces: boolean[] = [];
      try {
        const platform = {
          strategy: "posix-session" as const,
          platform: process.platform,
          observe: (pid: number) => {
            if (pid === process.pid && ownerAlive)
              return { pid, identity: "owner", pgid: process.pid, sid: null };
            if (pid === 700 && supervisorAlive)
              return { pid, identity: "supervisor", pgid: 700, sid: null };
            if (pid === 701 && cliAlive) return { pid, identity: "cli", pgid: 700, sid: null };
            return null;
          },
          terminateExactTree: () => {
            throw new Error("absent supervisor must not be terminated");
          },
          terminateExactCliFallback: (
            _record: unknown,
            cli: { pid: number; identity: string },
            force: boolean,
          ) => {
            expect(cli).toMatchObject({ pid: 701, identity: "cli" });
            fallbackForces.push(force);
            cliAlive = false;
          },
          proveQuiescent: () => !supervisorAlive && !cliAlive,
        };
        const store = new OwnedProcessRecordStore(root);
        const controller = new OwnedProcessController(
          store,
          platform,
          store.reserve(`owned-cli-fallback-${state}`, "codex", platform),
        );
        controller.bindLaunch(700, 701);
        if (state === OWNED_PROCESS_STATE.UNCERTAIN) {
          const running = store.read(`owned-cli-fallback-${state}`);
          if (!running) throw new Error("missing owned process fixture");
          const { record_digest: _digest, ...preimage } = running;
          const uncertain = buildOwnedProcessRecord({
            ...preimage,
            state,
            release_reason: "injected uncertainty",
            updated_at: new Date().toISOString(),
          });
          store.write(uncertain.attempt_id, running, uncertain);
        }
        ownerAlive = false;
        supervisorAlive = false;

        const report = inspectOwnedAttemptProcesses(store, platform, true);

        expect(fallbackForces).toEqual([false]);
        expect(report.uncertain).toHaveLength(0);
        expect(report.recovered.map((record) => record.attempt_id)).toEqual([
          `owned-cli-fallback-${state}`,
        ]);
        expect(store.read(`owned-cli-fallback-${state}`)?.state).toBe(OWNED_PROCESS_STATE.RELEASED);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("launch failure uses the exact CLI fallback when the supervisor disappeared", () => {
    const root = tempRoot("vf-owned-failed-launch-cli-fallback-");
    let cliAlive = true;
    const fallbackForces: boolean[] = [];
    try {
      const platform = {
        strategy: "posix-session" as const,
        platform: process.platform,
        observe: (pid: number) => {
          if (pid === process.pid) return { pid, identity: "owner", pgid: process.pid, sid: null };
          if (pid === 701 && cliAlive) return { pid, identity: "cli", pgid: 700, sid: null };
          return null;
        },
        terminateExactTree: () => {
          throw new Error("absent supervisor must not be terminated");
        },
        terminateExactCliFallback: (
          _record: unknown,
          cli: { pid: number; identity: string },
          force: boolean,
        ) => {
          expect(cli).toMatchObject({ pid: 701, identity: "cli" });
          fallbackForces.push(force);
          cliAlive = false;
        },
        proveQuiescent: () => !cliAlive,
      };
      const store = new OwnedProcessRecordStore(root);
      const controller = new OwnedProcessController(
        store,
        platform,
        store.reserve("owned-failed-launch-cli-fallback", "codex", platform),
      );

      controller.failLaunch(700, 701, "injected launch failure");

      expect(fallbackForces).toEqual([false]);
      expect(cliAlive).toBe(false);
      expect(store.read("owned-failed-launch-cli-fallback")).toMatchObject({
        state: OWNED_PROCESS_STATE.UNCERTAIN,
        supervisor_pid: 700,
        cli_pid: 701,
        cli_identity: "cli",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
