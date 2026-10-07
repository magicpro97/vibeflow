// src/update/update-contract.ts
//
// Wire contract for the seamless self-update handoff.
// Two JSON files coordinate `vf update` with a live `vf ui` in one project:
//   .vibeflow/.update-request.json — written by `vf update`; consumed by the UI watcher
//   .vibeflow/.update-handoff.json — written by the UI while it swaps itself out
// Both are untrusted on read (garbage → null, never a throw) and written
// atomically (writeFileSafe: tmp + rename).

import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CTX_DIR, writeFileSafe } from "../core.js";
import { isValidVersion } from "../update-check.js";

export const UPDATE_HANDOFF = Object.freeze({
  SCHEMA_VERSION: "1.0",
  REQUEST_FILE: ".update-request.json",
  STATE_FILE: ".update-handoff.json",
  /** How often a live `vf ui` checks for a handoff request. */
  POLL_MS: 2_000,
  /** Replacement bind-retry cadence while the old listener is still up. */
  BIND_RETRY_MS: 250,
  /** Give up on the replacement after this long, then recover the old server. */
  BIND_DEADLINE_MS: 30_000,
  /** Pause after spawning the replacement, before closing our own listener. */
  REPLACEMENT_GRACE_MS: 1_000,
  /** How long `vf update` waits for one live UI to reach `drained`/`failed`. */
  DRAIN_WAIT_MS: 90_000,
  /** A non-drained state file older than this is stale (doctor advises reaping). */
  STALE_MS: 5 * 60_000,
} as const);

export const UPDATE_HANDOFF_STATE = Object.freeze({
  REPLACEMENT_STARTED: "replacement_started",
  DRAINED: "drained",
  FAILED: "failed",
} as const);
export type UpdateHandoffState = (typeof UPDATE_HANDOFF_STATE)[keyof typeof UPDATE_HANDOFF_STATE];

export interface UpdateRequestV1 {
  readonly schema_version: typeof UPDATE_HANDOFF.SCHEMA_VERSION;
  readonly request_id: string;
  readonly requested_at: number;
  readonly target_version: string;
  readonly requested_by_pid: number;
}

export interface HandoffStateV1 {
  readonly schema_version: typeof UPDATE_HANDOFF.SCHEMA_VERSION;
  readonly request_id: string;
  readonly state: UpdateHandoffState;
  readonly from_version: string;
  readonly target_version: string;
  readonly at: number;
  readonly replacement_pid?: number;
  readonly failure?: string;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseUpdateRequest(value: unknown): UpdateRequestV1 | null {
  if (!plainRecord(value)) return null;
  if (value.schema_version !== UPDATE_HANDOFF.SCHEMA_VERSION) return null;
  if (typeof value.request_id !== "string" || value.request_id.length === 0) return null;
  if (typeof value.requested_at !== "number" || !Number.isFinite(value.requested_at)) return null;
  if (typeof value.target_version !== "string" || !isValidVersion(value.target_version))
    return null;
  if (
    typeof value.requested_by_pid !== "number" ||
    !Number.isInteger(value.requested_by_pid) ||
    value.requested_by_pid <= 0
  )
    return null;
  return Object.freeze({
    schema_version: UPDATE_HANDOFF.SCHEMA_VERSION,
    request_id: value.request_id,
    requested_at: value.requested_at,
    target_version: value.target_version,
    requested_by_pid: value.requested_by_pid,
  });
}

export function parseHandoffState(value: unknown): HandoffStateV1 | null {
  if (!plainRecord(value)) return null;
  if (value.schema_version !== UPDATE_HANDOFF.SCHEMA_VERSION) return null;
  if (typeof value.request_id !== "string" || value.request_id.length === 0) return null;
  if (
    value.state !== UPDATE_HANDOFF_STATE.REPLACEMENT_STARTED &&
    value.state !== UPDATE_HANDOFF_STATE.DRAINED &&
    value.state !== UPDATE_HANDOFF_STATE.FAILED
  )
    return null;
  if (typeof value.from_version !== "string" || !isValidVersion(value.from_version)) return null;
  if (typeof value.target_version !== "string" || !isValidVersion(value.target_version))
    return null;
  if (typeof value.at !== "number" || !Number.isFinite(value.at)) return null;
  if (
    value.replacement_pid !== undefined &&
    (typeof value.replacement_pid !== "number" ||
      !Number.isInteger(value.replacement_pid) ||
      value.replacement_pid <= 0)
  )
    return null;
  if (value.failure !== undefined && typeof value.failure !== "string") return null;
  return Object.freeze({
    schema_version: UPDATE_HANDOFF.SCHEMA_VERSION,
    request_id: value.request_id,
    state: value.state,
    from_version: value.from_version,
    target_version: value.target_version,
    at: value.at,
    ...(value.replacement_pid === undefined ? {} : { replacement_pid: value.replacement_pid }),
    ...(value.failure === undefined ? {} : { failure: value.failure }),
  });
}

export function updateRequestPath(base: string): string {
  return join(base, CTX_DIR, UPDATE_HANDOFF.REQUEST_FILE);
}

export function handoffStatePath(base: string): string {
  return join(base, CTX_DIR, UPDATE_HANDOFF.STATE_FILE);
}

export function readUpdateRequest(
  base: string,
  inject: { readFileSync?: (path: string, enc: string) => string } = {},
): UpdateRequestV1 | null {
  try {
    return parseUpdateRequest(
      JSON.parse((inject.readFileSync ?? readFileSync)(updateRequestPath(base), "utf8")),
    );
  } catch {
    return null;
  }
}

export function clearUpdateRequest(
  base: string,
  inject: { unlinkSync?: (path: string) => void } = {},
): void {
  try {
    (inject.unlinkSync ?? unlinkSync)(updateRequestPath(base));
  } catch {
    /* already gone */
  }
}

export function writeUpdateRequest(base: string, request: UpdateRequestV1): void {
  writeFileSafe(updateRequestPath(base), JSON.stringify(request));
}

export function readHandoffState(
  base: string,
  inject: { readFileSync?: (path: string, enc: string) => string } = {},
): HandoffStateV1 | null {
  try {
    return parseHandoffState(
      JSON.parse((inject.readFileSync ?? readFileSync)(handoffStatePath(base), "utf8")),
    );
  } catch {
    return null;
  }
}

export function writeHandoffState(base: string, state: HandoffStateV1): void {
  writeFileSafe(handoffStatePath(base), JSON.stringify(state));
}

export function isHandoffStale(state: HandoffStateV1, now: number): boolean {
  if (state.state === UPDATE_HANDOFF_STATE.DRAINED) return false;
  return now - state.at > UPDATE_HANDOFF.STALE_MS;
}
