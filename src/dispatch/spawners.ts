import { existsSync } from "node:fs";
import { extname } from "node:path";
import { resolveCommand } from "../core.js";
import { filterEnv } from "./env-filter.js";
import { projectPublicEngineFrames } from "./public-redaction.js";
import type { EngineProcess, EngineProcessSpawner } from "./session-types.js";
import type { AsyncSpawner, AsyncSpawnerOpts, SyncResult } from "./types.js";
import { bunSpawn } from "./types.js";

/** Canonical Bun process launcher for the conversation session adapter. */
export function makeEngineProcessSpawner(spawn: typeof bunSpawn = bunSpawn): EngineProcessSpawner {
  return (argv, options): EngineProcess => {
    const proc = spawn(argv, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: options.detached,
      env: options.env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    }) as unknown as EngineProcess;
    try {
      proc.stdin?.write(options.stdinText);
      proc.stdin?.end();
    } catch (error) {
      proc.startupError = error instanceof Error ? error : new Error(String(error));
    }
    return proc;
  };
}

export const defaultEngineProcessSpawner = makeEngineProcessSpawner();

// Test seam: exported so unit tests can exercise the function body
// (line 67-68) by mocking Bun.spawnSync.
export function defaultSpawner(
  cmd: string,
  args: string[],
  input: string,
  inject: { spawnSync?: (cmd: string, args: string[], input: string) => SyncResult } = {},
): SyncResult {
  const _spawnSync = inject.spawnSync ?? defaultSyncSpawner;
  return _spawnSync(cmd, args, input);
}

/** Test seam: a sync spawner that pipes stderr (M2 parity with the async path) and detects
 *  Windows .cmd/.bat shims (Task 4 audit fix: previously, `defaultSpawner` used `Bun.spawnSync`
 *  without `stderr: "pipe"`, leaking the child's stderr to the parent TTY; and without the
 *  Windows shim auto-detect that `makeAsyncSpawner` performs, the sync path failed with
 *  `ENOENT` on `copilot.cmd` and similar npm shims). */
