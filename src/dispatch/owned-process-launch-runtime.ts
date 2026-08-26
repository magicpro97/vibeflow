import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir as nodeTmpdir } from "node:os";
import { join } from "node:path";
import { ensurePrivateDirectory } from "../durability/index.js";
import type { EngineProcessSpawner } from "./session-types.js";

const OWNED_RUNTIME = Symbol.for("vibeflow.dispatch.owned-runtime");
const OWNED_RUNTIME_NONCE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNED_RUNTIME_ROOT_PREFIX = "vibeflow-owned-runtime-";

export interface OwnedSupervisorLaunchRuntime {
  delay: (ms: number) => Promise<void>;
  ensurePrivateDirectory?: typeof ensurePrivateDirectory;
  lstatSync?: typeof lstatSync;
  mkdirSync: typeof mkdirSync;
  now: () => number;
  randomUUID: typeof randomUUID;
  readFileSync: typeof readFileSync;
  rmSync: typeof rmSync;
  spawn: typeof nodeSpawn;
  platform?: NodeJS.Platform;
  tmpdir: typeof nodeTmpdir;
  writeFileSync?: typeof writeFileSync;
}

export function defaultOwnedSupervisorLaunchRuntime(): OwnedSupervisorLaunchRuntime {
  return {
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ensurePrivateDirectory,
    lstatSync,
    mkdirSync,
    now: Date.now,
    randomUUID,
    readFileSync,
    rmSync,
    spawn: nodeSpawn,
    platform: process.platform,
    tmpdir: nodeTmpdir,
    writeFileSync,
  };
}

export function createOwnedRuntimeRoot(
  runtime: OwnedSupervisorLaunchRuntime,
  nonce: string,
): { path: string; cleanup: () => void } {
  if (!OWNED_RUNTIME_NONCE.test(nonce)) throw new Error("owned runtime nonce is invalid");
  const candidate = join(runtime.tmpdir(), `${OWNED_RUNTIME_ROOT_PREFIX}${nonce}`);
  runtime.mkdirSync(candidate, { mode: 0o700 });
  let path: string;
  try {
    const observed = (runtime.lstatSync ?? lstatSync)(candidate);
    if (!observed.isDirectory() || observed.isSymbolicLink()) {
      throw new Error("owned runtime root is not a private directory");
    }
    path =
      (runtime.platform ?? process.platform) === "win32"
        ? candidate
        : (runtime.ensurePrivateDirectory ?? ensurePrivateDirectory)(candidate);
  } catch (error) {
    try {
      runtime.rmSync(candidate, { recursive: true, force: true });
    } catch {
      // Preserve the root validation failure.
    }
    throw error;
  }
  return {
    path,
    cleanup: () => {
      try {
        runtime.rmSync(path, { recursive: true, force: true });
      } catch {
        // A cleanup failure must not replace the process terminal outcome.
      }
    },
  };
}

export function supportsOwnedRuntime(spawner: EngineProcessSpawner | undefined): boolean {
  return Boolean((spawner as { [OWNED_RUNTIME]?: true } | undefined)?.[OWNED_RUNTIME]);
}

export function markOwnedRuntimeSpawner<T extends EngineProcessSpawner>(spawner: T): T {
  (spawner as { [OWNED_RUNTIME]?: true })[OWNED_RUNTIME] = true;
  return spawner;
}
