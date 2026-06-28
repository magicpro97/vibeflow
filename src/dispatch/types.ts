import type { Engine } from "../core.js";

// Re-export of `Bun.spawn` under a stable name so the test seam (`AsyncSpawnerOpts.spawn`)
// can be typed as `typeof bunSpawn` and tests can pass any function with the same
// signature. We resolve `Bun.spawn` lazily on each call so tests that temporarily
// replace `Bun.spawn` (e.g. the Windows shim auto-shell tests) still hit the mock —
// binding once would freeze the reference and bypass the mock. Production callers
// never see the seam.
const bunSpawn = ((...args: unknown[]) =>
  (Bun.spawn as (...a: any[]) => any)(...args)) as unknown as typeof Bun.spawn;

export { bunSpawn };

/** Structured summary an engine is asked to emit at the end of a dispatch. */
export interface EngineSummary {
  skills_used?: string[];
  files_changed?: string[];
  commands_run?: string[];
  tests_run?: string[];
  confidence?: number;
  uncertainty?: string;
}

export interface DispatchResult {
  engine: Engine;
  mode: "bridge" | "cli" | "dry";
  ok: boolean;
  raw: string;
  summary?: EngineSummary;
  reason?: string;
  /** Non-fatal advisory (e.g. an unverifiable Copilot CLI version). */
  warning?: string;
}

export type Spawner = (
  cmd: string,
  args: string[],
  input: string,
) => { status: number; stdout: string; stderr?: string };

/** Sync spawn result — `stderr` is captured (M2 parity) so error output never leaks to TTY. */
export interface SyncResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Async spawn seam: genuinely overlapping process launches for the parallel path.
 *  Test seams may omit fields that production never inspects (e.g. `stderr`); the in-process
 *  chain only requires status + stdout for the dispatch contract.
 *
 *  `stderr` is optional so existing tests that only construct `{ status, stdout }` keep
 *  compiling — but production code that needs to inspect stderr (e.g. rate-limit
 *  detection in `defaultAiInitDispatcher`) should pass an `onStderrChunk` hook on
 *  `AsyncSpawnerOpts` and the spawner will accumulate it onto the returned object. */
export type AsyncSpawner = (
  cmd: string,
  args: string[],
  input: string,
) => Promise<{ status: number; stdout: string; stderr?: string; timedOut?: boolean }>;

export interface AsyncSpawnerOpts {
  timeoutMs?: number;
  graceMs?: number;
  shell?: boolean;
  /** Called for each stdout chunk (engine progress / tool output). */
  onChunk?: (text: string) => void;
  /** M2: called for each stderr chunk (engine warnings, errors, progress noise).
   *  Bytes that used to inherit the parent TTY now flow through this hook so the logbus
   *  is the SOLE destination — the bus owns user-facing visibility. */
  onStderrChunk?: (text: string) => void;
  /** M2: kill process if no stdout/stderr received within this window (resets on each chunk). */
  idleTimeoutMs?: number;
  /** Test seam: inject a fake spawner (compatible with `Bun.spawn`'s argv + opts signature)
   *  to exercise the spawner without launching real subprocesses. Production callers must
   *  omit this; the spawner falls back to `Bun.spawn` (which now runs `detached: true` on
   *  POSIX so the engine + its tool children share a process group that we can kill
   *  together). */
  spawn?: typeof bunSpawn;

  /** Working directory for the spawned engine. When set, the engine (and its tool
   *  children) run rooted here instead of process.cwd() — the per-unit worktree
   *  isolation seam (W1). Omitted → inherits the parent cwd (unchanged default). */
  cwd?: string;
}

/** Probe seam so engine-availability / version checks are injectable in tests. */
export interface EngineProbe {
  has?: (cmd: string) => boolean;
  version?: (cmd: string) => string | undefined;
}

export interface EngineInvocation {
  cmd: string;
  args: string[];
  /** Copilot CLI requires the prompt as the `-p` option value; other engines read stdin. */
  promptMode?: "stdin" | "arg";
  /** Non-fatal advisory surfaced to the caller (does not block dispatch). */
  warning?: string;
}

export interface EngineUnavailable {
  unavailable: string;
}

export type EngineCommandResult = EngineInvocation | EngineUnavailable;
