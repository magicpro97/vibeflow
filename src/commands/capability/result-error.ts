import { ActionAuthorityStaleError } from "../../actions/authority-proofs.js";
import {
  ActionConflictError,
  type PublicApiErrorV1,
  publicActionError,
} from "../../actions/errors.js";
import {
  PUBLIC_API_ERROR_MESSAGE_MAX_BYTES,
  PUBLIC_ERROR_CANONICAL_MESSAGE,
  PUBLIC_ERROR_CODE,
  PUBLIC_RECOVERY_ACTION,
} from "../../actions/public-error-contract.js";
import { isBoundedWireText } from "../../actions/public-wire-primitives.js";
import { ActionValidationError } from "../../actions/strict-json.js";
import {
  CapabilityNotActivatedError,
  CapabilityRuntimeError,
} from "../../capabilities/operations/errors.js";
import {
  CAPABILITY_RUNTIME_ERROR_CODE,
  type CapabilityRuntimeErrorCodeV1,
  isCapabilityRuntimeErrorCode,
} from "../../core/capability-contract.js";
import { digestHex, digestV1 } from "../../durability/index.js";
import { CapabilityCliUsageError } from "./parser-types.js";

const SAFE_FALLBACK_MESSAGE: Partial<Record<PublicApiErrorV1["error"]["code"], string>> = {
  [PUBLIC_ERROR_CODE.INVALID_REQUEST]: "Capability request is invalid.",
  [PUBLIC_ERROR_CODE.UNSUPPORTED_SCHEMA_VERSION]: "Capability request schema is unsupported.",
  [PUBLIC_ERROR_CODE.TARGET_UNSUPPORTED]: "Capability target is unsupported.",
  [PUBLIC_ERROR_CODE.NOT_FOUND]: "Capability package was not found.",
  [PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE]: "Capability service is unavailable.",
  [PUBLIC_ERROR_CODE.MANUAL_ACTION_REQUIRED]: "Capability command requires a manual action.",
  [PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY]:
    PUBLIC_ERROR_CANONICAL_MESSAGE[PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY],
  [PUBLIC_ERROR_CODE.AUTHORITY_CORRUPT]: "Capability authority is corrupt.",
  [PUBLIC_ERROR_CODE.PREIMAGE_CHANGED]: "Capability preimage changed.",
  [PUBLIC_ERROR_CODE.SOURCE_DIGEST_CHANGED]: "Capability source digest changed.",
};

const CAPABILITY_RUNTIME_ERROR_PUBLIC_MESSAGE = Object.freeze({
  [CAPABILITY_RUNTIME_ERROR_CODE.ACTION_REQUIRED]: "Capability command requires a manual action.",
  [CAPABILITY_RUNTIME_ERROR_CODE.PACKAGE_NOT_FOUND]: "Capability package was not found.",
  [CAPABILITY_RUNTIME_ERROR_CODE.AMBIGUOUS_PACKAGE]: "Capability package selection is ambiguous.",
  [CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE]: "Capability service is unavailable.",
  [CAPABILITY_RUNTIME_ERROR_CODE.INVALID_PLAN]: "Capability plan is invalid.",
  [CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH]:
    "Capability request authority is invalid.",
  [CAPABILITY_RUNTIME_ERROR_CODE.AUTHORITY_HEAD_STALE]: "Capability authority changed.",
  [CAPABILITY_RUNTIME_ERROR_CODE.POLICY_STALE]: "Capability authority changed.",
  [CAPABILITY_RUNTIME_ERROR_CODE.GRANT_STALE]: "Capability authority changed.",
  [CAPABILITY_RUNTIME_ERROR_CODE.SOURCE_AUTHORITY_STALE]: "Capability authority changed.",
  [CAPABILITY_RUNTIME_ERROR_CODE.PERMISSION_STALE]: "Capability authority changed.",
  [CAPABILITY_RUNTIME_ERROR_CODE.USER_PREREQUISITE_STALE]: "Capability authority changed.",
  [CAPABILITY_RUNTIME_ERROR_CODE.PRIVATE_INPUT_STALE]: "Capability authority changed.",
  [CAPABILITY_RUNTIME_ERROR_CODE.ENFORCEMENT_STALE]: "Capability authority changed.",
  [CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_BASE_STALE]: "Capability source digest changed.",
  [CAPABILITY_RUNTIME_ERROR_CODE.OWNED_PREIMAGE_STALE]: "Capability preimage changed.",
  [CAPABILITY_RUNTIME_ERROR_CODE.APPLY_FAILED]: "Capability service is unavailable.",
  [CAPABILITY_RUNTIME_ERROR_CODE.HEALTH_FAILED]: "Capability service is unavailable.",
  [CAPABILITY_RUNTIME_ERROR_CODE.ROLLBACK_FAILED]: "Capability service is unavailable.",
  [CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_NEEDS_RECOVERY]:
    PUBLIC_ERROR_CANONICAL_MESSAGE[PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY],
  [CAPABILITY_RUNTIME_ERROR_CODE.OPERATION_NOT_FOUND]: "Capability service is unavailable.",
  [CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE]: "Capability authority is corrupt.",
  [CAPABILITY_RUNTIME_ERROR_CODE.FAULT]: "Capability service is unavailable.",
} satisfies Readonly<Record<CapabilityRuntimeErrorCodeV1, string>>);

