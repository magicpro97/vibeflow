import { OWNED_PROCESS_TIMING_MS } from "./owned-process-contract.js";
import type {
  OwnedProcessObservation,
  OwnedProcessPlatform,
  OwnedProcessQuiescenceHint,
  QuiescenceMode,
} from "./owned-process-platform.js";
import { observationMatches } from "./owned-process-platform.js";
import type { OwnedAttemptProcessRecordV1 } from "./owned-process-record.js";

const SYNC_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function pauseSync(ms: number): void {
  Atomics.wait(SYNC_SLEEP_BUFFER, 0, 0, ms);
}

export function exactObservedRoot(
  platform: OwnedProcessPlatform,
  pid: number | null,
  identity: string | null,
): OwnedProcessObservation | null {
  if (!pid || !identity) return null;
  const observed = platform.observe(pid);
  return observationMatches(pid, identity, observed) ? observed : null;
}

interface OwnedReapTarget {
  observation: OwnedProcessObservation;
  cliFallback: boolean;
}

function exactReapTarget(
  platform: OwnedProcessPlatform,
  record: OwnedAttemptProcessRecordV1,
): OwnedReapTarget | null {
  const supervisor = exactObservedRoot(platform, record.supervisor_pid, record.supervisor_identity);
  if (supervisor) return { observation: supervisor, cliFallback: false };
  if (!platform.terminateExactCliFallback) return null;
  const cli = exactObservedRoot(platform, record.cli_pid, record.cli_identity);
  return cli ? { observation: cli, cliFallback: true } : null;
}

function terminateReapTarget(
  platform: OwnedProcessPlatform,
  record: OwnedAttemptProcessRecordV1,
  target: OwnedReapTarget,
  force: boolean,
): void {
  if (target.cliFallback) {
    platform.terminateExactCliFallback?.(record, target.observation, force);
    return;
  }
  platform.terminateExactTree(target.observation, force);
}

async function reapObservedRoot(
  platform: OwnedProcessPlatform,
  record: OwnedAttemptProcessRecordV1,
  target: OwnedReapTarget,
  graceMs: number,
  mode: QuiescenceMode,
  hint: OwnedProcessQuiescenceHint,
  sleep: (ms: number) => Promise<void> | void,
): Promise<boolean | null> {
  try {
    terminateReapTarget(platform, record, target, false);
    hint.exact_tree_termination_succeeded = true;
  } catch {
    hint.exact_tree_termination_succeeded = false;
  }
  const deadline = Date.now() + Math.max(0, graceMs);
  while (Date.now() < deadline) {
    const quiescent = platform.proveQuiescent(record, mode, hint);
    if (quiescent === true) return true;
    await sleep(Math.min(OWNED_PROCESS_TIMING_MS.REAP_POLL, Math.max(1, deadline - Date.now())));
  }
  const forceTarget = exactReapTarget(platform, record);
  if (forceTarget) {
    try {
      terminateReapTarget(platform, record, forceTarget, true);
      hint.exact_tree_termination_succeeded = true;
    } catch {
      hint.exact_tree_termination_succeeded = false;
    }
  }
  return platform.proveQuiescent(record, mode, hint);
}

export async function reapOwnedProcessRecord(
  platform: OwnedProcessPlatform,
  record: OwnedAttemptProcessRecordV1,
  graceMs: number,
  mode: QuiescenceMode,
  hint: OwnedProcessQuiescenceHint = {},
): Promise<boolean | null> {
  const target = exactReapTarget(platform, record);
  if (!target) return platform.proveQuiescent(record, mode, hint);
  return reapObservedRoot(
    platform,
    record,
    target,
    graceMs,
    mode,
    hint,
    (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  );
}

export function reapOwnedProcessRecordSync(
  platform: OwnedProcessPlatform,
  record: OwnedAttemptProcessRecordV1,
  graceMs: number,
  mode: QuiescenceMode,
  hint: OwnedProcessQuiescenceHint = {},
): boolean | null {
  const target = exactReapTarget(platform, record);
  if (!target) return platform.proveQuiescent(record, mode, hint);
  try {
    terminateReapTarget(platform, record, target, false);
    hint.exact_tree_termination_succeeded = true;
  } catch {
    hint.exact_tree_termination_succeeded = false;
  }
  const deadline = Date.now() + Math.max(0, graceMs);
  while (Date.now() < deadline) {
    const quiescent = platform.proveQuiescent(record, mode, hint);
    if (quiescent === true) return true;
    pauseSync(Math.min(OWNED_PROCESS_TIMING_MS.REAP_POLL, Math.max(1, deadline - Date.now())));
  }
  const forceTarget = exactReapTarget(platform, record);
  if (forceTarget) {
    try {
      terminateReapTarget(platform, record, forceTarget, true);
      hint.exact_tree_termination_succeeded = true;
    } catch {
      hint.exact_tree_termination_succeeded = false;
    }
  }
  return platform.proveQuiescent(record, mode, hint);
}
