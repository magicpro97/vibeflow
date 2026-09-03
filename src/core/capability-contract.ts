/**
 * Dependency-free capability vocabulary shared by actions, persistence, server, and browser DTOs.
 *
 * Runtime objects are the authority. Types, ordered value arrays, and guards are derived from
 * those objects so validators cannot silently drift from the protocol vocabulary.
 */
type ValueOf<Contract> = Contract[keyof Contract];

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && values.some((candidate) => candidate === value);

export const CAPABILITY_SCOPE = Object.freeze({
  PROJECT: "project",
  USER: "user",
} as const);

export type CapabilityScope = ValueOf<typeof CAPABILITY_SCOPE>;
export const CAPABILITY_SCOPES = Object.freeze(Object.values(CAPABILITY_SCOPE));
export const isCapabilityScope = (value: unknown): value is CapabilityScope =>
  memberOf(CAPABILITY_SCOPES, value);

export const CAPABILITY_STATUS = Object.freeze({
  ABSENT: "absent",
  READY: "ready",
  DEGRADED: "degraded",
  BLOCKED: "blocked",
  FAILED: "failed",
  UNKNOWN: "unknown",
  STALE: "stale",
  DRIFTED: "drifted",
  ORPHANED: "orphaned",
  UNMANAGED: "unmanaged",
  MANUAL: "manual",
  UNSUPPORTED: "unsupported",
  NEEDS_RECOVERY: "needs-recovery",
} as const);

export type CapabilityStatusV1 = ValueOf<typeof CAPABILITY_STATUS>;
export const CAPABILITY_STATUSES = Object.freeze(Object.values(CAPABILITY_STATUS));
export const isCapabilityStatus = (value: unknown): value is CapabilityStatusV1 =>
  memberOf(CAPABILITY_STATUSES, value);

export const CAPABILITY_PLAN_STATUS = Object.freeze({
  PLANNED: "planned",
  ACTION_REQUIRED: "action-required",
  NO_OP: "no-op",
} as const);

export type CapabilityPlanStatusV1 = ValueOf<typeof CAPABILITY_PLAN_STATUS>;
export const CAPABILITY_PLAN_STATUSES = Object.freeze(Object.values(CAPABILITY_PLAN_STATUS));
export const isCapabilityPlanStatus = (value: unknown): value is CapabilityPlanStatusV1 =>
  memberOf(CAPABILITY_PLAN_STATUSES, value);
export const CAPABILITY_ACTIONABLE_PLAN_STATUSES = Object.freeze([
  CAPABILITY_PLAN_STATUS.PLANNED,
  CAPABILITY_PLAN_STATUS.ACTION_REQUIRED,
] as const);
export type CapabilityActionablePlanStatusV1 = (typeof CAPABILITY_ACTIONABLE_PLAN_STATUSES)[number];

export const CAPABILITY_RUNTIME_ERROR_CODE = Object.freeze({
  ACTION_REQUIRED: "action-required",
  PACKAGE_NOT_FOUND: "package-not-found",
  AMBIGUOUS_PACKAGE: "ambiguous-package",
  SERVICE_UNAVAILABLE: "service-unavailable",
  INVALID_PLAN: "invalid-plan",
  AUTHORIZATION_MISMATCH: "authorization-mismatch",
  AUTHORITY_HEAD_STALE: "authority-head-stale",
  POLICY_STALE: "policy-stale",
  GRANT_STALE: "grant-stale",
  SOURCE_AUTHORITY_STALE: "source-authority-stale",
  PERMISSION_STALE: "permission-stale",
  USER_PREREQUISITE_STALE: "user-prerequisite-stale",
  PRIVATE_INPUT_STALE: "private-input-stale",
  ENFORCEMENT_STALE: "enforcement-stale",
  SCOPE_BASE_STALE: "scope-base-stale",
  OWNED_PREIMAGE_STALE: "owned-preimage-stale",
  APPLY_FAILED: "apply-failed",
  HEALTH_FAILED: "health-failed",
  ROLLBACK_FAILED: "rollback-failed",
  SCOPE_NEEDS_RECOVERY: "scope-needs-recovery",
  OPERATION_NOT_FOUND: "operation-not-found",
  INTEGRITY_FAILURE: "integrity-failure",
  FAULT: "fault",
} as const);

export type CapabilityRuntimeErrorCodeV1 = ValueOf<typeof CAPABILITY_RUNTIME_ERROR_CODE>;
export const CAPABILITY_RUNTIME_ERROR_CODES = Object.freeze(
  Object.values(CAPABILITY_RUNTIME_ERROR_CODE),
);
export const isCapabilityRuntimeErrorCode = (
  value: unknown,
): value is CapabilityRuntimeErrorCodeV1 => memberOf(CAPABILITY_RUNTIME_ERROR_CODES, value);

export const CAPABILITY_AUTHORITY_STALE_RUNTIME_ERROR_CODES = Object.freeze([
  CAPABILITY_RUNTIME_ERROR_CODE.AUTHORITY_HEAD_STALE,
  CAPABILITY_RUNTIME_ERROR_CODE.POLICY_STALE,
  CAPABILITY_RUNTIME_ERROR_CODE.GRANT_STALE,
  CAPABILITY_RUNTIME_ERROR_CODE.PERMISSION_STALE,
  CAPABILITY_RUNTIME_ERROR_CODE.SOURCE_AUTHORITY_STALE,
] as const);

export type CapabilityAuthorityStaleRuntimeErrorCodeV1 =
  (typeof CAPABILITY_AUTHORITY_STALE_RUNTIME_ERROR_CODES)[number];