type CapabilityRuntimeErrorPublicProjection = Readonly<{
  publicCode: PublicApiErrorV1["error"]["code"];
  retryable: boolean;
  recoveryAction: PublicApiErrorV1["error"]["recovery_action"];
}>;

const runtimeErrorProjection = (
  publicCode: CapabilityRuntimeErrorPublicProjection["publicCode"],
  retryable: boolean,
  recoveryAction: CapabilityRuntimeErrorPublicProjection["recoveryAction"],
): CapabilityRuntimeErrorPublicProjection =>
  Object.freeze({ publicCode, retryable, recoveryAction });

const CAPABILITY_RUNTIME_ERROR_PUBLIC_PROJECTION = Object.freeze({
  [CAPABILITY_RUNTIME_ERROR_CODE.ACTION_REQUIRED]: runtimeErrorProjection(
    PUBLIC_ERROR_CODE.MANUAL_ACTION_REQUIRED,
    false,
    PUBLIC_RECOVERY_ACTION.RESOLVE_AGAIN,
  ),
  [CAPABILITY_RUNTIME_ERROR_CODE.PACKAGE_NOT_FOUND]: runtimeErrorProjection(
    PUBLIC_ERROR_CODE.NOT_FOUND,
    false,
    null,
  ),
  [CAPABILITY_RUNTIME_ERROR_CODE.AMBIGUOUS_PACKAGE]: runtimeErrorProjection(
    PUBLIC_ERROR_CODE.INVALID_REQUEST,
    false,
    null,
  ),
  [CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE]: runtimeErrorProjection(
    PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE,
    true,
    PUBLIC_RECOVERY_ACTION.RETRY,
  ),
  [CAPABILITY_RUNTIME_ERROR_CODE.INVALID_PLAN]: runtimeErrorProjection(
    PUBLIC_ERROR_CODE.INVALID_REQUEST,
    false,
    null,
  ),
  [CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH]: runtimeErrorProjection(
    PUBLIC_ERROR_CODE.INVALID_REQUEST,
    false,
    null,
  ),
  [CAPABILITY_RUNTIME_ERROR_CODE.AUTHORITY_HEAD_STALE]: runtimeErrorProjection(
    PUBLIC_ERROR_CODE.SOURCE_DIGEST_CHANGED,
    false,
    PUBLIC_RECOVERY_ACTION.REFRESH_PROPOSAL,
  ),
  [CAPABILITY_RUNTIME_ERROR_CODE.POLICY_STALE]: runtimeErrorProjection(
    PUBLIC_ERROR_CODE.SOURCE_DIGEST_CHANGED,
    false,
    PUBLIC_RECOVERY_ACTION.REFRESH_PROPOSAL,
  ),
  [CAPABILITY_RUNTIME_ERROR_CODE.GRANT_STALE]: runtimeErrorProjection(
    PUBLIC_ERROR_CODE.SOURCE_DIGEST_CHANGED,
    false,
    PUBLIC_RECOVERY_ACTION.REFRESH_PROPOSAL,
  ),
  [CAPABILITY_RUNTIME_ERROR_CODE.SOURCE_AUTHORITY_STALE]: runtimeErrorProjection(
    PUBLIC_ERROR_CODE.SOURCE_DIGEST_CHANGED,
    false,
    PUBLIC_RECOVERY_ACTION.REFRESH_PROPOSAL,
  ),
  [CAPABILITY_RUNTIME_ERROR_CODE.PERMISSION_STALE]: runtimeErrorProjection(
    PUBLIC_ERROR_CODE.SOURCE_DIGEST_CHANGED,
    false,
    PUBLIC_RECOVERY_ACTION.REFRESH_PROPOSAL,
  ),
  [CAPABILITY_RUNTIME_ERROR_CODE.USER_PREREQUISITE_STALE]: runtimeErrorProjection(
    PUBLIC_ERROR_CODE.SOURCE_DIGEST_CHANGED,
    false,
    PUBLIC_RECOVERY_ACTION.REFRESH_PROPOSAL,
  ),
  [CAPABILITY_RUNTIME_ERROR_CODE.PRIVATE_INPUT_STALE]: runtimeErrorProjection(
    PUBLIC_ERROR_CODE.SOURCE_DIGEST_CHANGED,
    false,
    PUBLIC_RECOVERY_ACTION.REFRESH_PROPOSAL,
  ),
  [CAPABILITY_RUNTIME_ERROR_CODE.ENFORCEMENT_STALE]: runtimeErrorProjection(
    PUBLIC_ERROR_CODE.SOURCE_DIGEST_CHANGED,
    false,
    PUBLIC_RECOVERY_ACTION.REFRESH_PROPOSAL,
  ),
  [CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_BASE_STALE]: runtimeErrorProjection(
    PUBLIC_ERROR_CODE.SOURCE_DIGEST_CHANGED,
    false,
    PUBLIC_RECOVERY_ACTION.REFRESH_PROPOSAL,
  ),
  [CAPABILITY_RUNTIME_ERROR_CODE.OWNED_PREIMAGE_STALE]: runtimeErrorProjection(
    PUBLIC_ERROR_CODE.PREIMAGE_CHANGED,
    false,
    PUBLIC_RECOVERY_ACTION.REFRESH_PROPOSAL,
  ),
  [CAPABILITY_RUNTIME_ERROR_CODE.APPLY_FAILED]: runtimeErrorProjection(
    PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE,
    true,
    PUBLIC_RECOVERY_ACTION.RETRY,
  ),
  [CAPABILITY_RUNTIME_ERROR_CODE.HEALTH_FAILED]: runtimeErrorProjection(
    PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE,
    true,
    PUBLIC_RECOVERY_ACTION.RETRY,
  ),
  [CAPABILITY_RUNTIME_ERROR_CODE.ROLLBACK_FAILED]: runtimeErrorProjection(
    PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE,
    true,
    PUBLIC_RECOVERY_ACTION.RETRY,
  ),
  [CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_NEEDS_RECOVERY]: runtimeErrorProjection(
    PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY,
    false,
    PUBLIC_RECOVERY_ACTION.REPAIR,
  ),
  [CAPABILITY_RUNTIME_ERROR_CODE.OPERATION_NOT_FOUND]: runtimeErrorProjection(
    PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE,
    true,
    PUBLIC_RECOVERY_ACTION.RETRY,
  ),
  [CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE]: runtimeErrorProjection(
    PUBLIC_ERROR_CODE.AUTHORITY_CORRUPT,
    false,
    PUBLIC_RECOVERY_ACTION.REPAIR_AUTHORITY,
  ),
  [CAPABILITY_RUNTIME_ERROR_CODE.FAULT]: runtimeErrorProjection(
    PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE,
    true,
    PUBLIC_RECOVERY_ACTION.RETRY,
  ),
} satisfies Readonly<Record<CapabilityRuntimeErrorCodeV1, CapabilityRuntimeErrorPublicProjection>>);

