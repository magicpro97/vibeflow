import type { readFileSync } from "node:fs";
import {
  OWNED_PROCESS_TIMING_MS,
  OWNED_SUPERVISOR_RECEIPT_KEY,
  type OwnedCliIdentityState,
  type OwnedProcessQuiescenceScope,
  isOwnedCliIdentityState,
  isOwnedProcessIgnorableStreamErrorCode,
  isOwnedProcessQuiescenceScope,
} from "./owned-process-contract.js";

interface OwnedSupervisorReceiptRuntime {
  now: () => number;
  readFileSync: typeof readFileSync;
}

type SupervisorLaunchReceipt = {
  [OWNED_SUPERVISOR_RECEIPT_KEY.SUPERVISOR_PID]: number;
  [OWNED_SUPERVISOR_RECEIPT_KEY.CONTAINMENT]?: OwnedProcessQuiescenceScope;
};
export type CliLaunchReceipt = {
  [OWNED_SUPERVISOR_RECEIPT_KEY.CLI_PID]: number;
  [OWNED_SUPERVISOR_RECEIPT_KEY.CLI_IDENTITY]?: string | null;
  [OWNED_SUPERVISOR_RECEIPT_KEY.CLI_IDENTITY_STATE]?: OwnedCliIdentityState;
  [OWNED_SUPERVISOR_RECEIPT_KEY.CLI_PGID]?: number | null;
};

type OwnedSupervisorPidReceiptKey =
  | typeof OWNED_SUPERVISOR_RECEIPT_KEY.SUPERVISOR_PID
  | typeof OWNED_SUPERVISOR_RECEIPT_KEY.CLI_PID;

function parseOwnedSupervisorReceipt(
  value: unknown,
  key: OwnedSupervisorPidReceiptKey,
): SupervisorLaunchReceipt | CliLaunchReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const pid = record[key];
  if (!Number.isSafeInteger(pid) || (pid as number) < 1) return null;
  if (key === OWNED_SUPERVISOR_RECEIPT_KEY.SUPERVISOR_PID) {
    const containment = record[OWNED_SUPERVISOR_RECEIPT_KEY.CONTAINMENT];
    if (containment !== undefined && !isOwnedProcessQuiescenceScope(containment)) return null;
    return record as SupervisorLaunchReceipt;
  }
  const identity = record[OWNED_SUPERVISOR_RECEIPT_KEY.CLI_IDENTITY];
  const identityState = record[OWNED_SUPERVISOR_RECEIPT_KEY.CLI_IDENTITY_STATE];
  const pgid = record[OWNED_SUPERVISOR_RECEIPT_KEY.CLI_PGID];
  if (
    (identity !== undefined && identity !== null && typeof identity !== "string") ||
    (identityState !== undefined && !isOwnedCliIdentityState(identityState)) ||
    (pgid !== undefined && pgid !== null && (!Number.isSafeInteger(pgid) || (pgid as number) < 1))
  )
    return null;
  return record as CliLaunchReceipt;
}

export function ignorableOwnedStdinError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | { code?: string } | undefined)?.code;
  return isOwnedProcessIgnorableStreamErrorCode(code);
}

export function waitForOwnedSupervisorReceipt(
  path: string,
  key: typeof OWNED_SUPERVISOR_RECEIPT_KEY.SUPERVISOR_PID,
  runtime: OwnedSupervisorReceiptRuntime,
): SupervisorLaunchReceipt;
export function waitForOwnedSupervisorReceipt(
  path: string,
  key: typeof OWNED_SUPERVISOR_RECEIPT_KEY.CLI_PID,
  runtime: OwnedSupervisorReceiptRuntime,
): CliLaunchReceipt;
export function waitForOwnedSupervisorReceipt(
  path: string,
  key: OwnedSupervisorPidReceiptKey,
  runtime: OwnedSupervisorReceiptRuntime,
): SupervisorLaunchReceipt | CliLaunchReceipt {
  const deadline = runtime.now() + OWNED_PROCESS_TIMING_MS.SUPERVISOR_BOOT;
  while (runtime.now() < deadline) {
    try {
      const parsed: unknown = JSON.parse(runtime.readFileSync(path, "utf8"));
      const receipt = parseOwnedSupervisorReceipt(parsed, key);
      if (receipt) return receipt;
    } catch (error) {
      const code =
        error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : null;
      if (code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      OWNED_PROCESS_TIMING_MS.SUPERVISOR_STATUS_POLL,
    );
  }
  throw new Error(`owned supervisor ${key} receipt timed out`);
}
