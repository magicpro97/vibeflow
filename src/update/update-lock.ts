// src/update/update-lock.ts
//
// Machine-global single-flight lock for `vf update`: two concurrent updates
// (the auto-mode watcher + a manual run, or watchers of two repos on the same
// machine) would race the undo record and overwrite each other's handoff
// request. proper-lockfile's `<path>.lock` directory (mkdir-based) is the
// repo's established inter-process lock primitive (logbus, trace journal).

import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { writeFileSafe } from "../core.js";

export const UPDATE_LOCK_PATH = join(homedir(), ".vibeflow", "update.lock");
/** A wedged holder is stealable after this long (proper-lockfile refreshes mtime while held). */
export const UPDATE_LOCK_STALE_MS = 10 * 60_000;

/** Acquire the update lock, or return null when another update holds it.
 *  The returned release function is safe to await exactly once. */
export function acquireUpdateLock(path: string = UPDATE_LOCK_PATH): (() => Promise<void>) | null {
  try {
    writeFileSafe(path, "");
    const release = lockfile.lockSync(path, {
      realpath: false,
      retries: 0,
      stale: UPDATE_LOCK_STALE_MS,
    });
    return async () => {
      await release();
    };
  } catch {
    return null;
  }
}