const UNSAFE_OPERATIONAL_MESSAGE =
  /\b(?:undefined|ENOENT|EACCES|EPERM|ENOTDIR|EISDIR)\b|\b(?:Assertion|Eval|Range|Reference|Syntax|Type|URI)?Error:/iu;

function safePublicMessage(code: PublicApiErrorV1["error"]["code"], message: string): string {
  const fallback = SAFE_FALLBACK_MESSAGE[code] ?? "Capability command failed.";
  const value = message.trim();
  if (
    !isBoundedWireText(value, { maxBytes: PUBLIC_API_ERROR_MESSAGE_MAX_BYTES }) ||
    UNSAFE_OPERATIONAL_MESSAGE.test(value) ||
    value.includes("/") ||
    value.includes("\\")
  )
    return fallback;
  return value;
}

function correlationId(code: string, message: string): string {
  return `vf-capability-cli-${digestHex(
    digestV1("VF-CAPABILITY-CLI-ERROR\0v1\0", { code, message }),
  )}`;
}

function apiError<Code extends PublicApiErrorV1["error"]["code"]>(
  code: Code,
  message: string,
  retryable = false,
  recovery_action: PublicApiErrorV1["error"]["recovery_action"] = null,
): Extract<PublicApiErrorV1["error"], { code: Code }> {
  const publicMessage = safePublicMessage(code, message);
  const details = code === PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY ? { operation_id: null } : null;
  return publicActionError({
    code,
    message: publicMessage,
    correlation_id: correlationId(code, publicMessage),
    retryable,
    recovery_action,
    details,
  } as Extract<PublicApiErrorV1["error"], { code: Code }>).error as Extract<
    PublicApiErrorV1["error"],
    { code: Code }
  >;
}

