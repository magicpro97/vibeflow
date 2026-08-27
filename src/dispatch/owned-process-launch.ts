import { writeFileSync } from "node:fs";
import { PROCESS_START_IDENTITY_CONTRACT } from "../durability/process-identity-contract.js";
import {
  OWNED_CLI_IDENTITY_STATE,
  OWNED_PROCESS_ENV,
  OWNED_PROCESS_EXIT_CODE,
  OWNED_PROCESS_IGNORABLE_STREAM_ERROR_CODE,
  OWNED_PROCESS_TIMING_MS,
  OWNED_SUPERVISOR_PHASE,
  OWNED_SUPERVISOR_RECEIPT_KEY,
  OWNED_SUPERVISOR_RECEIPT_PHASE,
  OWNED_SUPERVISOR_STATUS_KEY,
  OWNED_WINDOWS_QUERY_STATUS,
} from "./owned-process-contract.js";
import { projectOwnedEngineProcess } from "./owned-process-engine-handle.js";
import {
  ignorableOwnedStdinError,
  waitForOwnedSupervisorReceipt,
} from "./owned-process-launch-receipt.js";
import {
  type OwnedSupervisorLaunchRuntime,
  createOwnedRuntimeArtifacts,
  defaultOwnedSupervisorLaunchRuntime,
} from "./owned-process-launch-runtime.js";
import type { OwnedProcessController } from "./owned-process-runtime.js";
import { OWNED_PROCESS_START_IDENTITY_SCRIPT } from "./owned-process-start-identity-script.js";
import { watchOwnedSupervisorExit } from "./owned-process-status.js";
import { spawnOwnedSupervisorChild } from "./owned-process-supervisor-child.js";
import { OWNED_WINDOWS_JOB_SCRIPT } from "./owned-process-windows-job-script.js";
import type { EngineProcess, EngineProcessSpawnOptions } from "./session-types.js";
export {
  markOwnedRuntimeSpawner,
  supportsOwnedRuntime,
} from "./owned-process-launch-runtime.js";
export const OWNED_SUPERVISOR_SCRIPT = String.raw`
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const PHASE = ${JSON.stringify(OWNED_SUPERVISOR_PHASE)};
const RECEIPT_PHASE = ${JSON.stringify(OWNED_SUPERVISOR_RECEIPT_PHASE)};
const RECEIPT_KEY = ${JSON.stringify(OWNED_SUPERVISOR_RECEIPT_KEY)};
const STATUS_KEY = ${JSON.stringify(OWNED_SUPERVISOR_STATUS_KEY)};
const IDENTITY_STATE = ${JSON.stringify(OWNED_CLI_IDENTITY_STATE)};
const IDENTITY = ${JSON.stringify(PROCESS_START_IDENTITY_CONTRACT)};
const ENV = ${JSON.stringify(OWNED_PROCESS_ENV)};
const EXIT_CODE = ${JSON.stringify(OWNED_PROCESS_EXIT_CODE)};
const IGNORABLE_STREAM_ERROR_CODE = ${JSON.stringify(OWNED_PROCESS_IGNORABLE_STREAM_ERROR_CODE)};
const TIMING_MS = ${JSON.stringify(OWNED_PROCESS_TIMING_MS)};
const WINDOWS_QUERY_STATUS = ${JSON.stringify(OWNED_WINDOWS_QUERY_STATUS)};
${OWNED_WINDOWS_JOB_SCRIPT}
const argv = JSON.parse(Buffer.from(process.env[ENV.ARGV_BASE64] || "", "base64").toString("utf8"));
const bindAck = process.env[ENV.BIND_ACK];
const receipt = process.env[ENV.RECEIPT];
const status = process.env[ENV.STATUS];
const write = (path, value) => {
  const temp = path + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value) + "\n", { mode: 0o600 });
  fs.renameSync(temp, path);
};
let cliStarted = false;
let failed = false;
let parentReapHold = null;
const holdForParentReap = () => {
  if (parentReapHold) return;
  parentReapHold = setInterval(() => {}, TIMING_MS.PARENT_REAP_HOLD_TICK);
  setTimeout(() => {
    const exitCode = Number.isInteger(process.exitCode) && process.exitCode !== 0
      ? process.exitCode
      : EXIT_CODE.SUPERVISOR_UNPROVEN;
    process.exit(exitCode);
  }, TIMING_MS.OUTPUT_DRAIN_PROOF_TIMEOUT);
};
const writeTerminalStatus = (phase, exitCode) => {
  try {
    write(status, { [STATUS_KEY.PHASE]: phase, [STATUS_KEY.EXIT_CODE]: exitCode });
    return true;
  } catch (statusError) {
    process.stderr.write("owned supervisor status write failed: " + String(statusError) + "\n");
    process.exit(exitCode === 0 ? EXIT_CODE.SUPERVISOR_UNPROVEN : exitCode);
    return false;
  }
};
const fail = (error, code = EXIT_CODE.SUPERVISOR_FAILED) => {
  if (failed) return;
  failed = true;
  process.stderr.write(String((error && error.stack) || error) + "\n");
  if (cliStarted) {
    process.exitCode = code;
    if (!writeTerminalStatus(PHASE.FAILED, code)) return;
    holdForParentReap();
    return;
  }
  process.exit(code);
};
const ignorablePipeError = (error) => {
  const code = error && error.code;
  return code === IGNORABLE_STREAM_ERROR_CODE.BROKEN_PIPE || code === IGNORABLE_STREAM_ERROR_CODE.STREAM_DESTROYED;
};
const processAbsent = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return Boolean(error && error.code === "ESRCH");
  }
};
const windowsSystemRoot = () => {
  const root = windowsJob && windowsJob.systemRoot;
  if (!/^[A-Za-z]:\\[^\0]+$/.test(root)) throw new Error("invalid Windows system root");
  return root.replace(/\\+$/, "");
};
const windowsPowerShell = () =>
  windowsSystemRoot() + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
${OWNED_PROCESS_START_IDENTITY_SCRIPT}
const processGroupId = (pid) => {
  if (process.platform === IDENTITY.KIND.WINDOWS) return null;
  try {
    const pgid = execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: TIMING_MS.PLATFORM_PROBE_TIMEOUT,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[1-9]\\d*$/.test(pgid) ? Number(pgid) : null;
  } catch {
    return null;
  }
};
const windowsJob = initializeWindowsJob();
write(receipt, { [RECEIPT_KEY.SUPERVISOR_PID]: process.pid, [RECEIPT_KEY.CONTAINMENT]: windowsJob ? QUIESCENCE_SCOPE.WINDOWS_JOB : QUIESCENCE_SCOPE.POSIX_PROCESS_GROUP });
const waitForBindAck = () =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + TIMING_MS.SUPERVISOR_BOOT;
    const read = () => {
      try {
        const parsed = JSON.parse(fs.readFileSync(bindAck, "utf8"));
        if (!parsed || parsed[RECEIPT_KEY.PHASE] !== RECEIPT_PHASE.BIND_ACK) throw new Error("owned supervisor bind ack invalid");
        resolve();
        return;
      } catch (error) {
        if (error && error.code !== "ENOENT" && !String(error.message || error).includes("Unexpected end of JSON input")) {
          reject(error);
          return;
        }
      }
      if (Date.now() >= deadline) {
        reject(new Error("owned supervisor bind ack timed out"));
        return;
      }
      setTimeout(read, TIMING_MS.BIND_ACK_POLL);
    };
    read();
  });
waitForBindAck()
  .then(() => {
    const childEnv = { ...process.env };
    for (const key of Object.values(ENV)) delete childEnv[key];
    const child = spawn(argv[0], argv.slice(1), {
      cwd: process.env[ENV.CWD] || process.cwd(),
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    cliStarted = true;
    const supervisorPgid = processGroupId(process.pid);
    const cliIdentity = startIdentity(child.pid);
    write(receipt, { [RECEIPT_KEY.CLI_PID]: child.pid, [RECEIPT_KEY.CLI_IDENTITY]: cliIdentity.identity, [RECEIPT_KEY.CLI_IDENTITY_STATE]: cliIdentity.state, [RECEIPT_KEY.CLI_PGID]: processGroupId(child.pid) ?? supervisorPgid });
    process.stdin.on("data", (chunk) => {
      try {
        child.stdin.write(chunk);
      } catch (error) {
        if (!ignorablePipeError(error)) fail(error);
      }
    });
    process.stdin.on("end", () => {
      try {
        child.stdin.end();
      } catch (error) {
        if (!ignorablePipeError(error)) fail(error);
      }
    });
    child.stdin.on("error", (error) => {
      if (!ignorablePipeError(error)) fail(error);
    });
    let stdoutDrained = false;
    let stderrDrained = false;
    let cliExitCode = null;
    let drainedStatusWritten = false;
    const maybeReadyForParentReap = () => {
      if (cliExitCode === null || !stdoutDrained || !stderrDrained || drainedStatusWritten) return;
      if (windowsJob) {
        try {
          if (windowsJob.activeProcesses() !== WINDOWS_JOB.ONLY_SUPERVISOR_ACTIVE_COUNT) {
            setTimeout(maybeReadyForParentReap, TIMING_MS.SUPERVISOR_STATUS_POLL);
            return;
          }
        } catch (error) {
          fail(error);
          return;
        }
      }
      drainedStatusWritten = true;
      if (!writeTerminalStatus(PHASE.STREAMS_DRAINED, cliExitCode)) return;
      holdForParentReap();
    };
    const forward = (source, destination, onDrained) => {
      let ended = false;
      let pendingWrites = 0;
      let completed = false;
      const maybeDrained = () => {
        if (!ended || pendingWrites !== 0 || completed) return;
        completed = true;
        onDrained();
      };
      source.on("data", (chunk) => {
        pendingWrites++;
        const writable = destination.write(chunk, (error) => {
          pendingWrites--;
          if (error) fail(error);
          maybeDrained();
        });
        if (!writable) {
          source.pause();
          destination.once("drain", () => source.resume());
        }
      });
      source.on("end", () => {
        ended = true;
        maybeDrained();
      });
      source.on("error", (error) => fail(error));
    };
    forward(child.stdout, process.stdout, () => {
      stdoutDrained = true;
      maybeReadyForParentReap();
    });
    forward(child.stderr, process.stderr, () => {
      stderrDrained = true;
      maybeReadyForParentReap();
    });
    child.once("error", (error) => fail(error));
    child.once("exit", (code) => {
      if (failed) return;
      cliExitCode = typeof code === "number" ? code : EXIT_CODE.SUPERVISOR_UNPROVEN;
      process.exitCode = cliExitCode;
      if (!writeTerminalStatus(PHASE.CLI_EXITED, cliExitCode)) return;
      maybeReadyForParentReap();
    });
  })
  .catch((error) => fail(error, EXIT_CODE.SUPERVISOR_START_FAILED));
`;

