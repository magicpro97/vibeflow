import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AGENT_ENGINE } from "../src/core/agent-contract.js";
import {
  OWNED_PROCESS_PRESENCE_KIND,
  OWNED_PROCESS_PROOF_STRENGTH,
  OWNED_PROCESS_QUIESCENCE_SCOPE,
  OWNED_PROCESS_STATE,
  OWNED_PROCESS_STRATEGY,
} from "../src/dispatch/owned-process-contract.js";
import { inspectOwnedAttemptProcesses } from "../src/dispatch/owned-process-health.js";
import { launchOwnedSupervisorProcess } from "../src/dispatch/owned-process-launch.js";
import {
  createOwnedProcessPlatform,
  probeProcess,
} from "../src/dispatch/owned-process-platform.js";
import {
  OwnedProcessController,
  OwnedProcessRecordStore,
  verifyOwnedProcessReleaseProof,
} from "../src/dispatch/owned-process-runtime.js";
import { OWNED_SUPERVISOR_TERMINAL_PHASE } from "../src/dispatch/owned-process-status.js";
import { RUNTIME_PLATFORM } from "../src/durability/process-identity-contract.js";

const LIVE_WINDOWS_ENV = "VF_REQUIRE_LIVE_WINDOWS";
const LIVE_WINDOWS_TIMEOUT_MS = 30_000;
const repoRoot = dirname(dirname(fileURLToPath(new URL(import.meta.url))));
const liveWindowsTest = process.platform === RUNTIME_PLATFORM.WINDOWS ? test : test.skip;

if (process.env[LIVE_WINDOWS_ENV] === "1" && process.platform !== RUNTIME_PLATFORM.WINDOWS) {
  throw new Error(`${LIVE_WINDOWS_ENV}=1 requires a real win32 runtime`);
}

function timeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), LIVE_WINDOWS_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function drain(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  return stream ? new Response(stream).text() : Promise.resolve("");
}

function cleanupOwnedTree(root: string, attemptId: string): void {
  try {
    const platform = createOwnedProcessPlatform();
    const record = new OwnedProcessRecordStore(root).read(attemptId);
    const supervisor = record?.supervisor_pid ? platform.observe(record.supervisor_pid) : null;
    if (supervisor) platform.terminateExactTree(supervisor, true);
  } catch {
    // The assertion failure remains primary; CI still checks the process is absent below.
  }
}

