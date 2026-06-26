import type { Engine } from "../core.js";

// Re-export of `Bun.spawn` under a stable name so the test seam (`AsyncSpawnerOpts.spawn`)
// can be typed as `typeof bunSpawn` and tests can pass any function with the same
// signature. We resolve `Bun.spawn` lazily on each call so tests that temporarily
// replace `Bun.spawn` (e.g. the Windows shim auto-shell tests) still hit the mock —
// binding once would freeze the reference and bypass the mock. Production callers
// never see the seam.
const bunSpawn = ((...args: unknown[]) =>
  (Bun.spawn as (...a: any[]) => any)(...args)) as unknown as typeof Bun.spawn;

/**
 * Minimum tool-call turns for an engine run to be considered productive.
 * Sessions with at least this many turns (and no JSON summary) receive
 * {@link CONFIDENCE_MODERATE} instead of zero, so the investigation loop
 * does not discard the result of a session that clearly did work.
 *
 * @rationale A single turn could be a trivial exchange; 3 turns indicate
 *   sustained tool-using work that likely produced meaningful changes even
 *   without an explicit summary block.
 * @provenance Introduced alongside the graduated-scale fallback in
 *   `parseEngineSummary` (prompt.ts) to replace a single hardcoded 0.85
 *   that masked zero-turn failures. 3 was chosen as the lowest count where
 *   "something real probably happened" based on observational heuristics of
 *   typical multi-turn Claude sessions.
 */
const MIN_PRODUCTIVE_TURNS = 3;

/**
 * Turn threshold above which a session is considered highly productive.
 * Sessions at or above this threshold receive {@link CONFIDENCE_PRODUCTIVE}
 * — the ceiling of the graduated scale.
 *
 * @rationale 10 turns represents a substantial interaction ($0.50–$1.00+
 *   in tool-call tokens in typical Claude sessions), well past the moderate
 *   boundary. Separating the bands prevents a short-but-legit session from
 *   receiving the same confidence as a deeply investigative one.
 * @provenance Derived from the original 0.85 confidence level, which was
 *   noted as "correct for productive sessions (15+ turns, $0.70+ in tool
 *   calls)". Lowered from ~15 to 10 during the graduated-scale refactor to
 *   capture more sessions while keeping the top band reserved for clearly
 *   expensive runs.
 */
const HIGH_PRODUCTIVE_TURNS = 10;

/**
 * Confidence value for sessions that meet or exceed
 * {@link HIGH_PRODUCTIVE_TURNS} turns but produced no JSON summary.
 *
 * @rationale Matches the old universal fallback — it was correct for the
 *   sessions it was designed for (genuinely productive, multi-turn runs).
 *   Retained as the ceiling so existing behaviour is preserved for the
 *   cases the old code handled well.
 * @provenance Originally the single hardcoded fallback confidence in
 *   VibeFlow prior to the graduated-scale refactor.
 */
const CONFIDENCE_PRODUCTIVE = 0.85;

/**
 * Confidence value for sessions with at least {@link MIN_PRODUCTIVE_TURNS}
 * but fewer than {@link HIGH_PRODUCTIVE_TURNS} turns (no JSON summary).
 *
 * @rationale Short-to-intermediate sessions may have done real work but
 *   haven't accumulated enough tool-call evidence to merit the top band.
 *   0.7 is high enough that investigation doesn't immediately discard the
 *   result but low enough that it still requires scrutiny before reaching
 *   confidence 1.0.
 * @provenance Introduced as the lower tier of the graduated scale to
 *   differentiate clearly productive (0.85) from moderately active (0.7)
 *   sessions. Chosen as a reasonable midpoint above "zero" but well below
 *   the ceiling.
 */
const CONFIDENCE_MODERATE = 0.7;
export {
  bunSpawn,
  MIN_PRODUCTIVE_TURNS,
  HIGH_PRODUCTIVE_TURNS,
  CONFIDENCE_PRODUCTIVE,
  CONFIDENCE_MODERATE,
};

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
