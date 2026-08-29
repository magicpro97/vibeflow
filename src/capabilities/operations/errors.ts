import {
  CAPABILITY_RUNTIME_ERROR_CODE,
  type CapabilityRuntimeErrorCodeV1,
  type CapabilityScope,
} from "../../core/capability-contract.js";
import {
  CAPABILITY_PRE_EFFECT_REFUSAL_REASON,
  type CapabilityPreEffectRefusalReasonV1,
} from "../wire/operation.js";

export {
  CAPABILITY_RUNTIME_ERROR_CODE,
  CAPABILITY_RUNTIME_ERROR_CODES,
  isCapabilityRuntimeErrorCode,
} from "../../core/capability-contract.js";
export type { CapabilityRuntimeErrorCodeV1 } from "../../core/capability-contract.js";

export const CAPABILITY_RUNTIME_ERROR_CODE_BY_REFUSAL_REASON = Object.freeze({
  [CAPABILITY_PRE_EFFECT_REFUSAL_REASON.SCOPE_BASE_STALE]:
    CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_BASE_STALE,
  [CAPABILITY_PRE_EFFECT_REFUSAL_REASON.AUTHORITY_HEAD_STALE]:
    CAPABILITY_RUNTIME_ERROR_CODE.AUTHORITY_HEAD_STALE,
  [CAPABILITY_PRE_EFFECT_REFUSAL_REASON.POLICY_STALE]: CAPABILITY_RUNTIME_ERROR_CODE.POLICY_STALE,
  [CAPABILITY_PRE_EFFECT_REFUSAL_REASON.GRANT_STALE]: CAPABILITY_RUNTIME_ERROR_CODE.GRANT_STALE,
  [CAPABILITY_PRE_EFFECT_REFUSAL_REASON.PERMISSION_STALE]:
    CAPABILITY_RUNTIME_ERROR_CODE.PERMISSION_STALE,
  [CAPABILITY_PRE_EFFECT_REFUSAL_REASON.USER_PREREQUISITE_STALE]:
    CAPABILITY_RUNTIME_ERROR_CODE.USER_PREREQUISITE_STALE,
  [CAPABILITY_PRE_EFFECT_REFUSAL_REASON.SOURCE_AUTHORITY_STALE]:
    CAPABILITY_RUNTIME_ERROR_CODE.SOURCE_AUTHORITY_STALE,
  [CAPABILITY_PRE_EFFECT_REFUSAL_REASON.PRIVATE_INPUT_STALE]:
    CAPABILITY_RUNTIME_ERROR_CODE.PRIVATE_INPUT_STALE,
  [CAPABILITY_PRE_EFFECT_REFUSAL_REASON.ENFORCEMENT_STALE]:
    CAPABILITY_RUNTIME_ERROR_CODE.ENFORCEMENT_STALE,
  [CAPABILITY_PRE_EFFECT_REFUSAL_REASON.OWNED_PREIMAGE_STALE]:
    CAPABILITY_RUNTIME_ERROR_CODE.OWNED_PREIMAGE_STALE,
} satisfies Readonly<Record<CapabilityPreEffectRefusalReasonV1, CapabilityRuntimeErrorCodeV1>>);

export function runtimeCodeForRefusal(
  reason: CapabilityPreEffectRefusalReasonV1,
): CapabilityRuntimeErrorCodeV1 {
  return CAPABILITY_RUNTIME_ERROR_CODE_BY_REFUSAL_REASON[reason];
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

/**
 * Thrown when a capability store has not been activated for a scope. The CLI
 * query path treats this as a successful empty result, while lower-level
 * runtime composition keeps failing closed so mutations cannot run without an
 * activated authority.
 */
export class CapabilityNotActivatedError extends Error {
  readonly scope: CapabilityScope;

  constructor(scope: CapabilityScope) {
    super(`capability authority is not activated for scope ${scope}`);
    this.name = "CapabilityNotActivatedError";
    this.scope = scope;
  }
}