export function resultError(error: unknown): PublicApiErrorV1["error"] {
  if (error instanceof ActionConflictError) {
    const publicError = error.public_error.error;
    return apiError(
      publicError.code,
      publicError.message,
      publicError.retryable,
      publicError.recovery_action,
    );
  }
  if (error instanceof CapabilityCliUsageError)
    return apiError(PUBLIC_ERROR_CODE.INVALID_REQUEST, error.message);
  if (error instanceof ActionValidationError) {
    if (error.code === PUBLIC_ERROR_CODE.UNSUPPORTED_SCHEMA_VERSION)
      return apiError(PUBLIC_ERROR_CODE.UNSUPPORTED_SCHEMA_VERSION, error.message);
    if (error.code === PUBLIC_ERROR_CODE.TARGET_UNSUPPORTED)
      return apiError(PUBLIC_ERROR_CODE.TARGET_UNSUPPORTED, error.message);
    return apiError(PUBLIC_ERROR_CODE.INVALID_REQUEST, error.message);
  }
  if (error instanceof ActionAuthorityStaleError)
    return apiError(
      PUBLIC_ERROR_CODE.SOURCE_DIGEST_CHANGED,
      "Capability authority changed.",
      false,
      PUBLIC_RECOVERY_ACTION.REFRESH_PROPOSAL,
    );
  if (error instanceof CapabilityRuntimeError) {
    const runtimeCode = error.runtime_code;
    if (!isCapabilityRuntimeErrorCode(runtimeCode)) throw error;
    const message = CAPABILITY_RUNTIME_ERROR_PUBLIC_MESSAGE[runtimeCode];
    const projection = CAPABILITY_RUNTIME_ERROR_PUBLIC_PROJECTION[runtimeCode];
    return apiError(
      projection.publicCode,
      message,
      projection.retryable,
      projection.recoveryAction,
    );
  }
  if (error instanceof CapabilityNotActivatedError)
    return apiError(
      PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE,
      "Capability service is unavailable.",
      true,
      PUBLIC_RECOVERY_ACTION.RETRY,
    );
  throw error;
}
