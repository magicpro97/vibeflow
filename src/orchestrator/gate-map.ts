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

/** The minimal shape of a scoped-gate verdict this mapper consumes. */
export interface MeasuredGate {
  pass: boolean;
  failedGate?: "typecheck" | "biome" | "test" | "coverage";
}

type Gates = Record<"build" | "lint" | "test" | "review", GateState>;

const ALL_PENDING: Gates = {
  build: "pending",
  lint: "pending",
  test: "pending",
  review: "pending",
};

/**
 * Map a measured scoped-gate result onto the unit's gate slots. When `measured`
 * is undefined (dry / bridge / no-scope) every slot stays "pending" — there was
 * no measurement. When a gate failed, the slots downstream of it stay "pending"
 * (they never ran); only gates that actually ran are "pass"/"fail". `review` is
 * always "pending" here — the reviewer sets it later.
 */
export function mapGateResult(measured: MeasuredGate | undefined): Gates {
  if (!measured) return { ...ALL_PENDING };
  if (measured.pass) return { build: "pass", lint: "pass", test: "pass", review: "pending" };
  const f = measured.failedGate;
  return {
    build: f === "typecheck" ? "fail" : "pass",
    lint: f === "typecheck" ? "pending" : f === "biome" ? "fail" : "pass",
    test: !f || f === "typecheck" || f === "biome" ? "pending" : "fail",
    review: "pending",
  };
}
