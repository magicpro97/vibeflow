import type { Engine } from "../core.js";
import { OWNED_PROCESS_TERMINAL_KIND } from "./owned-process-contract.js";
import {
  assertOwnedProcessHealthClear,
  inspectOwnedAttemptProcesses,
} from "./owned-process-health.js";
import type { OwnedProcessPlatform } from "./owned-process-platform.js";
import { OwnedProcessController, type OwnedProcessRecordStore } from "./owned-process-runtime.js";
import {
  OWNED_SUPERVISOR_TERMINAL_PHASE,
  type OwnedSupervisorExitOutcome,
} from "./owned-process-status.js";
import type { EngineProcess } from "./session-types.js";

export function reserveOwnedSessionRuntime(
  store: OwnedProcessRecordStore | undefined,
  platform: OwnedProcessPlatform | undefined,
  attemptId: string,
  engine: Engine,
): OwnedProcessController | undefined {
  if (!store || !platform) return undefined;
  assertOwnedProcessHealthClear(inspectOwnedAttemptProcesses(store, platform, true), "launch");
  return new OwnedProcessController(store, platform, store.reserve(attemptId, engine, platform));
}

export function reapOwnedSessionRootExit(
  processHandle: EngineProcess,
  ownedRuntime: OwnedProcessController | undefined,
  graceMs: number,
): Promise<OwnedSupervisorExitOutcome | undefined> {
  return processHandle.rootExited
    ? processHandle.rootExited.then(async (outcome) => {
        if (ownedRuntime) await ownedRuntime.terminate(graceMs);
        return outcome;
      })
    : Promise.resolve(undefined);
}

export function noteOwnedOutputDrainFailure(
  rootOutcome: OwnedSupervisorExitOutcome | undefined,
  ownedRuntime: OwnedProcessController | undefined,
): string | undefined {
  if (rootOutcome?.phase !== OWNED_SUPERVISOR_TERMINAL_PHASE.STREAMS_DRAIN_UNPROVEN)
    return undefined;
  ownedRuntime?.noteTerminal(OWNED_PROCESS_TERMINAL_KIND.OUTPUT_DRAIN_UNPROVEN);
  return "owned CLI output drain proof failed";
}
