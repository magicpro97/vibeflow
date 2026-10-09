// src/resources-quota.ts
//
// Best-effort engine quota probe (Task 3 of the resource-management plan).
//
// INVARIANTS:
//  - `probeQuota` NEVER throws: every failure path (unknown engine, spawn
//    throw, missing binary, non-zero exit, timeout) degrades to
//    `{ level: "unknown", error }`.
//  - The roster of probed engines is exactly the keys of
//    RESOURCE_PROBE_COMMANDS. That table is EMPTY today: no engine exposes
//    a stable, VERIFIED headless quota command (verified live 2026-10-09 —
//    candidates against `gh api ...` answer 404; `claude usage --json` /
//    `codex doctor --usage` do not exist; tracked in #355/#50926). Add an
//    entry ONLY after running the command for real, and keep the payload
//    fixture representative of the verified shape.
//  - `gh` unauthenticated is a non-zero exit → "probe failed" → unknown
//    level. That degradation is the expected outcome, not a bug.
//  - The process seam is `createProbeRunner(rt)`: tests inject a fake runtime
//    (no real spawn), and `createProbeRunner(undefined)` reproduces the old
//    no-Bun/Node degradation by construction. `probeQuota` takes the command
//    table as a seam so every runner path stays covered while the production
//    table is empty.

import { type QuotaStatus, parseQuotaOutput } from "./engine-quota.js";

/**
 * Engines with a stable, headless quota command. argv arrays (no shell), so
 * they are portable across platforms. EMPTY today: add an entry only when
 * such a command EXISTS AND has been run successfully (see header).
 * TODO(#355/#50926): add claude/codex/copilot probes once stable headless
 * quota commands exist.
 */
export const RESOURCE_PROBE_COMMANDS = Object.freeze({} as const);

/** The table shape `probeQuota` accepts; defaults to the production table. */
export type ProbeCommandTable = Readonly<Record<string, readonly string[]>>;

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

/** Bound on the post-SIGKILL join so an unkillable child can never block. */
const KILL_JOIN_MS = KILL_GRACE_MS * 4;

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
 * signal-ignoring child cannot keep the probe hanging. Termination is
 * idempotent and exception-safe: both kills are contained (a dead child must
 * not crash the timer callback), the grace timer is retained and cleared, and
 * the timeout path joins a bounded process exit before resolving so no child
 * or stream is left pending after return.
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
    let grace: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => {
        try {
          proc.kill("SIGTERM");
        } catch {
          // A dead child cannot be killed; the bounded join below settles.
        }
        grace = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // Same contract as the SIGTERM catch.
          }
        }, KILL_GRACE_MS);
        resolve(timedOut);
      }, timeoutMs);
    });
    try {
      const outcome = await Promise.race([proc.exited, timeout]);
      if (outcome === timedOut) {
        // Join a bounded exit (the SIGKILL above, or an already-dead child);
        // `exited` may reject on a racing kill, which is a settled result.
        await Promise.race([
          proc.exited.catch(() => -1),
          new Promise((resolve) => setTimeout(resolve, KILL_JOIN_MS)),
        ]);
        return { stdout: "", exitCode: -1 };
      }
      return { stdout: await stdoutText, exitCode: outcome };
    } finally {
      clearTimeout(timer);
      clearTimeout(grace);
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
 * Probe one engine's quota, best-effort. Unknown engine → no command entry in
 * `table` → `unknown` without invoking the runner. Any runner failure →
 * `unknown`.
 */
export async function probeQuota(
  engine: string,
  run: ProbeRunner = defaultProbeRunner,
  table: ProbeCommandTable = RESOURCE_PROBE_COMMANDS,
): Promise<QuotaStatus> {
  const argv = table[engine];
  if (!argv) return { level: "unknown", error: "no probe command" };
  try {
    const { stdout, exitCode } = await run(argv);
    if (exitCode === COMMAND_NOT_FOUND_EXIT) {
      return { level: "unknown", error: "command not found" };
    }
    if (exitCode !== 0) return { level: "unknown", error: "probe failed" };
    return parseQuotaOutput(engine, stdout);
  } catch {
    return { level: "unknown", error: "probe failed" };
  }
}
