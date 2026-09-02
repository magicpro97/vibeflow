import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AGENT_ENGINE } from "../src/core/agent-contract.js";
import { conversationEnvPolicy } from "../src/dispatch/env-filter.js";
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
import { trustedWindowsSystemRoot } from "../src/dispatch/owned-process-record-windows-native.js";
import {
  createWindowsRecordRuntime,
  ensureWindowsRecordDirectory,
  windowsDirectoryIdentity,
} from "../src/dispatch/owned-process-record-windows-storage.js";
import {
  OwnedProcessController,
  OwnedProcessRecordStore,
  verifyOwnedProcessReleaseProof,
} from "../src/dispatch/owned-process-runtime.js";
import { OWNED_SUPERVISOR_TERMINAL_PHASE } from "../src/dispatch/owned-process-status.js";
import {
  ENGINE_ATTEMPT_START_OUTCOME,
  ENGINE_SESSION_MODE,
} from "../src/dispatch/session-contract.js";
import { createSpawnOptionsProjection } from "../src/dispatch/session-types.js";
import { createEngineSessionAdapter } from "../src/dispatch/session.js";
import { WINDOWS_FILE_NATIVE } from "../src/dispatch/windows-native-contract.js";
import { loadWindowsPathNativeBindings } from "../src/dispatch/windows-path-native-bindings.js";
import { RUNTIME_PLATFORM } from "../src/durability/process-identity-contract.js";
import { CONVERSATION_OPERATION_STATE } from "../src/orchestrator/conversation/conversation-public-wire-contract.js";

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
  liveWindowsTest("pins the records directory and every ancestor for the full lease", () => {
    const parent = mkdtempSync(join(tmpdir(), "vf-authority-lease-win-live-"));
    const authorityPath = join(parent, "authority");
    const recordsPath = join(authorityPath, "records");
    const movedAuthority = `${authorityPath}-moved`;
    const movedRecords = `${recordsPath}-moved`;
    try {
      const runtime = createWindowsRecordRuntime({});
      ensureWindowsRecordDirectory(recordsPath, runtime);
      const identity = windowsDirectoryIdentity(recordsPath, runtime);
      runtime.pathAuthority.withVerifiedDirectory(recordsPath, identity.value, () => {
        // Capture pin-block evidence into the assertion failure message so bun
        // prints the actual rename errors instead of a bare toThrow failure.
        const attempted: string[] = [];
        const attempt = (label: string, probe: () => void) => {
          try {
            probe();
            attempted.push(`${label}:NO_THROW`);
          } catch (error) {
            attempted.push(`${label}:${String(error)}`);
          }
        };
        // Decisive probe: while the chain holds its pin handles, try opening
        // each directory WITH delete access. A live pin (share without
        // FILE_SHARE_DELETE) makes this fail with ERROR_SHARING_VIOLATION.
        const natal = loadWindowsPathNativeBindings();
        const wide = (path: string) => Buffer.from(`\\\\?\\${path}\0`, "utf16le");
        for (const [label, path] of [
          ["DELETE-records", recordsPath],
          ["DELETE-authority", authorityPath],
        ] as const) {
          const handle = natal.createFile(
            wide(path),
            WINDOWS_FILE_NATIVE.DELETE_ACCESS >>> 0,
            WINDOWS_FILE_NATIVE.FILE_SHARE_DELETE |
              WINDOWS_FILE_NATIVE.FILE_SHARE_READ |
              WINDOWS_FILE_NATIVE.FILE_SHARE_WRITE,
            null,
            WINDOWS_FILE_NATIVE.OPEN_EXISTING,
            WINDOWS_FILE_NATIVE.FILE_FLAG_BACKUP_SEMANTICS,
            null,
          );
          if (handle === natal.invalidHandle) {
            attempted.push(`${label}:CLOSED(${natal.lastError()})`);
          } else {
            attempted.push(`${label}:OPENED`);
            natal.closeHandle(handle);
          }
        }
        attempt("authorityPath", () => renameSync(authorityPath, movedAuthority));
        attempt("recordsPath-after", () => renameSync(recordsPath, movedRecords));
        // Undo any rename that succeeded so the drive stays in the pre-lease
        // layout for the outer rename-back assertions.
        const renameResults = attempted.slice(-2);
        if (renameResults[0]?.endsWith(":NO_THROW"))
          expect(renameSync(movedAuthority, authorityPath)).toBe(undefined);
        if (renameResults[1]?.endsWith(":NO_THROW"))
          expect(renameSync(movedRecords, recordsPath)).toBe(undefined);
        expect(
          attempted.every((entry) => !entry.endsWith(":NO_THROW")),
          `pin evidence: ${attempted.join(" | ")}`,
        ).toBeTrue();
      });
      renameSync(recordsPath, movedRecords);
      renameSync(movedRecords, recordsPath);
      renameSync(authorityPath, movedAuthority);
      renameSync(movedAuthority, authorityPath);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  liveWindowsTest("rejects a permissive pre-existing authority root", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-permissive-win-live-"));
    try {
      const acl = spawnSync(
        join(trustedWindowsSystemRoot(), "System32", "icacls.exe"),
        [root, "/grant", "*S-1-1-0:(OI)(CI)F"],
        { encoding: "utf8", timeout: LIVE_WINDOWS_TIMEOUT_MS, windowsHide: true },
      );
      expect(acl.status).toBe(0);
      expect(() => createEngineSessionAdapter({ evidenceRoot: root })).toThrow(
        "permissive Windows authority DACL rejected",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  liveWindowsTest(
    "persists canonical adapter PIDs, terminal release, and start authority",
    async () => {
      const parent = mkdtempSync(join(tmpdir(), "vf-adapter-win-live-"));
      const root = join(parent, "authority");
      const bin = join(parent, "bin");
      const fixtureSource = join(bin, "codex-fixture.ts");
      const fixtureExecutable = join(bin, "codex.exe");
      const argvEvidence = join(parent, "fixture-argv.json");
      const attemptId = "windows-live-adapter";
      try {
        mkdirSync(bin, { recursive: true });
        writeFileSync(
          fixtureSource,
          `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(argvEvidence)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "019f278f-d7ff-77d3-9c44-7459bbf08d19" }) + "\\n");
`,
        );
        const compiled = await Bun.build({
          entrypoints: [fixtureSource],
          compile: { outfile: fixtureExecutable },
        });
        expect(compiled.success).toBe(true);
        const adapter = createEngineSessionAdapter({
          evidenceRoot: root,
          graceMs: 1_000,
          sourceEnv: { PATH: `${bin};${process.env.PATH ?? ""}` },
        });
        const spawn = createSpawnOptionsProjection({
          engine: AGENT_ENGINE.CODEX,
          model: null,
          sessionMode: ENGINE_SESSION_MODE.FRESH,
          rendered_prompt: "live Windows adapter",
          rendered_tools: [],
          sandbox: "read-only",
          env_policy: conversationEnvPolicy(AGENT_ENGINE.CODEX),
          isolation: null,
          provenance: { roleSource: "builtin", roleHash: "live", skillHashes: [] },
          trace_metadata: { role_resolved_hash: "live", skill_resolved_hashes: [] },
        });
        const handle = adapter.start({
          attemptId,
          spawn,
          signal: new AbortController().signal,
        });
        const running = new OwnedProcessRecordStore(root).read(attemptId);
        expect(running?.supervisor_pid).toBeGreaterThan(0);
        expect(running?.cli_pid).toBeGreaterThan(0);
        const result = await timeout(handle.completion, "canonical adapter completion");
        expect(result).toMatchObject({
          ok: true,
          state: CONVERSATION_OPERATION_STATE.COMPLETED,
        });
        expect(JSON.parse(readFileSync(argvEvidence, "utf8"))).toEqual([
          "--sandbox",
          "read-only",
          "exec",
          "--json",
          "-",
        ]);
        expect(new OwnedProcessRecordStore(root).read(attemptId)).toMatchObject({
          state: OWNED_PROCESS_STATE.RELEASED,
          process_quiescent: true,
          exit_code: 0,
        });
        expect(adapter.startAuthority?.read(attemptId)).toMatchObject({
          attempt_id: attemptId,
          outcome: ENGINE_ATTEMPT_START_OUTCOME.ACCEPTED,
          process_quiescent: true,
        });
      } finally {
        cleanupOwnedTree(root, attemptId);
        rmSync(parent, { recursive: true, force: true });
      }
    },
    LIVE_WINDOWS_TIMEOUT_MS,
  );

  liveWindowsTest(
    "stores real supervisor/CLI PIDs and releases the Job Object tree",
    async () => {
      const parent = mkdtempSync(join(tmpdir(), "vf-owned-win-live-"));
      const root = join(parent, "authority");
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
        const cliFixture = join(parent, "cli-fixture.ts");
        // File-based (not an inline `bun -e`): bun 1.4.0 on Windows runners
        // can crash in its eval path (see `.github/workflows/ci.yml`).
        writeFileSync(cliFixture, 'process.stdout.write("owned-live-ok\\n");\n', { mode: 0o600 });
        const handle = launchOwnedSupervisorProcess([process.execPath, cliFixture], {
          detached: false,
          env: { PATH: process.env.PATH ?? "" },
          stdinText: "",
          ownedRuntime: controller,
        });
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
        rmSync(parent, { recursive: true, force: true });
      }
    },
    LIVE_WINDOWS_TIMEOUT_MS,
  );

  liveWindowsTest(
    "detects and reaps a real orphan after its owner process exits",
    () => {
      const parent = mkdtempSync(join(tmpdir(), "vf-owned-win-orphan-"));
      const root = join(parent, "authority");
      const attemptId = "windows-live-orphan";
      try {
        const urls = {
          agent: pathToFileURL(join(repoRoot, "src/core/agent-contract.ts")).href,
          launch: pathToFileURL(join(repoRoot, "src/dispatch/owned-process-launch.ts")).href,
          platform: pathToFileURL(join(repoRoot, "src/dispatch/owned-process-platform.ts")).href,
          runtime: pathToFileURL(join(repoRoot, "src/dispatch/owned-process-runtime.ts")).href,
        };
        const cliFixture = join(parent, "cli-fixture.ts");
        // File-based (not an inline `bun -e`): bun 1.4.0 on Windows runners
        // can crash in its eval path (see `.github/workflows/ci.yml`).
        writeFileSync(cliFixture, "setInterval(() => {}, 1000);\n", { mode: 0o600 });
        const helper = `
          const { AGENT_ENGINE } = await import(${JSON.stringify(urls.agent)});
          const { launchOwnedSupervisorProcess } = await import(${JSON.stringify(urls.launch)});
          const { createOwnedProcessPlatform } = await import(${JSON.stringify(urls.platform)});
          const { OwnedProcessController, OwnedProcessRecordStore } = await import(${JSON.stringify(urls.runtime)});
          const platform = createOwnedProcessPlatform();
          const store = new OwnedProcessRecordStore(${JSON.stringify(root)});
          const controller = new OwnedProcessController(store, platform, store.reserve(${JSON.stringify(attemptId)}, AGENT_ENGINE.CODEX, platform));
          launchOwnedSupervisorProcess([process.execPath, ${JSON.stringify(cliFixture)}], { detached: false, env: { PATH: process.env.PATH || "" }, stdinText: "", ownedRuntime: controller });
          const record = store.read(${JSON.stringify(attemptId)});
          process.stdout.write(JSON.stringify({ owner_pid: record.owner_pid, supervisor_pid: record.supervisor_pid, cli_pid: record.cli_pid }));
          process.exit(0);
        `;
        const helperFixture = join(parent, "helper-fixture.ts");
        writeFileSync(helperFixture, helper, { mode: 0o600 });
        const helperResult = spawnSync(process.execPath, [helperFixture], {
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
        expect(probeProcess(platform, launched.supervisor_pid).kind).toBe(
          OWNED_PROCESS_PRESENCE_KIND.PRESENT,
        );
        expect(probeProcess(platform, launched.cli_pid).kind).toBe(
          OWNED_PROCESS_PRESENCE_KIND.PRESENT,
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
        rmSync(parent, { recursive: true, force: true });
      }
    },
    LIVE_WINDOWS_TIMEOUT_MS,
  );
});
