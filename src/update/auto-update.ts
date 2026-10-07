// src/update/auto-update.ts
//
// Auto mode (settings update.mode === "auto"): a long-lived `vf ui` refreshes
// the update cache on a cadence and spawns `vf update` when a newer release is
// known. The spawned command does the install and writes the handoff request;
// the UI then swaps itself out through the normal handoff path. A marker file
// (~/.vibeflow/auto-update.json) stops crash-loop retries for the same version.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSafe } from "../core.js";
import { cmpVersionPrecedence } from "../core/version-format.js";
import { UPDATE_MODE, type UpdateMode } from "../settings-update.js";

export const AUTO_UPDATE = Object.freeze({
  /** Re-check cadence for a long-lived UI. */
  INTERVAL_MS: 30 * 60_000,
  /** Do not re-attempt the same target version within this window. */
  RETRY_MS: 6 * 60 * 60_000,
  MARKER_PATH: join(homedir(), ".vibeflow", "auto-update.json"),
} as const);

export interface AutoUpdateMarker {
  version: string;
  attempted_at: number;
}

export interface AutoUpdateSeams {
  mode: () => UpdateMode;
  refresh: () => Promise<void>;
  readLatest: () => string | null;
  currentVersion: string;
  spawnUpdate: () => boolean;
  now?: () => number;
  readMarker: () => AutoUpdateMarker | null;
  writeMarker: (marker: AutoUpdateMarker) => void;
  outFn?: (message: string) => void;
}

export function readAutoUpdateMarker(path: string): AutoUpdateMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as AutoUpdateMarker;
    if (typeof parsed.version !== "string" || typeof parsed.attempted_at !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeAutoUpdateMarker(marker: AutoUpdateMarker, path: string): void {
  writeFileSafe(path, JSON.stringify(marker));
}

/** One auto-update probe. Returns true when an update command was spawned. */
export async function maybeAutoUpdate(seams: AutoUpdateSeams): Promise<boolean> {
  if (seams.mode() !== UPDATE_MODE.AUTO) return false;
  await seams.refresh();
  const latest = seams.readLatest();
  if (!latest || cmpVersionPrecedence(latest, seams.currentVersion) <= 0) return false;
  const marker = seams.readMarker();
  const now = (seams.now ?? Date.now)();
  if (marker && marker.version === latest && now - marker.attempted_at < AUTO_UPDATE.RETRY_MS)
    return false;
  seams.writeMarker({ version: latest, attempted_at: now });
  const spawned = seams.spawnUpdate();
  seams.outFn?.(
    spawned
      ? `auto-update: installing v${latest}`
      : `auto-update: could not spawn the update command for v${latest}`,
  );
  return spawned;
}

export interface AutoUpdateWatcherSeams extends AutoUpdateSeams {
  intervalMs?: number;
}

export function startAutoUpdateWatcher(seams: AutoUpdateWatcherSeams): { stop: () => void } {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await maybeAutoUpdate(seams);
    } catch {
      /* best-effort — an auto-update probe must never crash the UI */
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, seams.intervalMs ?? AUTO_UPDATE.INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  return { stop: () => clearInterval(timer) };
}
