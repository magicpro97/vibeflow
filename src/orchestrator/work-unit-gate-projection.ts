import type { WorkUnit } from "../core.js";
import { GATE_STATE, WORK_UNIT_GATE, WORK_UNIT_STATUS } from "../core/workflow-contract.js";
import { SECURITY_VERDICT } from "../core/workflow-contract.js";
import type { SecurityCheckpointResult } from "./security-checkpoint.js";

export const CHEAP_WORK_UNIT_GATES = Object.freeze([
  WORK_UNIT_GATE.BUILD,
  WORK_UNIT_GATE.LINT,
  WORK_UNIT_GATE.TEST,
] as const);
export type CheapWorkUnitGateName = (typeof CHEAP_WORK_UNIT_GATES)[number];

type ProjectableOutcome = {
  status: WorkUnit["status"];
  gates?: Partial<WorkUnit["gates"]>;
  security?: SecurityCheckpointResult;
};

export const hasCheapGateFailure = (outcome: ProjectableOutcome): boolean =>
  outcome.status === WORK_UNIT_STATUS.BLOCKED ||
  CHEAP_WORK_UNIT_GATES.some((gate) => outcome.gates?.[gate] === GATE_STATE.FAIL);

export function projectSecurityGate(
  outcome: ProjectableOutcome,
  security: SecurityCheckpointResult,
): void {
  outcome.security = security;
  if (security.verdict === SECURITY_VERDICT.FAIL) {
    outcome.status = WORK_UNIT_STATUS.BLOCKED;
    outcome.gates = { ...(outcome.gates ?? {}), security: GATE_STATE.FAIL };
  } else if (
    security.verdict === SECURITY_VERDICT.PASS ||
    security.verdict === SECURITY_VERDICT.NEEDS_REVIEW
  ) {
    outcome.gates = { ...(outcome.gates ?? {}), security: GATE_STATE.PASS };
  }
}

export function projectReviewGate(unit: WorkUnit, passed: boolean): void {
  unit.status = passed ? WORK_UNIT_STATUS.DONE : WORK_UNIT_STATUS.BLOCKED;
  unit.gates = { ...unit.gates, review: passed ? GATE_STATE.PASS : GATE_STATE.FAIL };
}
