import { type Engine, hasCommand, resolveCommand, resolveEngineBinary } from "../core.js";
import {
  GH_AUTH_TIMEOUT_MS,
  type ProbeInvocation,
  checkCopilotAuth,
  defaultSpawner,
  engineBinary,
  failedAuth,
  failedProbe,
  ghAuthInvocation,
  ghInstallHint,
  hasGh,
  installHint,
  probeInvocation,
  probeSucceeded,
  probeTimeoutMs,
  runProbe,
} from "./probe.js";
import type { EngineReadiness, PreflightOpts, ProbeResult, ReadinessLevel } from "./types.js";
/** Internal helper for gh auth check + engine probe sequence. */
export function runAttempts(
  engine: Engine,
  has: (cmd: string) => boolean,
  probeSucceeded: (engine: Engine, status: number, stdout: string) => boolean,
  failedProbe: (engine: Engine, result: ProbeResult) => { level: ReadinessLevel; detail: string },
  resolve: (result: EngineReadiness) => void,
  runAttempt: (attempt: ProbeInvocation, timeoutMs?: number) => Promise<ProbeResult>,
  stamp: (level: ReadinessLevel, detail: string) => EngineReadiness,
): Promise<void> {
  if (engine === "copilot" && has("gh")) {
    const auth = runAttempt(ghAuthInvocation(), GH_AUTH_TIMEOUT_MS) as Promise<ProbeResult>;
    return auth.then((authResult) => {
      if (authResult.status !== 0) {
        const failed = failedAuth(engine, authResult);
        resolve(stamp(failed.level, failed.detail));
        return;
      }
      resolve(stamp("ready", "copilot: GitHub auth OK"));
    });
  }
  const attempt = probeInvocation(engine);
  return runAttempt(attempt).then((result) => {
    if (probeSucceeded(engine, result.status, result.stdout)) {
      resolve(stamp("ready", "ready"));
      return;
    }
    const failed = failedProbe(engine, result);
    resolve(stamp(failed.level, failed.detail));
  });
}
export async function checkEngineAsync(
  engine: Engine,
  opts: PreflightOpts = {},
): Promise<EngineReadiness> {
  const has = opts.has ?? hasCommand;
  const now = opts.now ?? (() => new Date().toISOString());
  const stamp = (level: ReadinessLevel, detail: string): EngineReadiness => ({
    engine,
    level,
    detail,
    checkedAt: now(),
  });
  const cmd = engineBinary(engine);
  const usesDefaultHasAsync = opts.has === undefined;
  if (!has(cmd)) {
    const shimCheck = usesDefaultHasAsync ? resolveEngineBinary(cmd) : undefined;
    if (shimCheck === undefined) return Promise.resolve(stamp("no-binary", installHint(engine)));
  }
  const resolvedCmd = opts.spawner !== undefined ? cmd : (resolveCommand(cmd) ?? cmd);
  const spawner = opts.spawner;
  if (engine === "copilot" && !hasGh(has, usesDefaultHasAsync)) {
    return Promise.resolve(stamp("no-binary", ghInstallHint()));
  }
  if (engine === "copilot" && spawner !== undefined) {
    try {
      const auth = checkCopilotAuth(has, spawner, usesDefaultHasAsync);
      return Promise.resolve(stamp(auth.level, auth.detail));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Promise.resolve(stamp("probe-failed", `${engine}: probe failed (${msg})`));
    }
  }
  if (engine === "copilot" && hasGh(has, usesDefaultHasAsync)) {
    const ghCmd = usesDefaultHasAsync ? (resolveEngineBinary("gh") ?? "gh") : "gh";
    const ghResult = defaultSpawner(ghCmd, ["auth", "status"], "", GH_AUTH_TIMEOUT_MS);
    if (ghResult.status === 0) {
      return Promise.resolve(stamp("ready", "copilot: GitHub auth OK"));
    }
    const failed = failedAuth("copilot", ghResult);
    return Promise.resolve(stamp(failed.level, failed.detail));
  }
  if (opts.probe === false) {
    return Promise.resolve(stamp("ready", `${engine}: installed (probe skipped)`));
  }
  if (spawner !== undefined) {
    const probe = runProbe(engine, spawner);
    return Promise.resolve(stamp(probe.level, probe.detail));
  }
  const runAttempt = (
    attempt: ProbeInvocation,
    timeoutMs = probeTimeoutMs(engine, opts.probeTimeoutMs),
  ): Promise<ProbeResult> =>
    new Promise((resolve) => {
      const spawnCmd = attempt.cmd === cmd ? resolvedCmd : attempt.cmd;
      const child = Bun.spawn([spawnCmd, ...attempt.args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      child.stdin?.write(attempt.input);
      child.stdin?.end();
      const timeout = setTimeout(() => {
        child.kill();
        resolve({ status: 124, stdout: "", stderr: `${attempt.cmd}: probe timed out` });
      }, timeoutMs);
      let stdout = "";
      let stderr = "";
      (async () => {
        const reader = child.stdout.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stdout += new TextDecoder().decode(value);
        }
      })();
      (async () => {
        const reader = child.stderr.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stderr += new TextDecoder().decode(value);
        }
      })();
      child.exited
        .then((code) => {
          clearTimeout(timeout);
          resolve({ status: code ?? 1, stdout, stderr });
        })
        .catch((err: unknown) => {
          clearTimeout(timeout);
          const msg = err instanceof Error ? err.message : String(err);
          resolve({ status: 1, stdout, stderr: msg });
        });
    });
  return new Promise((resolve) => {
    runAttempts(engine, has, probeSucceeded, failedProbe, resolve, runAttempt, stamp).catch(
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        resolve(stamp("probe-failed", `${engine}: probe failed (${msg})`));
      },
    );
  });
}