describe("live Windows owned CLI process lifecycle", () => {
  liveWindowsTest(
    "stores real supervisor/CLI PIDs and releases the Job Object tree",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "vf-owned-win-live-"));
      const attemptId = "windows-live-release";
      try {
        const platform = createOwnedProcessPlatform();
        expect(platform).toMatchObject({
          platform: RUNTIME_PLATFORM.WINDOWS,
          strategy: OWNED_PROCESS_STRATEGY.WINDOWS_TREE,
          quiescenceScope: OWNED_PROCESS_QUIESCENCE_SCOPE.WINDOWS_JOB,
          proofStrength: OWNED_PROCESS_PROOF_STRENGTH.KERNEL_CONTAINED,
        });
        const store = new OwnedProcessRecordStore(root);
        const controller = new OwnedProcessController(
          store,
          platform,
          store.reserve(attemptId, AGENT_ENGINE.CODEX, platform),
        );
        const handle = launchOwnedSupervisorProcess(
          [process.execPath, "-e", 'process.stdout.write("owned-live-ok\\n")'],
          {
            detached: false,
            env: { PATH: process.env.PATH ?? "" },
            stdinText: "",
            ownedRuntime: controller,
          },
        );
        const stdout = drain(handle.stdout);
        const stderr = drain(handle.stderr);
        const running = store.read(attemptId);
        expect(running).toMatchObject({
          state: OWNED_PROCESS_STATE.RUNNING,
          supervisor_pid: handle.pid,
          platform: RUNTIME_PLATFORM.WINDOWS,
        });
        expect(running?.cli_pid).toBeGreaterThan(0);
        expect(running?.cli_pid).not.toBe(handle.pid);

        const outcome = await timeout(
          handle.rootExited ?? Promise.reject(new Error("missing owned root outcome")),
          "owned supervisor root outcome",
        );
        expect(outcome).toEqual({
          phase: OWNED_SUPERVISOR_TERMINAL_PHASE.STREAMS_DRAINED,
          exitCode: 0,
        });
        await timeout(controller.terminate(1_000), "owned tree termination");
        await timeout(
          handle.exited.then(() => undefined),
          "owned supervisor exit",
        );
        expect(await timeout(stdout, "owned stdout drain")).toBe("owned-live-ok\n");
        expect(await timeout(stderr, "owned stderr drain")).toBe("");

        const proof = controller.finalize(outcome.exitCode, "live Windows terminal release");
        const released = store.read(attemptId);
        expect(proof).not.toBeNull();
        expect(released).toMatchObject({
          state: OWNED_PROCESS_STATE.RELEASED,
          process_quiescent: true,
          exit_code: 0,
        });
        expect(proof && released ? verifyOwnedProcessReleaseProof(proof, released) : false).toBe(
          true,
        );
        if (!running?.supervisor_pid || !running.cli_pid)
          throw new Error("missing live PID record");
        expect(probeProcess(platform, running.supervisor_pid).kind).toBe(
          OWNED_PROCESS_PRESENCE_KIND.ABSENT,
        );
        expect(probeProcess(platform, running.cli_pid).kind).toBe(
          OWNED_PROCESS_PRESENCE_KIND.ABSENT,
        );
      } finally {
        cleanupOwnedTree(root, attemptId);
        rmSync(root, { recursive: true, force: true });
      }
    },
    LIVE_WINDOWS_TIMEOUT_MS,
  );

  liveWindowsTest(
    "detects and reaps a real orphan after its owner process exits",
    () => {
      const root = mkdtempSync(join(tmpdir(), "vf-owned-win-orphan-"));
      const attemptId = "windows-live-orphan";
      try {
        const urls = {
          agent: pathToFileURL(join(repoRoot, "src/core/agent-contract.ts")).href,
          launch: pathToFileURL(join(repoRoot, "src/dispatch/owned-process-launch.ts")).href,
          platform: pathToFileURL(join(repoRoot, "src/dispatch/owned-process-platform.ts")).href,
          runtime: pathToFileURL(join(repoRoot, "src/dispatch/owned-process-runtime.ts")).href,
        };
        const helper = `
          const { AGENT_ENGINE } = await import(${JSON.stringify(urls.agent)});
          const { launchOwnedSupervisorProcess } = await import(${JSON.stringify(urls.launch)});
          const { createOwnedProcessPlatform } = await import(${JSON.stringify(urls.platform)});
          const { OwnedProcessController, OwnedProcessRecordStore } = await import(${JSON.stringify(urls.runtime)});
          const platform = createOwnedProcessPlatform();
          const store = new OwnedProcessRecordStore(${JSON.stringify(root)});
          const controller = new OwnedProcessController(store, platform, store.reserve(${JSON.stringify(attemptId)}, AGENT_ENGINE.CODEX, platform));
          launchOwnedSupervisorProcess([process.execPath, "-e", "setInterval(() => {}, 1000)"], { detached: false, env: { PATH: process.env.PATH || "" }, stdinText: "", ownedRuntime: controller });
          const record = store.read(${JSON.stringify(attemptId)});
          process.stdout.write(JSON.stringify({ owner_pid: record.owner_pid, supervisor_pid: record.supervisor_pid, cli_pid: record.cli_pid }));
          process.exit(0);
        `;
        const helperResult = spawnSync(process.execPath, ["-e", helper], {
          cwd: repoRoot,
          encoding: "utf8",
          env: process.env,
          timeout: LIVE_WINDOWS_TIMEOUT_MS,
          windowsHide: true,
        });
        expect(helperResult.status).toBe(0);
        expect(helperResult.stderr).toBe("");
        const launched = JSON.parse(helperResult.stdout) as {
          owner_pid: number;
          supervisor_pid: number;
          cli_pid: number;
        };
        expect(launched.owner_pid).toBeGreaterThan(0);
        expect(launched.supervisor_pid).toBeGreaterThan(0);
        expect(launched.cli_pid).toBeGreaterThan(0);

        const platform = createOwnedProcessPlatform();
        const store = new OwnedProcessRecordStore(root);
        expect(probeProcess(platform, launched.owner_pid).kind).toBe(
          OWNED_PROCESS_PRESENCE_KIND.ABSENT,
        );
        const audit = inspectOwnedAttemptProcesses(store, platform, false);
        expect(audit.active).toEqual([]);
        expect(audit.uncertain).toEqual([
          expect.objectContaining({ attempt_id: attemptId, reason: "proved orphan" }),
        ]);

        const repaired = inspectOwnedAttemptProcesses(store, platform, true);
        expect(repaired.uncertain).toEqual([]);
        expect(repaired.recovered).toEqual([
          expect.objectContaining({ attempt_id: attemptId, state: OWNED_PROCESS_STATE.RELEASED }),
        ]);
        expect(probeProcess(platform, launched.supervisor_pid).kind).toBe(
          OWNED_PROCESS_PRESENCE_KIND.ABSENT,
        );
        expect(probeProcess(platform, launched.cli_pid).kind).toBe(
          OWNED_PROCESS_PRESENCE_KIND.ABSENT,
        );
      } finally {
        cleanupOwnedTree(root, attemptId);
        rmSync(root, { recursive: true, force: true });
      }
    },
    LIVE_WINDOWS_TIMEOUT_MS,
  );
});