export function launchOwnedSupervisorProcess(
  argv: string[],
  options: EngineProcessSpawnOptions & { ownedRuntime: OwnedProcessController },
  runtime: OwnedSupervisorLaunchRuntime = defaultOwnedSupervisorLaunchRuntime(),
): EngineProcess {
  const nonce = runtime.randomUUID();
  const { bindAckPath, cleanupRuntimeRoot, receiptPath, statusPath } = createOwnedRuntimeArtifacts(
    runtime,
    nonce,
  );
  const {
    child,
    pid: childPid,
    stdin: childStdin,
  } = spawnOwnedSupervisorChild({
    argv,
    bindAckPath,
    cleanupRuntimeRoot,
    options,
    receiptPath,
    runtime,
    script: OWNED_SUPERVISOR_SCRIPT,
    statusPath,
  });
  let stdinError: Error | undefined;
  childStdin.on("error", (error) => {
    if (ignorableOwnedStdinError(error)) return;
    stdinError ??= error instanceof Error ? error : new Error(String(error));
  });
  let cliPid: number | undefined;
  try {
    const supervisorReceipt = waitForOwnedSupervisorReceipt(
      receiptPath,
      OWNED_SUPERVISOR_RECEIPT_KEY.SUPERVISOR_PID,
      runtime,
    );
    options.ownedRuntime.assertSupervisorContainment(
      supervisorReceipt[OWNED_SUPERVISOR_RECEIPT_KEY.CONTAINMENT],
    );
    options.ownedRuntime.bindSupervisor(childPid);
    (runtime.writeFileSync ?? writeFileSync)(
      bindAckPath,
      `${JSON.stringify({
        [OWNED_SUPERVISOR_RECEIPT_KEY.PHASE]: OWNED_SUPERVISOR_RECEIPT_PHASE.BIND_ACK,
      })}\n`,
      { mode: 0o600 },
    );
    const cliReceipt = waitForOwnedSupervisorReceipt(
      receiptPath,
      OWNED_SUPERVISOR_RECEIPT_KEY.CLI_PID,
      runtime,
    );
    cliPid = cliReceipt[OWNED_SUPERVISOR_RECEIPT_KEY.CLI_PID];
    options.ownedRuntime.bindLaunch(childPid, cliPid, {
      identity: cliReceipt[OWNED_SUPERVISOR_RECEIPT_KEY.CLI_IDENTITY],
      identityState: cliReceipt[OWNED_SUPERVISOR_RECEIPT_KEY.CLI_IDENTITY_STATE],
      pgid: cliReceipt[OWNED_SUPERVISOR_RECEIPT_KEY.CLI_PGID],
    });
    if (stdinError) throw stdinError;
    try {
      childStdin.write(options.stdinText);
      childStdin.end();
    } catch (error) {
      if (!ignorableOwnedStdinError(error)) throw error;
    }
    if (stdinError) throw stdinError;
  } catch (error) {
    try {
      options.ownedRuntime.failLaunch(childPid, cliPid, (error as Error).message);
      try {
        childStdin.end();
      } catch (stdinEndError) {
        if (!ignorableOwnedStdinError(stdinEndError)) throw stdinEndError;
      }
    } finally {
      cleanupRuntimeRoot();
    }
    throw error;
  } finally {
    runtime.rmSync(bindAckPath, { force: true });
    runtime.rmSync(receiptPath, { force: true });
  }
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", (code) => {
      resolve(code);
    });
    child.once("error", reject);
  });
  const rootExited = watchOwnedSupervisorExit(statusPath, exited, runtime).finally(() => {
    cleanupRuntimeRoot();
  });
  return projectOwnedEngineProcess({
    child,
    exited,
    pid: childPid,
    rootExited,
    stdin: childStdin,
  });
}
