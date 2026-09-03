import {
  GATE_STATE,
  type GateState,
  WORK_UNIT_STATUS,
  type WorkUnitStatus,
} from "../../../core/workflow-contract.js";

const GATE_CLASS = Object.freeze({
  [GATE_STATE.PASS]: "bg-white/70",
  [GATE_STATE.FAIL]: "bg-red-500/60",
  [GATE_STATE.RUNNING]: "bg-white/30 animate-pulse",
  [GATE_STATE.PENDING]: "bg-neutral-700",
} satisfies Readonly<Record<GateState, string>>);

const WORK_UNIT_STATUS_CLASS = Object.freeze({
  [WORK_UNIT_STATUS.PENDING]: "bg-neutral-800/60 text-neutral-500",
  [WORK_UNIT_STATUS.RUNNING]: "bg-neutral-800/60 text-neutral-300",
  [WORK_UNIT_STATUS.VERIFYING]: "bg-neutral-800/60 text-neutral-400",
  [WORK_UNIT_STATUS.DONE]: "bg-neutral-800/40 text-neutral-300",
  [WORK_UNIT_STATUS.BLOCKED]: "bg-neutral-800/40 text-neutral-600",
} satisfies Readonly<Record<WorkUnitStatus, string>>);

export const gateClass = (state: GateState | undefined): string =>
  state === undefined ? "bg-neutral-800/40 text-neutral-700" : GATE_CLASS[state];

export const workUnitStatusClass = (status: WorkUnitStatus): string =>
  WORK_UNIT_STATUS_CLASS[status];
