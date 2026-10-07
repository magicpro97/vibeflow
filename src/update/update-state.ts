// src/update/update-state.ts
//
// Machine-global record of the LAST successful version-changing install, written
// by `vf update` and consumed by `vf update --rollback` (and the UI status
// route). Deliberately in ~/.vibeflow/ next to auto-update.json: the package
// install is global, so the undo record must be too.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSafe } from "../core.js";
import { isValidVersion } from "../core/version-format.js";
import { UPDATE_MANAGER_ID, type UpdateManagerId } from "../settings-update.js";

export const UPDATE_STATE_PATH = join(homedir(), ".vibeflow", "update-state.json");

export interface UpdateStateV1 {
  schema_version: number;
  previous_version: string;
  manager: UpdateManagerId;
  at: number;
}

const MANAGER_IDS: readonly string[] = Object.values(UPDATE_MANAGER_ID);

/** Strict structural parse; anything off reads as null (treated as "no record"). */
export function readUpdateState(path: string = UPDATE_STATE_PATH): UpdateStateV1 | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<UpdateStateV1>;
    if (parsed.schema_version !== 1) return null;
    if (typeof parsed.previous_version !== "string" || !isValidVersion(parsed.previous_version))
      return null;
    if (typeof parsed.manager !== "string" || !MANAGER_IDS.includes(parsed.manager)) return null;
    if (typeof parsed.at !== "number" || !Number.isFinite(parsed.at)) return null;
    return {
      schema_version: 1,
      previous_version: parsed.previous_version,
      manager: parsed.manager as UpdateManagerId,
      at: parsed.at,
    };
  } catch {
    return null;
  }
}

export function writeUpdateState(state: UpdateStateV1, path: string = UPDATE_STATE_PATH): void {
  // writeFileSafe already creates the parent directory (core.ts:193 does
  // mkdirSync(dirname(path), { recursive: true })) — a fresh machine with no
  // ~/.vibeflow yet is handled there; nothing extra needed here.
  writeFileSafe(path, JSON.stringify(state));
}