export function defaultSyncSpawner(cmd: string, args: string[], input: string): SyncResult {
  const resolvedCmd = resolveCommand(cmd) ?? cmd;
  const needsShell = shouldUseWindowsShell(cmd, resolvedCmd);
  const spawnArgs = needsShell
    ? process.platform === "win32"
      ? ["cmd.exe", "/c", cmd, ...args]
      : ["/bin/sh", "-c", [cmd, ...args].join(" ")]
    : [cmd, ...args];
  // Pipe stderr so child error output is captured in the result (M2) and never leaks to the
  // parent TTY. Previously `Bun.spawnSync([cmd, ...args], { ..., stdout: "pipe" })` only piped
  // stdout — `stderr` defaulted to inherit on Bun under some versions, leaking engine errors
  // (e.g. Claude / Codex JSON parse failures) directly to the user's terminal.
  const r = Bun.spawnSync(spawnArgs, {
    stdin: Buffer.from(input, "utf8"),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

/** Exit status surfaced when a hung engine is force-killed by the timeout (matches GNU timeout). */
const TIMEOUT_STATUS = 124;
/** Default grace between SIGTERM and the hard SIGKILL when a process group ignores the term. */
const DEFAULT_GRACE_MS = 3000;

function hasWindowsShimSibling(path: string): boolean {
  if (extname(path)) return false;
  return existsSync(`${path}.cmd`) || existsSync(`${path}.bat`);
}

function shouldUseWindowsShell(cmd: string, resolvedCmd: string): boolean {
  if (process.platform !== "win32") return false;
  if (/\.(?:cmd|bat)$/i.test(resolvedCmd)) return true;
  if (cmd.toLowerCase() === "copilot") return true;
  return hasWindowsShimSibling(resolvedCmd);
}

interface AsyncResult {
  status: number;
  stdout: string;
  /** M2: accumulated stderr — not surfaced through the public AsyncSpawner type, but kept
   *  internally so debug logs can dump it on a non-zero exit. */
  stderr: string;
  timedOut?: boolean;
}

/**
 * Build an async spawner using node child_process.spawn (no shell). Unlike spawnSync it does
 * NOT block the event loop, so multiple lanes truly overlap under the parallel runner. The
 * prompt is written to stdin so we never interpolate it into a shell string.
 *
 * The child is spawned `detached: true` (POSIX) so it becomes its own process group leader;
 * on timeout / cancel we `process.kill(-pid, ...)` the WHOLE group with SIGTERM, then SIGKILL
 * after `graceMs`, so the engine's own tool-subprocesses (Claude's `node` tool processes,
 * Codex's `bash -c` helpers, Copilot's mcp-server children) die too rather than orphaning.
 * On Windows `process.kill(-pid, ...)` is not supported, so we fall back to single-pid
 * `proc.kill(...)` and orphan-subprocess cleanup is best-effort.
 *
 * M2: stderr is now PIPED (not inherited) and routed to {@link AsyncSpawnerOpts.onStderrChunk}.
 * The bus owns the destination — bytes no longer leak to the parent TTY. Order is preserved
 * because each `data` event is dispatched in arrival order on the same event loop tick; the
 * logbus fanout is synchronous, so the bus sees stdout/stderr chunks in the same order the
 * child emitted them.
 */
// Test seam: callers can inject a fake `spawn` to simulate group-kill behavior in unit
// tests without spawning real subprocesses. `onStderrChunk` and `onChunk` are kept on
// opts for back-compat; M2 fanout goes through these callbacks.
export function makeAsyncSpawner(opts: AsyncSpawnerOpts = {}): AsyncSpawner {
  const {
    timeoutMs,
    graceMs = DEFAULT_GRACE_MS,
    idleTimeoutMs,
    shell,
    onChunk,
    onStderrChunk,
    cwd,
  } = opts;
  const _spawn = opts.spawn ?? bunSpawn;
  // #556: scrub the host env ONCE at spawner-build so every launch from this spawner
  // hands the child a filtered env (secret-shaped vars dropped). `onAudit` sees the
  // dropped NAMES (never values) so the caller can log the scrub.
  const { env: filteredEnv, dropped } = filterEnv(process.env, opts.envPolicy ?? {});
  opts.onAudit?.(dropped);
  return async (cmd, args, input): Promise<AsyncResult> => {
    // On Windows, .cmd/.bat shims (e.g. copilot.cmd installed by npm)
    // cannot be executed directly via CreateProcess. Detect and
    // auto-enable shell mode so the existing spawner works without
    // every caller having to pass shell: true. Resolve the command
    // path first; if the resolved path is a .cmd/.bat shim, use
    // shell. The explicit `shell` opt still wins if caller sets it.
    const resolvedCmd = resolveCommand(cmd) ?? cmd;
    const needsShell = shell ?? shouldUseWindowsShell(cmd, resolvedCmd);
    const spawnArgs = needsShell
      ? process.platform === "win32"
        ? ["cmd.exe", "/c", cmd, ...args]
        : ["/bin/sh", "-c", [cmd, ...args].join(" ")]
      : [cmd, ...args];
    // `detached: true` makes the child a process-group leader on POSIX so we can later
    // `process.kill(-pid, ...)` the entire group (engine + its tool children). On Windows
    // detached has no effect on group formation, so we skip it and use single-pid kill.
    const proc = _spawn(spawnArgs, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
      env: filteredEnv,
      ...(cwd ? { cwd } : {}),
    });
    try {
      proc.stdin?.write(input);
    } catch (err) {
      // B3: if stdin.write throws (EPIPE / child already exited), kill the
      // child and wait for it to actually exit before re-throwing, otherwise
      // the orphan process keeps running with a closed pipe.
      try {
        proc.kill();
      } catch {
        // Process may have already exited — nothing to kill.
      }
      try {
        await proc.exited;
      } catch {
        // proc.exited can reject if the kill itself fails; swallow so the
        // original stdin error is what the caller sees.
      }
      throw err;
    }
    proc.stdin?.end();

    const stdoutReader = proc.stdout?.getReader();
    const stderrReader = proc.stderr?.getReader();
    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();
    let stdout = "";
    let stderr = "";
    let publicStdout = "";
    let publicStderr = "";
    let publicStdoutDiscarding = false;
    let publicStderrDiscarding = false;
    let timedOut = false;

    let term: Timer | undefined;
    let graceTerm: Timer | undefined;
    // Group-leader pid: the SIGN that the child was spawned detached on POSIX. On Windows
    // there is no group-kill equivalent, so we kill the direct child only.
    const isPosixGroupLeader = process.platform !== "win32" && proc.pid != null;
    const killGroup = (signal: NodeJS.Signals) => {
      if (!isPosixGroupLeader || proc.pid == null) {
        try {
          proc.kill(signal);
        } catch {
          // Process already exited.
        }
        return;
      }
      try {
        // Negative pid = process group (POSIX). Kills the engine AND its tool children.
        process.kill(-proc.pid, signal);
      } catch {
        // Group may already be gone (child exited naturally between SIGTERM and SIGKILL).
        try {
          proc.kill(signal);
        } catch {
          // Best-effort fallback to direct kill.
        }
      }
    };
    const killProc = () => {
      if (timedOut) return;
      timedOut = true;
      killGroup("SIGTERM");
      if (graceMs > 0) graceTerm = setTimeout(() => killGroup("SIGKILL"), graceMs);
    };
    if (timeoutMs != null) {
      term = setTimeout(killProc, timeoutMs);
    }

    let idle: Timer | undefined;
    const resetIdle = () => {
      if (idle != null) clearTimeout(idle);
      if (idleTimeoutMs != null) idle = setTimeout(killProc, idleTimeoutMs);
    };
    resetIdle();

    await Promise.all([
      (async () => {
        while (stdoutReader) {
          const { done, value } = await stdoutReader.read();
          if (done) {
            const tail = stdoutDecoder.decode();
            stdout += tail;
            const projected = projectPublicEngineFrames(
              publicStdout + tail,
              undefined,
              true,
              [],
              publicStdoutDiscarding,
            );
            for (const frame of projected.frames) onChunk?.(frame);
            break;
          }
          const s = stdoutDecoder.decode(value, { stream: true });
          stdout += s;
          const projected = projectPublicEngineFrames(
            publicStdout + s,
            undefined,
            false,
            [],
            publicStdoutDiscarding,
          );
          publicStdout = projected.remainder;
          publicStdoutDiscarding = projected.discardingOversize;
          for (const frame of projected.frames) onChunk?.(frame);
          resetIdle();
        }
      })(),
      (async () => {
        while (stderrReader) {
          const { done, value } = await stderrReader.read();
          if (done) {
            const tail = stderrDecoder.decode();
            stderr += tail;
            const projected = projectPublicEngineFrames(
              publicStderr + tail,
              undefined,
              true,
              [],
              publicStderrDiscarding,
            );
            for (const frame of projected.frames) onStderrChunk?.(frame);
            break;
          }
          const s = stderrDecoder.decode(value, { stream: true });
          stderr += s;
          const projected = projectPublicEngineFrames(
            publicStderr + s,
            undefined,
            false,
            [],
            publicStderrDiscarding,
          );
          publicStderr = projected.remainder;
          publicStderrDiscarding = projected.discardingOversize;
          for (const frame of projected.frames) onStderrChunk?.(frame);
          resetIdle();
        }
      })(),
    ]);

    if (term) {
      clearTimeout(term);
    }
    if (idle) {
      clearTimeout(idle);
    }
    const exitCode = await proc.exited;
    if (graceTerm) {
      clearTimeout(graceTerm);
    }
    const status = timedOut ? TIMEOUT_STATUS : (exitCode ?? 1);
    return { status, stdout, stderr, timedOut };
  };
}

/** Default async spawner — {@link makeAsyncSpawner} with no timeout (behavior unchanged). */
export const defaultAsyncSpawner: AsyncSpawner = makeAsyncSpawner();
