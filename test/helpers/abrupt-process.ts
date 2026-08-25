import { spawnSync } from "node:child_process";

interface AbruptSpawnResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
  readonly stdout: string | Buffer | null;
  readonly stderr: string | Buffer | null;
}

interface AbruptSpawnOptions {
  readonly encoding: "utf8";
  readonly shell: false;
  readonly timeout: number;
  readonly windowsHide: true;
}

export type AbruptProcessSpawner = (
  executable: string,
  argv: string[],
  options: AbruptSpawnOptions,
) => AbruptSpawnResult;

export interface AbruptNodeProcessOptions {
  readonly source: string;
  readonly args?: readonly string[];
  readonly expectedStatus: number;
  readonly timeoutMs?: number;
}

const defaultSpawner: AbruptProcessSpawner = (executable, argv, options) =>
  spawnSync(executable, argv, options);

/**
 * Run a real Node/Bun subprocess whose abrupt non-zero exit is the behavior under test.
 * The bounded direct-argv launch and every terminal outcome are checked in one place.
 */
export function runAbruptNodeProcess(
  options: AbruptNodeProcessOptions,
  spawn: AbruptProcessSpawner = defaultSpawner,
): AbruptSpawnResult {
  const timeout = options.timeoutMs ?? 10_000;
  if (!options.source || options.source.includes("\0"))
    throw new Error("abrupt process source must be non-empty and NUL-free");
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000)
    throw new Error("abrupt process timeout must be a positive bounded integer");
  if (
    !Number.isSafeInteger(options.expectedStatus) ||
    options.expectedStatus < 1 ||
    options.expectedStatus > 255
  )
    throw new Error("abrupt process expected status must be between 1 and 255");
  const args = [...(options.args ?? [])];
  if (args.some((value) => typeof value !== "string" || value.includes("\0")))
    throw new Error("abrupt process argv must contain only NUL-free strings");
  const result = spawn(process.execPath, ["-e", options.source, ...args], {
    encoding: "utf8",
    shell: false,
    timeout,
    windowsHide: true,
  });
  if (result.error)
    throw new Error("abrupt process launch or timeout failure", { cause: result.error });
  if (result.signal !== null)
    throw new Error(`abrupt process ended by unexpected signal: ${result.signal}`);
  if (result.status === null) throw new Error("abrupt process returned no exit status");
  if (result.status !== options.expectedStatus)
    throw new Error(
      `abrupt process exit status ${result.status} did not match ${options.expectedStatus}`,
    );
  return result;
}
