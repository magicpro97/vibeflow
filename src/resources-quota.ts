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

/** Kill a hung probe after this long — quota is best-effort, never blocking. */
const PROBE_TIMEOUT_MS = 5000;

/**
 * Exit code mirroring the shell's command-not-found convention (127). The
 * default runner returns it when `Bun.which` cannot resolve the binary (e.g.
 * no `gh` on a Windows CI runner), so probeQuota can report the distinct
 * "command not found" degradation instead of the generic "probe failed".
 */
const COMMAND_NOT_FOUND_EXIT = 127;

/** Default runner: resolve via `Bun.which`, spawn argv-only, kill after 5s. */
const defaultProbeRunner: ProbeRunner = async (argv) => {
  // Guard for Node-run contexts (built dist has no `Bun`): degrade, never crash.
  if (typeof Bun === "undefined") throw new Error("Bun unavailable");
  const [bin, ...rest] = argv;
  const resolved = bin ? Bun.which(bin) : null;
  if (!resolved) return { stdout: "", exitCode: COMMAND_NOT_FOUND_EXIT };
  // stderr is ignored: it is neither parsed nor allowed to leak to the TTY.
  const proc = Bun.spawn([resolved, ...rest], { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS);
  try {
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return { stdout, exitCode };
  } finally {
    clearTimeout(timer);
  }
};

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
