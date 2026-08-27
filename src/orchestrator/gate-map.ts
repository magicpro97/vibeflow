// src/orchestrator/gate-map.ts
//
// W-A: map a scoped-gate result onto the four-slot unit gate object.
//
// scopedGate runs typecheck → biome → test and SHORT-CIRCUITS on the first
// failure, so the gates AFTER the failing one never ran. A gate that did not
// execute must be reported "pending", NOT "pass" — claiming "pass" for a gate
// that never ran is the exact theater-gate bug W-A exists to fix.
//
// pass-order: build(typecheck) → lint(biome) → test(bun test).

import type { GateState } from "../core.js";
import {
  GATE_STATE,
  PENDING_REQUIRED_WORK_UNIT_GATES,
  type RequiredWorkUnitGateName,
  WORK_UNIT_GATE,
} from "../core/workflow-contract.js";

/** The minimal shape of a scoped-gate verdict this mapper consumes. */
export interface MeasuredGate {
  pass: boolean;
  failedGate?: "typecheck" | "biome" | "test" | "coverage";
}

type Gates = Record<RequiredWorkUnitGateName, GateState>;

/**
 * Map a measured scoped-gate result onto the unit's gate slots. When `measured`
 * is undefined (dry / bridge / no-scope) every slot stays "pending" — there was
 * no measurement. When a gate failed, the slots downstream of it stay "pending"
 * (they never ran); only gates that actually ran are "pass"/"fail". `review` is
 * always "pending" here — the reviewer sets it later.
 */
export function mapGateResult(measured: MeasuredGate | undefined): Gates {
  if (!measured) return { ...PENDING_REQUIRED_WORK_UNIT_GATES };
  if (measured.pass)
    return {
      [WORK_UNIT_GATE.BUILD]: GATE_STATE.PASS,
      [WORK_UNIT_GATE.LINT]: GATE_STATE.PASS,
      [WORK_UNIT_GATE.TEST]: GATE_STATE.PASS,
      [WORK_UNIT_GATE.REVIEW]: GATE_STATE.PENDING,
    };
  const f = measured.failedGate;
  return {
    [WORK_UNIT_GATE.BUILD]: f === "typecheck" ? GATE_STATE.FAIL : GATE_STATE.PASS,
    [WORK_UNIT_GATE.LINT]:
      f === "typecheck" ? GATE_STATE.PENDING : f === "biome" ? GATE_STATE.FAIL : GATE_STATE.PASS,
    [WORK_UNIT_GATE.TEST]:
      !f || f === "typecheck" || f === "biome" ? GATE_STATE.PENDING : GATE_STATE.FAIL,
    [WORK_UNIT_GATE.REVIEW]: GATE_STATE.PENDING,
  };
}
