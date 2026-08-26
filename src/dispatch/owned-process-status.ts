import type { readFileSync } from "node:fs";
import {
  OWNED_PROCESS_EXIT_CODE,
  OWNED_PROCESS_TIMING_MS,
  OWNED_SUPERVISOR_OUTCOME_KIND,
  OWNED_SUPERVISOR_PHASE,
  OWNED_SUPERVISOR_STATUS_KEY,
  OWNED_SUPERVISOR_TERMINAL_PHASE,
  type OwnedSupervisorPhase,
  type OwnedSupervisorTerminalPhase,
  isOwnedSupervisorPhase,
} from "./owned-process-contract.js";

export {
  OWNED_SUPERVISOR_TERMINAL_PHASE,
  type OwnedSupervisorTerminalPhase,
} from "./owned-process-contract.js";

interface SupervisorExitStatus {
  phase: OwnedSupervisorPhase;
  exitCode: number;
}

export interface OwnedSupervisorExitOutcome {
  phase: OwnedSupervisorTerminalPhase;
  exitCode: number | null;
}

const WATCH_STATE_KIND = Object.freeze({
  PENDING: "pending",
  TERMINAL: "terminal",
  FAILED: "failed",
} as const);

type WatchState =
  | { kind: typeof WATCH_STATE_KIND.PENDING }
  | { kind: typeof WATCH_STATE_KIND.TERMINAL; outcome: OwnedSupervisorExitOutcome }
  | { kind: typeof WATCH_STATE_KIND.FAILED; error: unknown };

export interface OwnedSupervisorStatusRuntime {
  delay: (ms: number) => Promise<void>;
  now: () => number;
  readFileSync: typeof readFileSync;
}

function readExitStatus(
  path: string,
  runtime: OwnedSupervisorStatusRuntime,
): SupervisorExitStatus | null {
  try {
    const parsed: unknown = JSON.parse(runtime.readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const exitCode = record[OWNED_SUPERVISOR_STATUS_KEY.EXIT_CODE];
    const phase = record[OWNED_SUPERVISOR_STATUS_KEY.PHASE];
    if (!Number.isSafeInteger(exitCode) || !isOwnedSupervisorPhase(phase)) return null;
    return { phase, exitCode: exitCode as number };
  } catch {
    return null;
  }
}

export async function watchOwnedSupervisorExit(
  statusPath: string,
  supervisorExit: Promise<number | null>,
  runtime: OwnedSupervisorStatusRuntime,
): Promise<OwnedSupervisorExitOutcome> {
  let cliExitObservedAt: number | null = null;
  const supervisorOutcome: {
    current:
      | { kind: typeof OWNED_SUPERVISOR_OUTCOME_KIND.RUNNING }
      | { kind: typeof OWNED_SUPERVISOR_OUTCOME_KIND.EXITED; code: number | null }
      | { kind: typeof OWNED_SUPERVISOR_OUTCOME_KIND.FAILED; error: unknown };
  } = { current: { kind: OWNED_SUPERVISOR_OUTCOME_KIND.RUNNING } };
  void supervisorExit.then(
    (code) => {
      supervisorOutcome.current = { kind: OWNED_SUPERVISOR_OUTCOME_KIND.EXITED, code };
    },
    (error: unknown) => {
      supervisorOutcome.current = { kind: OWNED_SUPERVISOR_OUTCOME_KIND.FAILED, error };
    },
  );
  let watchState: WatchState = { kind: WATCH_STATE_KIND.PENDING };
  while (watchState.kind === WATCH_STATE_KIND.PENDING) {
    const status = readExitStatus(statusPath, runtime);
    if (
      status?.phase === OWNED_SUPERVISOR_PHASE.STREAMS_DRAINED ||
      status?.phase === OWNED_SUPERVISOR_PHASE.FAILED
    ) {
      watchState = {
        kind: WATCH_STATE_KIND.TERMINAL,
        outcome: {
          phase:
            status.phase === OWNED_SUPERVISOR_PHASE.STREAMS_DRAINED
              ? OWNED_SUPERVISOR_TERMINAL_PHASE.STREAMS_DRAINED
              : OWNED_SUPERVISOR_TERMINAL_PHASE.SUPERVISOR_FAILED,
          exitCode: status.exitCode,
        },
      };
      continue;
    }
    if (status?.phase === OWNED_SUPERVISOR_PHASE.CLI_EXITED) {
      cliExitObservedAt ??= runtime.now();
      if (runtime.now() - cliExitObservedAt >= OWNED_PROCESS_TIMING_MS.OUTPUT_DRAIN_PROOF_TIMEOUT) {
        watchState = {
          kind: WATCH_STATE_KIND.TERMINAL,
          outcome: {
            phase: OWNED_SUPERVISOR_TERMINAL_PHASE.STREAMS_DRAIN_UNPROVEN,
            exitCode: OWNED_PROCESS_EXIT_CODE.OUTPUT_DRAIN_UNPROVEN,
          },
        };
        continue;
      }
    }
    const observedSupervisor = supervisorOutcome.current;
    if (observedSupervisor.kind === OWNED_SUPERVISOR_OUTCOME_KIND.EXITED) {
      if (status?.phase === OWNED_SUPERVISOR_PHASE.CLI_EXITED) {
        watchState = {
          kind: WATCH_STATE_KIND.TERMINAL,
          outcome: {
            phase: OWNED_SUPERVISOR_TERMINAL_PHASE.STREAMS_DRAIN_UNPROVEN,
            exitCode: OWNED_PROCESS_EXIT_CODE.OUTPUT_DRAIN_UNPROVEN,
          },
        };
        continue;
      }
      watchState = {
        kind: WATCH_STATE_KIND.TERMINAL,
        outcome: {
          phase: OWNED_SUPERVISOR_TERMINAL_PHASE.SUPERVISOR_EXITED_UNPROVEN,
          exitCode:
            observedSupervisor.code === null || observedSupervisor.code === 0
              ? OWNED_PROCESS_EXIT_CODE.SUPERVISOR_UNPROVEN
              : observedSupervisor.code,
        },
      };
      continue;
    }
    if (observedSupervisor.kind === OWNED_SUPERVISOR_OUTCOME_KIND.FAILED) {
      watchState = { kind: WATCH_STATE_KIND.FAILED, error: observedSupervisor.error };
      continue;
    }
    await runtime.delay(OWNED_PROCESS_TIMING_MS.SUPERVISOR_STATUS_POLL);
  }
  if (watchState.kind === WATCH_STATE_KIND.FAILED) throw watchState.error;
  return watchState.outcome;
}
