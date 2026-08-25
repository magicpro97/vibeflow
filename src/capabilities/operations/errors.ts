import type { CapabilityPreEffectRefusalReasonV1 } from "../wire/operation.js";

export type CapabilityRuntimeErrorCodeV1 =
  | "action-required"
  | "package-not-found"
  | "ambiguous-package"
  | "service-unavailable"
  | "invalid-plan"
  | "authorization-mismatch"
  | "authority-head-stale"
  | "policy-stale"
  | "grant-stale"
  | "source-authority-stale"
  | "permission-stale"
  | "user-prerequisite-stale"
  | "private-input-stale"
  | "enforcement-stale"
  | "scope-base-stale"
  | "owned-preimage-stale"
  | "apply-failed"
  | "health-failed"
  | "rollback-failed"
  | "scope-needs-recovery"
  | "operation-not-found"
  | "integrity-failure"
  | "fault";

const REFUSAL_ERROR_CODES = {
  "scope-base-stale": "scope-base-stale",
  "authority-head-stale": "authority-head-stale",
  "policy-stale": "policy-stale",
  "grant-stale": "grant-stale",
  "permission-stale": "permission-stale",
  "user-prerequisite-stale": "user-prerequisite-stale",
  "source-authority-stale": "source-authority-stale",
  "private-input-stale": "private-input-stale",
  "enforcement-stale": "enforcement-stale",
  "owned-preimage-stale": "owned-preimage-stale",
} as const satisfies Record<CapabilityPreEffectRefusalReasonV1, CapabilityRuntimeErrorCodeV1>;

export function runtimeCodeForRefusal(
  reason: CapabilityPreEffectRefusalReasonV1,
): CapabilityRuntimeErrorCodeV1 {
  return REFUSAL_ERROR_CODES[reason];
}

export class CapabilityRuntimeError extends Error {
  constructor(
    message: string,
    readonly runtime_code: CapabilityRuntimeErrorCodeV1,
  ) {
    super(`${runtime_code}: ${message}`);
    this.name = "CapabilityRuntimeError";
  }
}
