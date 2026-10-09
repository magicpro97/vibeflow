// src/resources-quota.ts
//
// Best-effort engine quota probe (Task 3 of the resource-management plan).
//
// INVARIANTS:
//  - `probeQuota` NEVER throws: every failure path (unknown engine, spawn
//    throw, missing binary, non-zero exit, timeout) degrades to
//    `{ level: "unknown", error }`.
//  - The roster of probed engines is exactly the keys of
//    RESOURCE_PROBE_COMMANDS. Engines WITHOUT a stable headless command are
//    not probed so the quota section stays clean (no "no probe command"
//    noise); callers iterate the table keys, not ENGINES.
//  - `gh` unauthenticated is a non-zero exit → "probe failed" → unknown
//    level. That degradation is the expected outcome, not a bug.
//  - The process seam is `createProbeRunner(rt)`: tests inject a fake runtime
//    (no real spawn), and `createProbeRunner(undefined)` reproduces the old
//    no-Bun/Node degradation by construction.

import { type QuotaStatus, parseQuotaOutput } from "./engine-quota.js";

/**
 * Engines with a stable, headless quota command. argv arrays (no shell), so
 * they are portable across platforms. Add an entry only when such a command
 * exists.
 * TODO(#355/#50926): claude/codex probes once headless quota commands exist.
 */
export const RESOURCE_PROBE_COMMANDS = Object.freeze({
  copilot: ["gh", "api", "user/copilot_billing"],
} as const);

export type ProbeEngine = keyof typeof RESOURCE_PROBE_COMMANDS;

const isProbeEngine = (engine: string): engine is ProbeEngine =>
  Object.hasOwn(RESOURCE_PROBE_COMMANDS, engine);

export type ProbeRunner = (
  argv: readonly string[],
) => Promise<{ stdout: string; exitCode: number }>;

/**
 * The `which`/`spawn` pair the runner needs, structurally. `kill` names only
 * the two signals the runner sends, which keeps Bun's `Subprocess` assignable
 * to this seam without casts.
 */
export type ProbeRuntime = {
  which: (bin: string) => string | null;
  spawn: (argv: readonly string[]) => {
    exited: Promise<number>;
    stdout: ReadableStream<Uint8Array> | null;
    kill: (signal?: "SIGTERM" | "SIGKILL") => void;
  };
};

/** Kill a hung probe after this long — quota is best-effort, never blocking. */
const PROBE_TIMEOUT_MS = 5000;

/** Grace period between the timeout SIGTERM and the SIGKILL escalation. */
const KILL_GRACE_MS = 250;

/**
 * Exit code mirroring the shell's command-not-found convention (127). The
 * runner returns it when `which` cannot resolve the binary (e.g. no `gh` on a
 * Windows CI runner), so probeQuota can report the distinct "command not
 * found" degradation instead of the generic "probe failed".
 */
const COMMAND_NOT_FOUND_EXIT = 127;

/**
 * Build a `ProbeRunner` over a runtime seam. `rt === undefined` (no Bun /
 * Node-run dist) resolves a non-zero exit — the exact equivalent of the old
 * `typeof Bun === "undefined"` throw-guard, which probeQuota maps to
 * "probe failed" by construction. With a runtime: resolve via `rt.which`;
 * missing binary → exit 127 ("command not found"); otherwise spawn argv-only
 * and race the exit against `timeoutMs`, escalating SIGTERM → SIGKILL so a
 * signal-ignoring child cannot keep the probe hanging.
 */
export function createProbeRunner(
  rt: ProbeRuntime | undefined,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): ProbeRunner {
  if (!rt) return async () => ({ stdout: "", exitCode: -1 });
  return async (argv) => {
    const [bin, ...rest] = argv;
    const resolved = rt.which(bin ?? "");
    if (!resolved) return { stdout: "", exitCode: COMMAND_NOT_FOUND_EXIT };
    const proc = rt.spawn([resolved, ...rest]);
    const stdoutText = new Response(proc.stdout).text();
    const timedOut = Symbol("probe timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => {
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
        resolve(timedOut);
      }, timeoutMs);
    });
    try {
      const outcome = await Promise.race([proc.exited, timeout]);
      if (outcome === timedOut) return { stdout: "", exitCode: -1 };
      return { stdout: await stdoutText, exitCode: outcome };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Real runtime binding from the global Bun object; undefined outside Bun. */
const bunRuntime = (): ProbeRuntime | undefined => {
  if (typeof Bun === "undefined") return undefined;
  return {
    which: (bin) => Bun.which(bin),
    spawn: (argv) => Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore" }),
  };
};

/** Default runner: the real Bun process seam. */
const defaultProbeRunner: ProbeRunner = createProbeRunner(bunRuntime());

/**
 * Probe one engine's quota, best-effort. Unknown engine → no command entry →
 * `unknown` without invoking the runner. Any runner failure → `unknown`.
 */
export async function probeQuota(
  engine: string,
  run: ProbeRunner = defaultProbeRunner,
): Promise<QuotaStatus> {
  if (!isProbeEngine(engine)) return { level: "unknown", error: "no probe command" };
  try {
    const { stdout, exitCode } = await run(RESOURCE_PROBE_COMMANDS[engine]);
    if (exitCode === COMMAND_NOT_FOUND_EXIT) {
      return { level: "unknown", error: "command not found" };
    }
    if (exitCode !== 0) return { level: "unknown", error: "probe failed" };
    return parseQuotaOutput(engine, stdout);
  } catch {
    return { level: "unknown", error: "probe failed" };
  }
}
