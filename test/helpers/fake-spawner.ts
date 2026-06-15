// Centralized fake spawner for tests that need to mock process spawning
// without actually spawning real subprocesses. The verify(), runDispatch(),
// and other "outer" functions in src/ accept an `inject.spawner` parameter
// for exactly this purpose. Keep this file's API small and obvious.
//
// Why this exists: the same `fakeSpawner = (cmd, args) => ({status, ...})`
// pattern was duplicated in 4+ tests across 2 files. When a future test
// needs a new shape (e.g. spawnSync that returns a Buffer stdout), they
// extend this helper instead of inlining yet another copy.
import type { spawn as NodeSpawn } from "node:child_process";

export type SpawnResult = {
  status: number | null;
  stdout?: Buffer | string;
  stderr?: Buffer | string;
  signal?: string | null;
  pid?: number;
  output?: Array<Buffer | string | null>;
};

export type SpawnerFn = (cmd: string, args: readonly string[], options?: unknown) => SpawnResult;

export type Spawner = (cmd: string, args: readonly string[], options?: unknown) => SpawnResult;

export interface FakeSpawnerOptions {
  /** When set, this cmd prefix always returns `status`. */
  exitFor?: { cmd: string; status: number };
  /** When set, capture calls here. */
  calls?: Array<{ cmd: string; args: readonly string[]; options?: unknown }>;
  /** Default status to return if no exitFor matches. Default 0. */
  defaultStatus?: number;
}

/**
 * Build a fake spawner. Records every call. Optionally returns a specific
 * exit code when the cmd matches a prefix (so tests can fail the gradle
 * gate, npm lint, etc. by name).
 *
 * Usage:
 *   const calls: Call[] = [];
 *   const spawner = makeFakeSpawner({ calls, exitFor: { cmd: "gradle", status: 0 } });
 *   const code = verify({ spawner });
 *   expect(calls).toEqual([{ cmd: "gradle", args: ["check"], ... }]);
 */
export function makeFakeSpawner(opts: FakeSpawnerOptions = {}): Spawner {
  const { exitFor, calls, defaultStatus = 0 } = opts;
  return (cmd: string, args: readonly string[], options?: unknown) => {
    calls?.push({ cmd, args, options });
    const status =
      exitFor && (cmd === exitFor.cmd || cmd.includes(exitFor.cmd))
        ? exitFor.status
        : defaultStatus;
    return {
      status,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    };
  };
}

/**
 * Type-cast a fake spawner to whatever the production code expects.
 * Bun's `Bun.spawn` and Node's `child_process.spawnSync` have incompatible
 * signatures, but tests only need to satisfy the calls our code actually
 * makes. Use `as never` at the call site, not in this helper.
 */
export function asSpawnSync<T>(spawner: Spawner): T {
  return spawner as unknown as T;
}

// Re-export the type for convenience
export type NodeSpawnFn = typeof NodeSpawn;
